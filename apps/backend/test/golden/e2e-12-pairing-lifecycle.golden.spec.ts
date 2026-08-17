/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ============================================================================
 * GOLDEN E2E-12 — A FAMILY ACTUALLY FINISHES PAIRING, AND CAN UNDO IT.
 * ============================================================================
 *
 * WHY THIS FILE EXISTS AND THE OTHER ELEVEN DO NOT COVER IT. `golden-world.ts`
 * SEEDS the child's device — it writes the `Device` row directly and mints its
 * token from the real `TokenService` — and says so at the seeding site: «the
 * real pairing flow needs a second physical actor to redeem a code, which no
 * single-process test can be». That shortcut is right for eleven scenarios
 * whose subject is what happens AFTER a device exists. It also means the
 * pairing lifecycle itself — the one path every real household walks exactly
 * once, before anything else in this product works — was never executed
 * end-to-end over HTTP by any test in this repository.
 *
 * So this scenario DELETES the seeded shortcut in its first line and pairs for
 * real: invite, redeem, register, verify, upload, confirm. Six requests, six
 * different credentials (a parent JWT, a one-time code, a registration token, a
 * device JWT), and the state machine's own audit trail read back from
 * PostgreSQL between them.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR ACTS
 *
 *   ACT I    THE HAPPY PATH, to `ACTIVATED` and `Device.status = ACTIVE`, seen
 *            through `GET /pairing/devices` — the route the parent app really
 *            polls (`AddChildScreen`), not an internal read.
 *
 *   ACT II   THE SECOND CONFIRM, and the authorization walls around the first.
 *            A device cannot confirm itself, another family cannot confirm this
 *            device, and a pairing code is one-time.
 *
 *   ACT III  THE CHILD'S PUSH TOKEN. The route that did not exist, and the
 *            three properties that make it safe: device-bound, idempotent, and
 *            invalidated on a permanent FCM failure.
 *
 *   ACT IV   REVOCATION FROM `ACTIVATED` — the window between activation and
 *            the first heartbeat, which is exactly when a parent who typed a
 *            code into the wrong phone wants to undo it — and the proof that a
 *            revoked device's still-unexpired access token reaches NOTHING.
 * ---------------------------------------------------------------------------
 *
 * NOTHING IS SUBSTITUTED IN THIS FILE. Real PostgreSQL, real Redis, real booted
 * app, real HTTP, real guards, real tokens. The clock is NOT frozen: this
 * scenario asserts no quiet-hours or business-day behaviour, and the pairing
 * flow's own two timeouts (a 10-minute invitation, a 5-minute registration
 * token) are exercised by their real Redis TTL semantics — one-time use, which
 * is a `getAndDelete`, not a wait.
 */
import {
  P,
  asBearer,
  asChild,
  asParent,
  bootGoldenWorld,
  describeGolden,
  type GoldenHousehold,
  type GoldenWorld,
} from './golden-world';
import request = require('supertest');

import { PairingOrchestratorService } from '../../src/modules/pairing/application/services/pairing-orchestrator.service';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';

jest.setTimeout(180_000);

/** The device's own capability snapshot and risk report, as the real agent sends them. */
const CLEAN_RISK_SIGNALS = {
  isEmulator: false,
  isRooted: false,
  hasTamperIndicators: false,
  isUnsupportedDevice: false,
  missingAttestation: false,
  mockLocationEnabled: false,
  developerModeEnabled: false,
  usbDebuggingEnabled: false,
  isOldAndroidVersion: false,
};

const CAPABILITY_SNAPSHOT = {
  manufacturer: 'Google',
  model: 'Pixel 7a',
  sdkInt: 34,
  agentVersion: '1.0.0',
};

