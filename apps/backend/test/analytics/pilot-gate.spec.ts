/**
 * G16 — THE CONTROLLED-PILOT GATE (Saudi Arabia + Egypt), AS A SPECIFICATION.
 *
 * Two layers, both without a database:
 *
 *   1. The pure domain functions in `analytics/domain/pilot.ts` — country
 *      parsing and the allow/refuse mapping. A gate's decision table is exactly
 *      the thing that should be readable as a table.
 *   2. `PilotEnrollmentService` against doubles, because the interesting
 *      behaviour is not "does it query" but "what does it decide when the
 *      configuration is absent, corrupt, or the database is down" — and the
 *      answer to that last one (fail OPEN) is a deliberate choice that deserves
 *      a test naming it.
 *
 * The constraints that make the allow-list an allow-list are tested against real
 * PostgreSQL in test/database/pilot-cohorts.integration.spec.ts; the registration
 * boundary is tested in test/auth/auth.service.spec.ts.
 */
import { PilotEnrollmentService } from '../../src/modules/analytics/application/pilot-enrollment.service';
import {
  PILOT_SETTING_KEYS,
  isCountryInPilot,
  isPilotGateAllowed,
  normalisePilotCountry,
  normalisePilotEmail,
  parsePilotCountries,
  type PilotGateDecision,
} from '../../src/modules/analytics/domain/pilot';
import {
  GROWTH_SETTING_SCHEMAS,
  defaultGrowthSetting,
  growthSettingSchema,
  parseGrowthSetting,
} from '../../src/modules/analytics/domain/growth-settings';

