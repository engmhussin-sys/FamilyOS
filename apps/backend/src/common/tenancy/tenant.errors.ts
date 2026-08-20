/**
 * Deny-by-default failures. These are deliberately NOT HttpExceptions: an
 * operation reaching the database with no tenant is a programming defect, not
 * a client error, and it must surface as a 500 with a loud log line rather
 * than a tidy 4xx that someone might "handle".
 */

export class TenantContextMissingError extends Error {
  readonly code = 'TENANT_CONTEXT_MISSING';

  constructor(model: string, operation: string) {
    super(
      `TENANT_CONTEXT_MISSING: ${model}.${operation} was executed with no tenant context ` +
        'and no SystemContext. This is denied by default — see ' +
        'src/common/tenancy/README, and use runAsSystem(reason, justification, fn) ' +
        'if the operation is genuinely cross-tenant.',
    );
    this.name = 'TenantContextMissingError';
  }
}

export class CrossTenantWriteError extends Error {
  readonly code = 'CROSS_TENANT_WRITE';

  constructor(model: string, operation: string, attempted: string, actual: string) {
    super(
      `CROSS_TENANT_WRITE: ${model}.${operation} tried to write familyId=${attempted} ` +
        `while the authenticated tenant is ${actual}.`,
    );
    this.name = 'CrossTenantWriteError';
  }
}
