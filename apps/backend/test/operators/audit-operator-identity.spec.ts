import { AuditService, type IRecordAuditEventInput } from '../../src/modules/audit/application/audit.service';
import type { PrismaService } from '../../src/common/prisma/prisma.service';

/**
 * ===========================================================================
 * THE AUDIT SERVICE REFUSES ROWS THAT WOULD BE UNREADABLE LATER.
 * ===========================================================================
 *
 * An audit trail is only worth the moment it is read, which is always months
 * after it is written and always by somebody who was not there. Two shapes fail
 * exactly then, and both are cheap to refuse now:
 *
 *   A PARTIAL OPERATOR IDENTITY. `operator_id` on its own is a uuid that stops
 *   resolving the day that person is removed — and removal is the whole point
 *   of having identities. The denormalised email and role exist so the row
 *   survives the person; writing one without the others quietly gives that up.
 *
 *   AN OPERATOR MUTATION WITH NO REASON. It is the row a compliance review
 *   opens and finds empty.
 *
 * Both THROW rather than warn. A service that quietly writes a defective audit
 * row is worse than one that refuses, because the defect is only discovered at
 * the moment the row was needed.
 */
function serviceWithSpy() {
  const create = jest.fn().mockResolvedValue({});
  const prisma = { auditLog: { create } } as unknown as PrismaService;
  return { audit: new AuditService(prisma), create };
}

const OPERATOR_IDENTITY = {
  operatorId: '11111111-1111-4111-8111-111111111111',
  operatorEmail: 'ops@abny.app',
  operatorRole: 'SUPER_ADMIN' as const,
};

const BASE: IRecordAuditEventInput = {
  actorType: 'OPERATOR',
  action: 'operator.updated',
  entityType: 'Operator',
  entityId: '22222222-2222-4222-8222-222222222222',
  reason: 'moved to the safety desk',
  ...OPERATOR_IDENTITY,
};

describe('audit rows that name a member of staff', () => {
  it('writes the identity and the reason as COLUMNS, not buried in metadata', async () => {
    const { audit, create } = serviceWithSpy();

    await audit.record(BASE);

    const data = create.mock.calls[0][0].data;
    expect(data.actorType).toBe('OPERATOR');
    expect(data.operatorId).toBe(OPERATOR_IDENTITY.operatorId);
    // Denormalised deliberately: the row must say who they WERE and what they
    // HELD at the instant they acted, and a join would rewrite that on every
    // role change.
    expect(data.operatorEmail).toBe('ops@abny.app');
    expect(data.operatorRole).toBe('SUPER_ADMIN');
    expect(data.reason).toBe('moved to the safety desk');
  });

  it('refuses an operator id with no email or role', async () => {
    const { audit, create } = serviceWithSpy();

    await expect(
      audit.record({ ...BASE, operatorEmail: undefined, operatorRole: undefined }),
    ).rejects.toThrow(/AUDIT_PARTIAL_OPERATOR_IDENTITY/);

    // Refused BEFORE the write, not cleaned up after it.
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses actorType OPERATOR with no identity at all', async () => {
    const { audit, create } = serviceWithSpy();

    await expect(
      audit.record({
        actorType: 'OPERATOR',
        action: 'operator.signed_in',
        entityType: 'Operator',
        entityId: BASE.entityId,
      }),
    ).rejects.toThrow(/AUDIT_OPERATOR_WITHOUT_IDENTITY/);
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses an operator mutation whose reason is missing or blank', async () => {
    const { audit, create } = serviceWithSpy();

    await expect(audit.record({ ...BASE, reason: undefined })).rejects.toThrow(/AUDIT_REASON_REQUIRED/);
    await expect(audit.record({ ...BASE, reason: '   ' })).rejects.toThrow(/AUDIT_REASON_REQUIRED/);
    expect(create).not.toHaveBeenCalled();
  });

  it('does NOT demand a reason for a sign-in, which has none to give', async () => {
    const { audit, create } = serviceWithSpy();

    // The same table stores `auth.login`. Forcing a justification onto every
    // row is how a required field becomes a field everyone types «x» into.
    await audit.record({
      actorType: 'OPERATOR',
      action: 'operator.signed_in',
      entityType: 'Operator',
      entityId: BASE.entityId,
      ...OPERATOR_IDENTITY,
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data.reason).toBeUndefined();
  });

  it('leaves every existing non-operator caller untouched', async () => {
    const { audit, create } = serviceWithSpy();

    // The twenty-four call sites that predate this change pass no operator
    // fields and must keep working exactly as they did.
    await audit.record({
      actorType: 'USER',
      actorUserId: '33333333-3333-4333-8333-333333333333',
      familyId: '44444444-4444-4444-8444-444444444444',
      action: 'auth.login',
      entityType: 'User',
      entityId: '33333333-3333-4333-8333-333333333333',
    });

    const data = create.mock.calls[0][0].data;
    expect(data.actorType).toBe('USER');
    expect(data.operatorId).toBeUndefined();
    expect(data.operatorEmail).toBeUndefined();
    expect(data.operatorRole).toBeUndefined();
  });
});
