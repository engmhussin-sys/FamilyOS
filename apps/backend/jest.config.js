/**
 * ===========================================================================
 * SWC, NOT ts-jest — and the reason is a hard upstream fact.
 * ===========================================================================
 *
 * `ts-jest@29.4.12` — its own latest — declares `peerDependencies.typescript:
 * ">=4.3 <7"`. It does not support TypeScript 7, and no published tag of it
 * does (`next` is an OLDER prerelease, 29.0.0-next.1). So the project's rule of
 * running the current toolchain and this transformer cannot both hold.
 *
 * SWC is the way through, and it is where NestJS itself has moved — the Nest
 * CLI ships `--builder swc`. It transpiles TypeScript without typechecking it,
 * which is the right division of labour rather than a compromise: TYPES ARE
 * CHECKED ONCE, by `tsc --noEmit` in CI and in the version guard, instead of
 * being re-checked inside every one of 240 test files. The suite got faster and
 * the typecheck did not get weaker.
 *
 * ── `decoratorMetadata: true` IS LOAD-BEARING ──────────────────────────
 *
 * Nest's dependency injection reads constructor parameter types out of
 * `design:paramtypes`, which only exists if the compiler EMITS decorator
 * metadata. Without this flag every `@Injectable` in the codebase would still
 * compile and every provider would resolve to `undefined` at runtime — the
 * whole application would fail to wire, loudly, in `app.module.spec.ts`. It is
 * the one setting here that is not a preference.
 */
/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': [
      '@swc/jest',
      {
        jsc: {
          target: 'es2023',
          parser: { syntax: 'typescript', decorators: true },
          transform: {
            legacyDecorator: true,
            // See the header. Nest DI does not work without this.
            decoratorMetadata: true,
          },
        },
      },
    ],
  },
  collectCoverageFrom: ['src/**/*.(t|j)s'],
  coveragePathIgnorePatterns: ['main.ts', '.module.ts', '.dto.ts'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
};
