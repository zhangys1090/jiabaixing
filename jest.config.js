/** @type {import('ts-jest').JestConfigWithTsJest} */
const coverageConfig = require('./tests/coverage/coverage-config');

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests', '<rootDir>/src'],
  testMatch: ['**/?(*.)+(spec|test).[tj]s?(x)'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/tests/unit/frontend/',
    '/src/frontend/src/App.test',
    '/tests/phase2-intelligence',
    '/tests/phase3-autonomy',
    '/tests/phase4-integration',
    '/tests/e2e/stress/',
    '/tests/e2e/infrastructure/',
    '/tests/e2e/frontend/',
    '/tests/e2e/core/',
    '/tests/e2e/interaction/',
    '/tests/stress/',
    '/tests/unit/memory/MemoryEvolutionManager',
    '/tests/unit/memory/MemoryAssociationNetwork',
    '/tests/unit/desktop/OCRService',
    '/tests/unit/desktop/DesktopVisionEngine',
    '/tests/unit/desktop/DesktopAgentLoop',
    '/tests/unit/core/MultiObjectiveTaskCoordinator',
    '/tests/unit/interaction/VoiceInteractionManager',
    '/tests/shared/',
    '/tests/integration/MemoryPersistence',
    '/tests/integration/RealInteractionTest',
    '/tests/integration/PersonaConsistency',
    '/tests/integration/MonitoringCoreIntegration',
    '/tests/integration/integration-layer.test',
    '/tests/integration/EvolutionCycleVerification',
    '/tests/integration/EvolutionVerification',
    '/tests/integration/Phase8To10Infrastructure',
    '/tests/integration/PositiveLoop',
    '/tests/integration/eventbus-tracking',
    '/tests/integration/integration-layer-basic',
  ],
  transform: {
    '^.+\.tsx?$': [
      'ts-jest',
      {
        // 转译不查类型：jest 是运行时闸门，类型闸门由 tsc（npm run check:ts）负责。
        // 源码中存在预存类型错误（如 AAgentHarness.ts），不应卡住无关的测试套件。
        isolatedModules: true,
      },
    ],
  },
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageProvider: 'v8',
  coverageThreshold: coverageConfig.coverageThreshold,
  collectCoverageFrom: coverageConfig.collectCoverageFrom,
  modulePaths: ['<rootDir>/src'],
  moduleDirectories: ['node_modules', 'src'],
  moduleNameMapper: {
    '^better-sqlite3$': '<rootDir>/tests/__mocks__/better-sqlite3.ts',
  },
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
};
