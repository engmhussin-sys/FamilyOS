/**
 * SA-003 regression suite.
 *
 * The deprecated two-step pairing path (`POST /auth/devices/pairing/initiate`
 * -> `POST /auth/devices/pairing/confirm`) minted a fully `ACTIVE` device
 * plus a DEVICE token pair in a single unauthenticated call, bypassing the
 * whole PairingModule security path (registration token, risk evaluation,
 * trust evaluation, attestation capture, state machine, and the parent's
 * explicit `POST /pairing/activate`). It was marked `@deprecated` in a
 * comment only — the controller was still registered in `AuthModule`, so
 * the bypass was live in production builds. A comment is not a control.
 *
 * `DevicePairingController`, the auth-module `PairingService`, and
 * `PrismaDeviceRepository.createPairedChildDevice` (the only code path in
 * the repository that ever created a device with `status: 'ACTIVE'` in one
 * step) are now deleted. This suite fails if any of them comes back.
 *
 * Verified before removal: no caller exists in apps/admin-dashboard,
 * apps/parent-app or apps/child-app — all three already use the
 * PairingModule routes (`/pairing/invite`, `/pairing/accept`,
 * `/pairing/device/register`, `/pairing/verify`, `/pairing/activate`).
 */
import { existsSync } from 'node:fs';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { AuthModule } from '../../src/modules/auth/auth.module';

const SRC_ROOT = resolve(__dirname, '../../src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const sourceFiles = walk(SRC_ROOT).filter((f) => f.endsWith('.ts'));

describe('deprecated one-step device pairing is removed (SA-003)', () => {
  it('no longer ships the DevicePairingController source file', () => {
    expect(
      existsSync(
        resolve(SRC_ROOT, 'modules/auth/presentation/controllers/device-pairing.controller.ts'),
      ),
    ).toBe(false);
  });

  it('no longer ships the auth-module PairingService source file', () => {
    expect(
      existsSync(resolve(SRC_ROOT, 'modules/auth/application/services/pairing.service.ts')),
    ).toBe(false);
  });

  it('registers no controller under the auth/devices/pairing path', () => {
    const controllers: Array<new (...args: never[]) => unknown> =
      Reflect.getMetadata('controllers', AuthModule) ?? [];

    const paths = controllers.map((c) => Reflect.getMetadata('path', c));
    expect(paths).not.toContain('auth/devices/pairing');
    expect(paths).toEqual(['auth']);
  });

  it('has no remaining source reference to the deprecated route', () => {
    const offenders = sourceFiles.filter((f) =>
      readFileSync(f, 'utf8').includes('auth/devices/pairing'),
    );
    expect(offenders).toEqual([]);
  });

  /**
   * The security property, stated directly: nothing may create a CHILD
   * device already in ACTIVE status. The PairingModule creates child
   * devices as PENDING_PAIRING and only
   * `PairingOrchestratorService.activate` (parent-authenticated, after
   * risk + trust evaluation) moves them to ACTIVE.
   *
   * Parent push-token devices are deliberately out of scope: they carry
   * `ownerType: 'PARENT'`, are created from an already-authenticated
   * parent session, and mint no device token.
   */
  it('has no code path that creates a CHILD device directly in ACTIVE status', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const body = readFileSync(file, 'utf8');
      for (const block of body.split('device.create(').slice(1)) {
        const head = block.slice(0, 800);
        if (/ownerType:\s*'CHILD'/.test(head) && /status:\s*'ACTIVE'/.test(head)) {
          offenders.push(file);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no longer exposes createPairedChildDevice anywhere', () => {
    const offenders = sourceFiles.filter((f) =>
      readFileSync(f, 'utf8').includes('createPairedChildDevice'),
    );
    expect(offenders).toEqual([]);
  });
});