describe('G16 — pilot settings live in the existing growth-settings vocabulary', () => {
  it('all three pilot keys are declared, so none of them is a magic string', () => {
    for (const key of Object.values(PILOT_SETTING_KEYS)) {
      expect(growthSettingSchema(key)).toBeDefined();
    }
  });

  it('THE SAFETY PROPERTY: pilot.enabled defaults to false, so nothing launches by deploying this', () => {
    expect(defaultGrowthSetting(PILOT_SETTING_KEYS.enabled)).toBe(false);
  });

  it('the pilot markets default to Saudi Arabia and Egypt', () => {
    const countries = parsePilotCountries(
      String(defaultGrowthSetting(PILOT_SETTING_KEYS.countries)),
    );
    expect([...countries].sort()).toEqual(['EG', 'SA']);
  });

  it('a cohort id default exists, so an operator enabling the pilot cannot land in an unnamed cohort', () => {
    expect(String(defaultGrowthSetting(PILOT_SETTING_KEYS.cohortId)).length).toBeGreaterThan(0);
  });

  it('pilot.enabled is validated as a boolean — a typo cannot become a silent "on"', () => {
    expect(parseGrowthSetting(PILOT_SETTING_KEYS.enabled, 'true')).toBe(true);
    expect(parseGrowthSetting(PILOT_SETTING_KEYS.enabled, 'false')).toBe(false);
    expect(() => parseGrowthSetting(PILOT_SETTING_KEYS.enabled, 'yes')).toThrow();
    expect(() => parseGrowthSetting(PILOT_SETTING_KEYS.enabled, 'TRUE')).toThrow();
    expect(() => parseGrowthSetting(PILOT_SETTING_KEYS.enabled, '1')).toThrow();
  });

  it('every pilot key carries an Arabic description, like every other growth setting', () => {
    const pilotSchemas = GROWTH_SETTING_SCHEMAS.filter((s) => s.key.startsWith('pilot.'));
    expect(pilotSchemas).toHaveLength(3);
    for (const schema of pilotSchemas) {
      expect(schema.descriptionAr.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('G16 — parsePilotCountries tolerates admin-edited text', () => {
  it('parses the ordinary case', () => {
    expect([...parsePilotCountries('SA,EG')].sort()).toEqual(['EG', 'SA']);
  });

  it('normalises whitespace, case and a trailing comma rather than treating them as an outage', () => {
    expect([...parsePilotCountries(' sa , eg , ')].sort()).toEqual(['EG', 'SA']);
  });

  it('DISCARDS anything that is not an alpha-2 code instead of guessing', () => {
    expect([...parsePilotCountries('SA,SAUDI,E,123,EG')].sort()).toEqual(['EG', 'SA']);
  });

  it('an empty list is empty, not "everywhere"', () => {
    expect(parsePilotCountries('').size).toBe(0);
    expect(parsePilotCountries('   ').size).toBe(0);
  });
});

describe('G16 — isCountryInPilot', () => {
  const pilot = parsePilotCountries('SA,EG');

  it('matches a pilot country, case-insensitively', () => {
    expect(isCountryInPilot('SA', pilot)).toBe(true);
    expect(isCountryInPilot('eg', pilot)).toBe(true);
    expect(isCountryInPilot(' sa ', pilot)).toBe(true);
  });

  it('does not match a country outside the pilot', () => {
    expect(isCountryInPilot('AE', pilot)).toBe(false);
    expect(isCountryInPilot('GB', pilot)).toBe(false);
  });

  it('A MISSING country is NOT in the pilot — the decision, stated as a test', () => {
    // countryCode arrives from RegistrationAttributionDto, where every field is
    // optional and untrusted. Treating "absent" as "in the pilot" would refuse
    // every household whose app failed to report a country, including ones in
    // markets the pilot is not about. That is breaking registration, not
    // protecting a pilot.
    expect(isCountryInPilot(null, pilot)).toBe(false);
    expect(isCountryInPilot(undefined, pilot)).toBe(false);
    expect(isCountryInPilot('', pilot)).toBe(false);
  });
});

describe('G16 — the decision table', () => {
  const cases: ReadonlyArray<[PilotGateDecision, boolean]> = [
    ['PILOT_DISABLED', true],
    ['COUNTRY_NOT_IN_PILOT', true],
    ['INVITED', true],
    ['NOT_INVITED', false],
    ['INVITE_ALREADY_REDEEMED', false],
  ];

  it.each(cases)('%s -> allowed=%s', (decision, allowed) => {
    expect(isPilotGateAllowed(decision)).toBe(allowed);
  });
});

describe('G16 — normalisation matches what the table CHECKs', () => {
  it('emails are lower-cased and trimmed', () => {
    expect(normalisePilotEmail('  Invited@Example.COM ')).toBe('invited@example.com');
  });

  it('countries are upper-cased and trimmed', () => {
    expect(normalisePilotCountry(' sa ')).toBe('SA');
  });
});

describe('G16 — PilotEnrollmentService', () => {
  const invite = { findUnique: jest.fn(), updateMany: jest.fn(), upsert: jest.fn(), findFirst: jest.fn() };
  const prismaMock = { pilotInvite: invite } as never;

  const settings = { bool: jest.fn(), text: jest.fn() };
  const settingsMock = settings as never;

  let service: PilotEnrollmentService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PilotEnrollmentService(prismaMock, settingsMock);
    // The default posture everywhere: enabled, SA+EG, one named cohort.
    settings.bool.mockResolvedValue(true);
    settings.text.mockImplementation(async (key: string) =>
      key === PILOT_SETTING_KEYS.countries ? 'SA,EG' : 'pilot-2026-q1',
    );
  });

  it('THE DEFAULT: with pilot.enabled false, nothing is looked up and everyone is allowed', async () => {
    settings.bool.mockResolvedValue(false);

    const result = await service.evaluate('anyone@example.com', 'SA');

    expect(result).toEqual({
      decision: 'PILOT_DISABLED',
      allowed: true,
      cohortId: null,
      inviteId: null,
      // F1. Null for every decision except INVITED — a gate that is off has no
      // operator record to hand forward, so registration falls back to whatever
      // the client claimed (and to NULL when it claimed nothing).
      inviteCountryCode: null,
    });
    // Not merely allowed — the invite table is not even consulted, so an
    // empty allow-list cannot accidentally gate a non-pilot deployment.
    expect(invite.findUnique).not.toHaveBeenCalled();
  });

  it('a country outside the pilot is unaffected even while the pilot is running', async () => {
    const result = await service.evaluate('someone@example.com', 'AE');

    expect(result.decision).toBe('COUNTRY_NOT_IN_PILOT');
    expect(result.allowed).toBe(true);
    expect(invite.findUnique).not.toHaveBeenCalled();
  });

  it('AN UNINVITED FAMILY IN A PILOT COUNTRY CANNOT JOIN', async () => {
    invite.findUnique.mockResolvedValue(null);

    const result = await service.evaluate('uninvited@example.com', 'SA');

    expect(result.decision).toBe('NOT_INVITED');
    expect(result.allowed).toBe(false);
    expect(result.inviteId).toBeNull();
  });

  it('an invited family is allowed, and carries its cohort and invitation forward', async () => {
    invite.findUnique.mockResolvedValue({ id: 'invite-1', redeemedAt: null, countryCode: 'SA' });

    const result = await service.evaluate('Invited@Example.com', 'sa');

    expect(result.decision).toBe('INVITED');
    expect(result.allowed).toBe(true);
    expect(result.cohortId).toBe('pilot-2026-q1');
    expect(result.inviteId).toBe('invite-1');
    // F1. The OPERATOR's country travels out of the gate, because
    // `AuthService.register` prefers it over anything the client claimed — an
    // operator who decided which market an invited household belongs to
    // outranks an app guessing from a SIM.
    expect(result.inviteCountryCode).toBe('SA');
    // Looked up lower-cased, matching the table's own CHECK.
    expect(invite.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email_cohortId: { email: 'invited@example.com', cohortId: 'pilot-2026-q1' } },
      }),
    );
  });

  it('an invitation already used by another household is refused', async () => {
    invite.findUnique.mockResolvedValue({ id: 'invite-1', redeemedAt: new Date() });

    const result = await service.evaluate('invited@example.com', 'SA');

    expect(result.decision).toBe('INVITE_ALREADY_REDEEMED');
    expect(result.allowed).toBe(false);
  });

  it('an invitation in ANOTHER cohort does not admit this registration', async () => {
    // The lookup is keyed on (email, cohortId), so a row from last quarter's
    // wave simply is not found for the current one.
    invite.findUnique.mockResolvedValue(null);
    settings.text.mockImplementation(async (key: string) =>
      key === PILOT_SETTING_KEYS.countries ? 'SA,EG' : 'pilot-2026-q2',
    );

    const result = await service.evaluate('lastwave@example.com', 'SA');

    expect(result.decision).toBe('NOT_INVITED');
    expect(invite.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email_cohortId: { email: 'lastwave@example.com', cohortId: 'pilot-2026-q2' } },
      }),
    );
  });

  it('FAILS OPEN when the settings read throws — a database fault must not stop registration', async () => {
    settings.bool.mockRejectedValue(new Error('connection terminated'));

    const result = await service.evaluate('someone@example.com', 'SA');

    // Failing closed would make the product unbuyable for everyone, including
    // every household outside the pilot markets, because of a feature that is
    // off by default. Letting an uninvited family in is recoverable; that is
    // not.
    expect(result.decision).toBe('PILOT_DISABLED');
    expect(result.allowed).toBe(true);
  });

  it('FAILS OPEN when the invite lookup throws', async () => {
    invite.findUnique.mockRejectedValue(new Error('connection terminated'));

    const result = await service.evaluate('someone@example.com', 'SA');

    expect(result.allowed).toBe(true);
  });

  describe('redeem — where the cohort and country are recorded', () => {
    it('binds the invitation to the family, conditionally on it being unredeemed', async () => {
      invite.updateMany.mockResolvedValue({ count: 1 });

      await expect(service.redeem('invite-1', 'family-1')).resolves.toBe(true);

      const call = invite.updateMany.mock.calls[0][0];
      // `redeemedAt: null` IS THE RACE GUARD. Two registrations racing on one
      // invitation both pass evaluate; only one can pass this update.
      expect(call.where).toEqual({ id: 'invite-1', redeemedAt: null });
      expect(call.data.redeemedByFamilyId).toBe('family-1');
      expect(call.data.redeemedAt).toBeInstanceOf(Date);
    });

    it('losing the race returns false rather than throwing — the account stands', async () => {
      invite.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.redeem('invite-1', 'family-2')).resolves.toBe(false);
    });

    it('never throws, even when the update itself fails', async () => {
      invite.updateMany.mockRejectedValue(new Error('connection terminated'));

      await expect(service.redeem('invite-1', 'family-1')).resolves.toBe(false);
    });
  });

  describe('invite — the operator half', () => {
    it('stores the email lower-cased and the country upper-cased, as the CHECKs require', async () => {
      invite.upsert.mockResolvedValue({ id: 'invite-new' });

      await service.invite({
        email: ' Family@Example.COM ',
        cohortId: 'pilot-2026-q1',
        countryCode: 'sa',
        invitedByUserId: 'admin-1',
      });

      const call = invite.upsert.mock.calls[0][0];
      expect(call.create.email).toBe('family@example.com');
      expect(call.create.countryCode).toBe('SA');
      expect(call.where).toEqual({
        email_cohortId: { email: 'family@example.com', cohortId: 'pilot-2026-q1' },
      });
    });

    it('re-inviting an address already in the cohort does NOT reset a redemption', async () => {
      invite.upsert.mockResolvedValue({ id: 'invite-new' });

      await service.invite({
        email: 'family@example.com',
        cohortId: 'pilot-2026-q1',
        countryCode: 'SA',
      });

      // Handing a used invitation back out would turn one invitation into two
      // households.
      const call = invite.upsert.mock.calls[0][0];
      expect(call.update).toEqual({ countryCode: 'SA' });
      expect(call.update).not.toHaveProperty('redeemedAt');
      expect(call.update).not.toHaveProperty('redeemedByFamilyId');
    });
  });

  describe('enrolmentOf — the cohort and country actually recorded', () => {
    it('returns the cohort and country for an enrolled family', async () => {
      const redeemedAt = new Date('2026-08-17T10:00:00.000Z');
      invite.findFirst.mockResolvedValue({
        cohortId: 'pilot-2026-q1',
        countryCode: 'EG',
        redeemedAt,
      });

      await expect(service.enrolmentOf('family-1')).resolves.toEqual({
        cohortId: 'pilot-2026-q1',
        countryCode: 'EG',
        redeemedAt,
      });
    });

    it('returns null for a family that never joined a pilot', async () => {
      invite.findFirst.mockResolvedValue(null);

      await expect(service.enrolmentOf('family-2')).resolves.toBeNull();
    });
  });
});
