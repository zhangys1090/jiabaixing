/**
 * CLI status 命令单元测试
 */
jest.mock('../../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('CLI status 命令', () => {
  it('handleStatusCommand 不抛异常', async () => {
    const { handleStatusCommand } =
      await import('../../../../src/cli/commands/status');
    await expect(handleStatusCommand()).resolves.toBeUndefined();
  });
});
