/**
 * Jest 配置 - Electron 主进程单元测试
 *
 * 使用方式: cd src/frontend && npx jest --config jest.electron.config.js
 */

module.exports = {
  rootDir: '.',
  testMatch: ['<rootDir>/tests/electron/**/*.test.js'],
  testEnvironment: 'node',
  moduleNameMapper: {
    '^electron$': '<rootDir>/electron/__mocks__/electron.js',
    '^electron-updater$': '<rootDir>/electron/__mocks__/electron-updater.js',
  },
  transform: {},
  transformIgnorePatterns: [],
  // 每个测试文件独立隔离
  restoreMocks: true,
  clearMocks: true,
  resetModules: true,
  // 超时
  testTimeout: 10000,
  // 详细报告
  verbose: true,
};
