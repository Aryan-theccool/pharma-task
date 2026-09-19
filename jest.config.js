/**
 * Two projects with very different contracts:
 *
 *  - `unit`        — pure, in-process, no network or database. Fast enough to
 *                    run on every keystroke and safe to parallelise.
 *  - `integration` — boots the real Nest application against a real Postgres
 *                    and Redis and drives it over HTTP with Supertest. Run with
 *                    `--runInBand`, because the booking tests deliberately
 *                    contend for the same rows.
 */
const base = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  clearMocks: true,
};

module.exports = {
  // Integration specs wait on real TOTP windows and async PDF rendering.
  testTimeout: 60_000,
  projects: [
    {
      ...base,
      displayName: 'unit',
      testMatch: ['<rootDir>/test/unit/**/*.spec.ts'],
    },
    {
      ...base,
      displayName: 'integration',
      testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
      globalSetup: '<rootDir>/test/integration/global-setup.ts',
      setupFiles: ['<rootDir>/test/integration/setup-env.ts'],
    },
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.module.ts',
    '!src/**/*.dto.ts',
    '!src/main.ts',
    '!src/worker.ts',
    '!src/**/index.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text-summary', 'lcov', 'json-summary'],
};
