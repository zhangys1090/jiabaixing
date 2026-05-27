/** @type {import('ts-jest').JestConfigWithTsJest} */
const coverageConfig = require('./tests/coverage/coverage-config');

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/?(*.)+(spec|test).[tj]s?(x)'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/tests/unit/frontend/',
    '/tests/phase1-optimization',
    '/tests/phase2-intelligence',
    '/tests/phase3-autonomy',
    '/tests/phase4-integration',
    '/tests/unit/multimodal/',
    '/tests/unit/plugins/',
    '/tests/unit/memory/',
    '/tests/unit/monitoring/',
    '/tests/unit/interaction/',
    '/tests/unit/desktop/',
    '/tests/unit/core/',
    '/tests/unit/api/',
    '/tests/e2e/stress/',
    '/tests/e2e/infrastructure/',
    '/tests/e2e/frontend/',
    '/tests/e2e/core/',
    '/tests/e2e/interaction/',
    '/tests/shared/',
    '/tests/stress/',
    '/tests/coordination/',
    '/tests/integration/MemoryPersistence',
    '/tests/integration/RealInteractionTest',
    '/tests/integration/PersonaConsistency',
    '/tests/integration/MonitoringCoreIntegration',
    '/tests/integration/integration-layer.test',
    '/tests/integration/EvolutionCycleVerification',
    '/tests/integration/EvolutionVerification',
    '/tests/integration/Phase8To10Infrastructure',
    '/tests/integration/PositiveLoop',
    '/tests/integration/complete-system-integration',
    '/tests/integration/eventbus-tracking',
    '/tests/integration/integration-layer-basic',
  ],
  transform: {
    '^.+\.tsx?$': 'ts-jest'
  },
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageProvider: 'v8',
  coverageThreshold: coverageConfig.coverageThreshold,
  collectCoverageFrom: coverageConfig.collectCoverageFrom,
  modulePaths: ['<rootDir>/src'],
  moduleDirectories: ['node_modules', 'src'],
  moduleNameMapper: {
    '^better-sqlite3$': '<rootDir>/tests/__mocks__/better-sqlite3.ts'
  },
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts']
};
