/**
 * `@abny/shared-types` — the shared contract surface (CONTEXT §2, monorepo row:
 * "packages/shared-types — one source of types between Backend and Flutter").
 *
 * WHY THIS IS A RE-EXPORT AND NOT THE ORIGINAL, STATED PLAINLY:
 *
 * `apps/backend` compiles with `tsconfig.build.json`'s `rootDir: "./src"`.
 * A file physically outside `src/` that `src/` imports makes `nest build` fail
 * with TS6059, and this repository has no workspace/build orchestration
 * (no root `package.json`, no Nx, no pnpm workspaces) that would let a real
 * package be built and linked first. Adding one would be a build-system change
 * far outside this sprint's remit and would risk the 1,078-test baseline.
 *
 * So the canonical definitions live at
 * `apps/backend/src/shared/events/` — a single file tree, zero duplication —
 * and this package is the stable import specifier every OTHER consumer uses:
 *
 *   import type { CompletionEvent } from '@abny/shared-types';
 *
 * The day CONTEXT §2's Nx/pnpm-workspaces monorepo actually exists, the fix is
 * to move `apps/backend/src/shared/events/*` into `packages/shared-types/src/`
 * and invert this one line. Nothing else in the codebase changes, because
 * nothing else imports across the boundary.
 *
 * The Flutter/Dart side is generated from the OpenAPI schema, not from this
 * file — see `docs/06-API-Architecture.md §6.0`.
 */
export * from '../../../apps/backend/src/shared/events';
