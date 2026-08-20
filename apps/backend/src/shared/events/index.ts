/**
 * The event contract surface. `packages/shared-types` re-exports exactly this
 * module, so anything not exported here is backend-private by construction.
 *
 * Zero runtime dependencies on purpose: only `type` declarations and frozen
 * `const` tables. Importing this from a browser bundle or a codegen script
 * pulls in nothing but plain JavaScript objects.
 */
export * from './event-types';
export * from './event-envelope';
export * from './completion-event';
export * from './idempotency';
export * from './events-batch.contract';