describeGolden('GOLDEN E2E-12 — the pairing lifecycle, end to end', () => {
  let world: GoldenWorld;
  let home: GoldenHousehold;
  let neighbour: GoldenHousehold;

  /** Filled by ACT I and read by every act after it. */
  let deviceId = '';
  let deviceToken = '';

  beforeAll(async () => {
    world = await bootGoldenWorld('e2e-12-pairing');
    home = await world.register('pair-home');
    neighbour = await world.register('pair-neighbour');

    // THE SHORTCUT, REMOVED. Everything below pairs the real way; leaving the
    // seeded row in place would also trip the `unlimited_devices_per_child`
    // entitlement gate on the SECOND device for the same child, and this
    // scenario is about the FIRST one.
    await world.sys('remove the seeded shortcut device', () =>
      world.prisma.device.deleteMany({ where: { id: home.deviceId } }),
    );
  });

  afterAll(async () => {
    if (world) await world.close();
  });

  /** The child's pairing timeline, newest first, straight out of PostgreSQL. */
  async function pairingStates(childId: string): Promise<string[]> {
    const rows = await world.raw<Array<{ to_state: string }>>(
      `SELECT to_state FROM device_pairing_events WHERE child_id = $1 ORDER BY occurred_at DESC, id DESC`,
      childId,
    );
    return rows.map((r) => r.to_state);
  }

  /**
   * The permanent-failure invalidation, invoked the way the delivery pipeline
   * invokes it: inside the family's own tenant scope.
   */
  function clearChildToken(h: GoldenHousehold, pushToken: string): Promise<number> {
    const orchestrator = world.app.get(PairingOrchestratorService);
    return runWithTenant(
      { familyId: h.familyId, actorType: 'SYSTEM', actorId: 'push-delivery' },
      () => orchestrator.registerPermanentPushFailureForChildToken(pushToken),
    );
  }

  async function deviceRow(id: string): Promise<any> {
    const rows = await world.raw<any[]>(
      `SELECT id, status, child_id, family_id, push_token, owner_type FROM devices WHERE id = $1`,
      id,
    );
    return rows[0];
  }

  // ==========================================================================
  // ACT I — A REAL FAMILY FINISHES PAIRING
  // ==========================================================================
  describe('ACT I — invite, redeem, register, verify, confirm, ACTIVE', () => {
    let pairingCode = '';
    let registrationToken = '';

    it('the parent creates an invitation, and the timeline opens at INVITATION_SENT', async () => {
      const invited = await request(world.http)
        .post(`${P}/pairing/invite`)
        .set(asParent(home))
        .send({ childId: home.childId });

      expect(invited.status).toBe(200);
      // The code is SERVER-generated and short enough for a child to type.
      expect(invited.body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(invited.body.expiresInSeconds).toBe(600);
      pairingCode = invited.body.code;

      expect(await pairingStates(home.childId)).toEqual(['INVITATION_SENT']);
    });

    it('the child device redeems the code WITHOUT any token, and receives a registration token', async () => {
      // No Authorization header at all — this is the AUTH_BOOTSTRAP surface,
      // and the family is resolved FROM the code, server-side.
      const accepted = await request(world.http).post(`${P}/pairing/accept`).send({ code: pairingCode });

      expect(accepted.status).toBe(200);
      expect(typeof accepted.body.token).toBe('string');
      expect(accepted.body.expiresInSeconds).toBe(300);
      registrationToken = accepted.body.token;

      expect((await pairingStates(home.childId))[0]).toBe('AUTHENTICATING');
    });

    it('THE CODE IS ONE-TIME — a second device redeeming the same code is refused', async () => {
      const replayed = await request(world.http).post(`${P}/pairing/accept`).send({ code: pairingCode });

      // `getAndDelete` makes consumption and invalidation the same atomic
      // operation, so this is not a window that a race could widen.
      expect(replayed.status).toBe(401);
      expect(replayed.body.messageAr).toBeTruthy();
      // And no second AUTHENTICATING row was written for the replay.
      expect((await pairingStates(home.childId)).filter((s) => s === 'AUTHENTICATING')).toHaveLength(1);
    });

    it('the device registers with its public key and gets its OWN token family', async () => {
      const registered = await request(world.http)
        .post(`${P}/pairing/device/register`)
        .set(asBearer(registrationToken))
        .send({
          publicKey: 'GOLDEN-E2E-12-KEYSTORE-PUBLIC-KEY',
          platform: 'ANDROID',
          deviceModel: 'Pixel 7a',
          osVersion: '14',
          appVersion: '1.0.0',
          pairingProtocolVersion: '1',
        });

      expect(registered.status).toBe(201);
      deviceId = registered.body.deviceId;
      deviceToken = registered.body.tokens.accessToken;
      expect(deviceId).toBeTruthy();
      expect(deviceToken).toBeTruthy();

      // The row exists and is NOT yet usable: PENDING_PAIRING until a parent says so.
      expect((await deviceRow(deviceId)).status).toBe('PENDING_PAIRING');
      expect((await pairingStates(home.childId))[0]).toBe('DEVICE_REGISTERED');
    });

    it('THE REGISTRATION TOKEN IS ONE-TIME TOO — a second device cannot register on it', async () => {
      const replayed = await request(world.http)
        .post(`${P}/pairing/device/register`)
        .set(asBearer(registrationToken))
        .send({ publicKey: 'SECOND-DEVICE-KEY', platform: 'ANDROID' });

      expect(replayed.status).toBe(401);
      expect(replayed.body.messageAr).toBeTruthy();
    });

    it('the device verifies and uploads its capabilities — and STOPS at CAPABILITIES_UPLOADED', async () => {
      const verified = await request(world.http)
        .post(`${P}/pairing/verify`)
        .set(asBearer(deviceToken))
        .send({
          attestationChain: 'golden-attestation-chain',
          pairingCapabilitySnapshot: CAPABILITY_SNAPSHOT,
          riskSignals: CLEAN_RISK_SIGNALS,
        });

      expect(verified.status).toBe(200);
      expect(verified.body.trustLevel).toBe('L3_ATTESTED');
      expect(verified.body.riskAssessment.overallLevel).toBe('LOW');

      // THE STALL THIS SCENARIO EXISTS FOR. Everything the DEVICE can do is
      // now done, and the device is still not usable: the next transition in
      // the table is `PARENT_CONFIRMED(USER)`, and no device may fire it.
      expect((await pairingStates(home.childId))[0]).toBe('CAPABILITIES_UPLOADED');
      expect((await deviceRow(deviceId)).status).toBe('PENDING_PAIRING');
    });

    it('the parent sees the device WAITING in GET /pairing/devices — the route the parent app polls', async () => {
      const listed = await request(world.http).get(`${P}/pairing/devices`).set(asParent(home));

      expect(listed.status).toBe(200);
      const mine = listed.body.find((d: any) => d.id === deviceId);
      expect(mine).toBeDefined();
      expect(mine.status).toBe('PENDING_PAIRING');
      expect(mine.childFirstName).toBe(home.childName);
      expect(mine.trustLevel).toBe('L3_ATTESTED');
    });

    it('THE PARENT CONFIRMS — and one call carries the device all the way to ACTIVATED', async () => {
      const activated = await request(world.http)
        .post(`${P}/pairing/activate`)
        .set(asParent(home))
        .send({ deviceId });

      expect(activated.status).toBe(200);
      expect(activated.body.status).toBe('ACTIVATED');

      // ALL THREE transitions the table specifies, in order, from ONE request:
      // PARENT_CONFIRMED(USER) -> POLICY_ASSIGNED(SYSTEM) -> DEVICE_ACTIVATED(SYSTEM).
      // The two SYSTEM steps have no client actor, so an endpoint for them
      // would be an activation that stalls whenever that client crashes.
      const states = await pairingStates(home.childId);
      expect(states.slice(0, 3)).toEqual(['ACTIVATED', 'POLICY_ASSIGNED', 'PARENT_CONFIRMED']);
    });

    it('and the DEVICE ROW agrees with the pairing state — ACTIVE, not a state column nobody reads', async () => {
      expect((await deviceRow(deviceId)).status).toBe('ACTIVE');

      const listed = await request(world.http).get(`${P}/pairing/devices`).set(asParent(home));
      expect(listed.body.find((d: any) => d.id === deviceId).status).toBe('ACTIVE');
    });

    it('the paired child can now actually USE the product — the device token reaches a child surface', async () => {
      // The point of the whole flow: before confirmation this answers 403
      // (`getChildAndFamilyIdForDevice` asserts ACTIVE); after it, the child app works.
      const today = await request(world.http).get(`${P}/self/achievements/today`).set(asBearer(deviceToken));
      expect(today.status).toBe(200);
    });
  });

  // ==========================================================================
  // ACT II — THE SECOND CONFIRM, AND THE WALLS AROUND THE FIRST
  // ==========================================================================
  describe('ACT II — idempotency and authorization', () => {
    it('A SECOND CONFIRM IS A 409, and that is the contract — not a silent second success', async () => {
      const again = await request(world.http)
        .post(`${P}/pairing/activate`)
        .set(asParent(home))
        .send({ deviceId });

      // The transition table already answers this: PARENT_CONFIRMED is legal
      // only from CAPABILITIES_UPLOADED. Surfacing that refusal is the
      // deliberate choice over swallowing it into a 200 — see the reasoning on
      // `PairingOrchestratorService.activate`. The client rule is one line:
      // "409 on activate means already active", and `GET /pairing/devices`
      // agrees.
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('CONFLICT');
      // B3: no enum, no Prisma constraint name, no status code in what a parent reads.
      expect(again.body.messageAr).toBe('هذا الإجراء تمّ بالفعل، أو لم يعد متاحًا الآن.');
      expect(again.body.messageAr).not.toMatch(/PARENT_CONFIRMED|ACTIVATED|409/);

      // AND NOTHING MOVED. No second PARENT_CONFIRMED row, no duplicated activation.
      const states = await pairingStates(home.childId);
      expect(states.filter((s) => s === 'PARENT_CONFIRMED')).toHaveLength(1);
      expect(states[0]).toBe('ACTIVATED');
      expect((await deviceRow(deviceId)).status).toBe('ACTIVE');
    });

    it('A DEVICE CANNOT CONFIRM ITSELF — the child token is refused by the strategy, not by a role', async () => {
      const selfConfirmed = await request(world.http)
        .post(`${P}/pairing/activate`)
        .set(asBearer(deviceToken))
        .send({ deviceId });

      // `JwtAuthGuard` is the 'jwt' strategy; a device token is minted for
      // 'device-jwt'. The two token families are not interchangeable, so this
      // is 401 at the transport, before any handler or role check runs.
      expect(selfConfirmed.status).toBe(401);
    });

    it('ANOTHER FAMILY CANNOT CONFIRM THIS DEVICE — 404, which does not even admit it exists', async () => {
      const stolen = await request(world.http)
        .post(`${P}/pairing/activate`)
        .set(asParent(neighbour))
        .send({ deviceId });

      expect(stolen.status).toBe(404);
      expect(stolen.body.messageAr).toBeTruthy();
    });

    it('ANOTHER FAMILY CANNOT REVOKE, REJECT, OR EVEN READ THIS DEVICE', async () => {
      const revoked = await request(world.http)
        .post(`${P}/pairing/revoke`)
        .set(asParent(neighbour))
        .send({ deviceId, reason: 'not mine' });
      const rejected = await request(world.http)
        .post(`${P}/pairing/reject`)
        .set(asParent(neighbour))
        .send({ deviceId });
      const status = await request(world.http)
        .get(`${P}/pairing/device/${deviceId}/status`)
        .set(asParent(neighbour));
      const timeline = await request(world.http)
        .get(`${P}/pairing/device/${deviceId}/timeline`)
        .set(asParent(neighbour));

      expect([revoked.status, rejected.status, status.status, timeline.status]).toEqual([404, 404, 404, 404]);

      // And the device is untouched by all four attempts.
      expect((await deviceRow(deviceId)).status).toBe('ACTIVE');
    });

    it('the neighbour family CANNOT invite for another family’s child either', async () => {
      const invited = await request(world.http)
        .post(`${P}/pairing/invite`)
        .set(asParent(neighbour))
        .send({ childId: home.childId });

      expect([403, 404]).toContain(invited.status);
    });

    it('a device token cannot reach the PARENT push-token route, and a parent token cannot reach the CHILD one', async () => {
      const deviceOnParentRoute = await request(world.http)
        .post(`${P}/pairing/parent-device/push-token`)
        .set(asBearer(deviceToken))
        .send({ platform: 'ANDROID', pushToken: 'device-pretending-to-be-a-parent' });
      const parentOnDeviceRoute = await request(world.http)
        .post(`${P}/pairing/device/push-token`)
        .set(asParent(home))
        .send({ pushToken: 'parent-pretending-to-be-a-device' });

      expect(deviceOnParentRoute.status).toBe(401);
      expect(parentOnDeviceRoute.status).toBe(401);
    });
  });

  // ==========================================================================
  // ACT III — THE CHILD'S PUSH TOKEN
  // ==========================================================================
  describe('ACT III — the child device registers an FCM token', () => {
    const CHILD_TOKEN_V1 = 'fcm-child-token-golden-e2e-12-v1';
    const CHILD_TOKEN_V2 = 'fcm-child-token-golden-e2e-12-v2-rotated';

    it('registers against the device in the VERIFIED TOKEN — nothing identifying is in the body', async () => {
      const registered = await request(world.http)
        .post(`${P}/pairing/device/push-token`)
        .set(asBearer(deviceToken))
        .send({ pushToken: CHILD_TOKEN_V1 });

      expect(registered.status).toBe(204);
      expect((await deviceRow(deviceId)).push_token).toBe(CHILD_TOKEN_V1);
    });

    it('IS IDEMPOTENT — re-registering the same token is not an error and creates no second row', async () => {
      const before = await world.raw<Array<{ n: bigint }>>(
        `SELECT COUNT(*)::bigint AS n FROM devices WHERE family_id = $1`,
        home.familyId,
      );

      const again = await request(world.http)
        .post(`${P}/pairing/device/push-token`)
        .set(asBearer(deviceToken))
        .send({ pushToken: CHILD_TOKEN_V1 });
      expect(again.status).toBe(204);

      const after = await world.raw<Array<{ n: bigint }>>(
        `SELECT COUNT(*)::bigint AS n FROM devices WHERE family_id = $1`,
        home.familyId,
      );
      expect(String(after[0].n)).toBe(String(before[0].n));
      expect((await deviceRow(deviceId)).push_token).toBe(CHILD_TOKEN_V1);
    });

    it('ROTATION replaces the token in place, which is what onTokenRefresh needs', async () => {
      const rotated = await request(world.http)
        .post(`${P}/pairing/device/push-token`)
        .set(asBearer(deviceToken))
        .send({ pushToken: CHILD_TOKEN_V2 });

      expect(rotated.status).toBe(204);
      expect((await deviceRow(deviceId)).push_token).toBe(CHILD_TOKEN_V2);
    });

    it('a body longer than the column is a 400, never a silent truncation', async () => {
      const tooLong = await request(world.http)
        .post(`${P}/pairing/device/push-token`)
        .set(asBearer(deviceToken))
        .send({ pushToken: 'x'.repeat(501) });

      expect(tooLong.status).toBe(400);
      expect(tooLong.body.code).toBe('VALIDATION_FAILED');
      // The stored token is untouched by the rejected request.
      expect((await deviceRow(deviceId)).push_token).toBe(CHILD_TOKEN_V2);
    });

    it('FAMILY ISOLATION — the neighbour’s device token can only ever write the neighbour’s own row', async () => {
      // There is no deviceId, childId or familyId in this request to point
      // anywhere else: the identity is `device.sub` out of a signed token. The
      // strongest available proof is therefore that the neighbour writing its
      // own token leaves this household's row exactly as it was.
      const neighbourWrote = await request(world.http)
        .post(`${P}/pairing/device/push-token`)
        .set(asChild(neighbour))
        .send({ pushToken: 'fcm-neighbour-token' });

      expect(neighbourWrote.status).toBe(204);
      expect((await deviceRow(neighbour.deviceId)).push_token).toBe('fcm-neighbour-token');
      expect((await deviceRow(deviceId)).push_token).toBe(CHILD_TOKEN_V2);
      expect((await deviceRow(neighbour.deviceId)).family_id).toBe(neighbour.familyId);
    });

    it('A PERMANENT FCM FAILURE NULLS THE TOKEN — and never deletes the device', async () => {
      // FCM_CONTRACT.md §7's required behaviour, for the CHILD path. The
      // classification itself stays where it already lives
      // (`PERMANENT_FCM_CODES`); this is only the persistence half.
      //
      // CALLED UNDER A TENANT, because that is how the delivery side calls it:
      // a push is always fired inside a family's own scope — either the
      // request's (`createForFamilyOwner`) or the sweep's own `runWithTenant`
      // per family (`QuietHoursReleaseService`). The tenant extension therefore
      // narrows the clear to that family, and a token string alone cannot reach
      // across households even if two of them somehow held the same value.
      const cleared = await clearChildToken(home, CHILD_TOKEN_V2);

      expect(cleared).toBe(1);
      const row = await deviceRow(deviceId);
      expect(row.push_token).toBeNull();
      // THE DEVICE SURVIVES. Only its token died; the next registration
      // restores it, which the assertion below performs.
      expect(row.status).toBe('ACTIVE');
      expect(row.child_id).toBe(home.childId);

      const reRegistered = await request(world.http)
        .post(`${P}/pairing/device/push-token`)
        .set(asBearer(deviceToken))
        .send({ pushToken: CHILD_TOKEN_V1 });
      expect(reRegistered.status).toBe(204);
      expect((await deviceRow(deviceId)).push_token).toBe(CHILD_TOKEN_V1);
    });

    it('invalidation is CHILD-SCOPED — a parent-owned device holding the same token is left alone', async () => {
      // The parent half of FCM_CONTRACT.md item 13 is owned outside this
      // module and still open. This assertion pins the boundary so that
      // "child only" is a measured property rather than a claim in a comment.
      const shared = 'fcm-token-held-by-both-owner-types';
      const parentRegistered = await request(world.http)
        .post(`${P}/pairing/parent-device/push-token`)
        .set(asParent(home))
        .send({ platform: 'ANDROID', pushToken: shared });
      expect(parentRegistered.status).toBe(204);

      await request(world.http)
        .post(`${P}/pairing/device/push-token`)
        .set(asBearer(deviceToken))
        .send({ pushToken: shared });

      expect(await clearChildToken(home, shared)).toBe(1);

      const parentDevices = await world.raw<any[]>(
        `SELECT push_token FROM devices WHERE family_id = $1 AND owner_type = 'PARENT'`,
        home.familyId,
      );
      expect(parentDevices.map((d) => d.push_token)).toContain(shared);
      expect((await deviceRow(deviceId)).push_token).toBeNull();

      // Restore a token so ACT IV starts from a realistic device.
      await request(world.http)
        .post(`${P}/pairing/device/push-token`)
        .set(asBearer(deviceToken))
        .send({ pushToken: CHILD_TOKEN_V1 });
    });
  });

  // ==========================================================================
  // ACT IV — UNDOING A MIS-PAIRING
  // ==========================================================================
  describe('ACT IV — revoking a device that activated but has not yet phoned home', () => {
    it('a CHILD token cannot revoke, and neither can the neighbour', async () => {
      const byDevice = await request(world.http)
        .post(`${P}/pairing/revoke`)
        .set(asBearer(deviceToken))
        .send({ deviceId });
      const byNeighbour = await request(world.http)
        .post(`${P}/pairing/revoke`)
        .set(asParent(neighbour))
        .send({ deviceId });

      expect(byDevice.status).toBe(401);
      expect(byNeighbour.status).toBe(404);
      expect((await deviceRow(deviceId)).status).toBe('ACTIVE');
    });

    it('THE PARENT REVOKES FROM ACTIVATED — the transition that used to be a 409', async () => {
      // The device has never sent a heartbeat, so its pairing state is
      // ACTIVATED and not HEALTHY. Before `ACTIVATED` was added to
      // DEVICE_REVOKED's allowed-from states, this answered 409 and the only
      // way to unlink a mis-paired phone was to wait for it to phone home.
      expect((await pairingStates(home.childId))[0]).toBe('ACTIVATED');

      const revoked = await request(world.http)
        .post(`${P}/pairing/revoke`)
        .set(asParent(home))
        .send({ deviceId, reason: 'code entered on the wrong phone' });

      expect(revoked.status).toBe(204);
      expect((await pairingStates(home.childId))[0]).toBe('REVOKED');
      expect((await deviceRow(deviceId)).status).toBe('REVOKED');
    });

    it('the revocation is AUDITED with its actor and its reason', async () => {
      const rows = await world.raw<any[]>(
        `SELECT event_type, from_state, to_state, actor_type, actor_id, metadata
           FROM device_pairing_events
          WHERE child_id = $1 AND event_type = 'DEVICE_REVOKED'`,
        home.childId,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].from_state).toBe('ACTIVATED');
      expect(rows[0].to_state).toBe('REVOKED');
      expect(rows[0].actor_type).toBe('USER');
      expect(rows[0].actor_id).toBe(home.ownerUserId);
      expect(rows[0].metadata.reason).toBe('code entered on the wrong phone');
    });

    it('the household is TOLD — through this module’s existing notification path, once', async () => {
      const rows = await world.raw<any[]>(
        `SELECT type, priority, data, source_event_id FROM notifications
          WHERE family_id = $1 AND data->>'alertType' = 'DEVICE_REVOKED'`,
        home.familyId,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe('RUNTIME_ALERT');
      expect(rows[0].priority).toBe('HIGH');
      expect(rows[0].data.deviceId).toBe(deviceId);
      // `forEntity`, so the pair (child, device) IS the identity of the fact
      // and the unique index makes a duplicate structurally impossible.
      expect(rows[0].source_event_id).toBe(`runtime:${home.childId}:${deviceId}:DEVICE_REVOKED`);
    });

    it('THE REVOKED DEVICE REACHES NOTHING — the same access token, now worth nothing', async () => {
      // The access token is still cryptographically valid and unexpired:
      // `revoke` kills the REFRESH family, and `DeviceJwtStrategy` reads only
      // the JWT's own claims. Every route below therefore has to refuse it on
      // the LIVE row, which is the entire point of the state column.
      const policy = await request(world.http).get(`${P}/pairing/device/policy`).set(asBearer(deviceToken));
      const heartbeat = await request(world.http)
        .post(`${P}/pairing/device/heartbeat`)
        .set(asBearer(deviceToken))
        .send({ batteryPercent: 80, accessibilityServiceEnabled: true });
      const capabilities = await request(world.http)
        .post(`${P}/pairing/device/capabilities`)
        .set(asBearer(deviceToken))
        .send({
          manufacturer: 'Google',
          model: 'Pixel 7a',
          sdkInt: 34,
          usageAccessGranted: true,
          accessibilityEnabled: true,
          overlayGranted: true,
          batteryOptimizationExempted: true,
          notificationsGranted: true,
          profileHash: 'post-revoke',
        });
      const pushToken = await request(world.http)
        .post(`${P}/pairing/device/push-token`)
        .set(asBearer(deviceToken))
        .send({ pushToken: 'revoked-device-still-wants-notifications' });
      const achievements = await request(world.http)
        .get(`${P}/self/achievements/today`)
        .set(asBearer(deviceToken));
      const coaching = await request(world.http).get(`${P}/life-intelligence/self/coaching`).set(asBearer(deviceToken));
      const inbox = await request(world.http)
        .get(`${P}/life-intelligence/communication/child/${home.childId}`)
        .set(asBearer(deviceToken));
      const verify = await request(world.http)
        .post(`${P}/pairing/verify`)
        .set(asBearer(deviceToken))
        .send({ pairingCapabilitySnapshot: CAPABILITY_SNAPSHOT, riskSignals: CLEAN_RISK_SIGNALS });

      const answered = {
        policy: policy.status,
        heartbeat: heartbeat.status,
        capabilities: capabilities.status,
        pushToken: pushToken.status,
        achievements: achievements.status,
        coaching: coaching.status,
        inbox: inbox.status,
        verify: verify.status,
      };
      // NOT ONE 200 or 204. Written as a whole object so a regression names
      // exactly which surface reopened.
      expect(answered).toEqual({
        policy: 403,
        heartbeat: 403,
        capabilities: 403,
        pushToken: 403,
        achievements: 403,
        coaching: 403,
        inbox: 403,
        verify: 403,
      });

      // And what a revoked child device is told is a sentence, not an enum.
      expect(policy.body.code).toBe('DEVICE_NOT_ACTIVE');
      expect(policy.body.messageAr).toBe('تم فصل هذا الجهاز عن حساب العائلة. اطلب من ولي الأمر ربطه من جديد.');
      expect(policy.body.messageAr).not.toMatch(/REVOKED|403|Device/);
    });

    it('the revoked device wrote NOTHING on the way out — no telemetry, no lastSeen, no new token', async () => {
      const row = await deviceRow(deviceId);
      // The push token from ACT III is still there and the revoked device's
      // own attempt to replace it above did not land.
      expect(row.push_token).toBe('fcm-child-token-golden-e2e-12-v1');
      expect(row.status).toBe('REVOKED');

      const telemetry = await world.raw<any[]>(
        `SELECT last_telemetry FROM devices WHERE id = $1`,
        deviceId,
      );
      expect(telemetry[0].last_telemetry).toBeNull();
    });

    it('the parent still sees the device in the list, REVOKED — an unlink is not a deletion', async () => {
      const listed = await request(world.http).get(`${P}/pairing/devices`).set(asParent(home));
      const mine = listed.body.find((d: any) => d.id === deviceId);

      expect(mine).toBeDefined();
      expect(mine.status).toBe('REVOKED');
    });

    /**
     * ========================================================================
     * THE KNOWN LIMIT PINNED HERE IS NOW CLOSED, AND THIS IS ITS REPLACEMENT.
     * ========================================================================
     *
     * Until the `PAIRING_INVITED` edge was widened, this test asserted a 409:
     * `allowedFromStates: [null]` meant «valid only as the FIRST event for this
     * childId», and pairing state is child-scoped (Decision-065/066), so any
     * terminal state on a child's timeline refused `POST /pairing/invite` for
     * that child *forever*. Revocation was a one-way door — a parent could undo
     * a mis-pairing (the tests above) and then never pair the right phone.
     *
     * The rule now also admits `REVOKED`, `REMOVED`, `REJECTED` and `EXPIRED`:
     * exactly the states for which "this child has no working device" is true.
     * The live states were deliberately left out — see the comment on that rule
     * for why multi-device-per-child is not something to acquire by accident.
     */
    it('a revoked child CAN be paired again — revocation is an undo, not a dead end', async () => {
      const invited = await request(world.http)
        .post(`${P}/pairing/invite`)
        .set(asParent(home))
        .send({ childId: home.childId });

      expect(invited.status).toBe(200);
      expect((await pairingStates(home.childId))[0]).toBe('INVITATION_SENT');
    });

    it('re-inviting the CHILD does not resurrect the revoked DEVICE', async () => {
      // The whole point of the edge above is that it restores the child's
      // route to a device — not that it quietly un-revokes the one the parent
      // just disconnected. A new invitation is a new device's beginning.
      const row = await deviceRow(deviceId);
      expect(row.status).toBe('REVOKED');

      const policy = await request(world.http)
        .get(`${P}/pairing/device/policy`)
        .set(asBearer(deviceToken));
      expect(policy.status).toBe(403);
      expect(policy.body.code).toBe('DEVICE_NOT_ACTIVE');
    });
  });
});
