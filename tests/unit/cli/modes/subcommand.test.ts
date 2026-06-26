/**
 * CLI 子命令分发单元测试
 *
 * 验证 subcommandMode 正确分发所有子命令到对应处理器，
 * 包括之前因 cli.ts 重复代码丢失的 model/security/performance/mcp/
 * system/conversations/docs/curator 等命令。
 */
jest.mock('../../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../../../src/cli/commands/chat', () => ({
  handleAskCommand: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../src/cli/commands/skills', () => ({
  handleSkillCommand: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../src/cli/commands/schedule', () => ({
  handleScheduleCommand: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../src/cli/commands/status', () => ({
  handleStatusCommandCLI: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../src/cli/commands/memory', () => ({
  handleMemoryCommandCLI: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../src/cli/commands/evolution', () => ({
  handleEvolutionCommandCLI: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../src/cli/commands/gateway', () => ({
  handleGatewayCommandCLI: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../src/cli/commands/context', () => ({
  handleContextCommandCLI: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../src/cli/commands/model', () => ({
  handleModelCommandCLI: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../src/cli/commands/security', () => ({
  handleSecurityCommandCLI: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../src/cli/commands/performance', () => ({
  handlePerformanceCommandCLI: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../src/cli/commands/mcp', () => ({
  handleMcpCommandCLI: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../src/cli/commands/system', () => ({
  handleSystemCommandCLI: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../src/cli/commands/conversations', () => ({
  handleConversationsCommandCLI: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../src/cli/commands/docs', () => ({
  handleDocsCommandCLI: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../src/cli/commands/search', () => ({
  handleSearchCommand: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../src/cli/commands/curator', () => ({
  handleCuratorCommandCLI: jest.fn().mockResolvedValue(undefined),
}));

import { handleAskCommand } from '../../../../src/cli/commands/chat';
import { handleConversationsCommandCLI } from '../../../../src/cli/commands/conversations';
import { handleCuratorCommandCLI } from '../../../../src/cli/commands/curator';
import { handleDocsCommandCLI } from '../../../../src/cli/commands/docs';
import { handleMcpCommandCLI } from '../../../../src/cli/commands/mcp';
import { handleModelCommandCLI } from '../../../../src/cli/commands/model';
import { handlePerformanceCommandCLI } from '../../../../src/cli/commands/performance';
import { handleSearchCommand } from '../../../../src/cli/commands/search';
import { handleSecurityCommandCLI } from '../../../../src/cli/commands/security';
import { handleStatusCommandCLI } from '../../../../src/cli/commands/status';
import { handleSystemCommandCLI } from '../../../../src/cli/commands/system';
import { subcommandMode } from '../../../../src/cli/modes/subcommand';

const exitSpy = jest
  .spyOn(process, 'exit')
  .mockImplementation((code?: string | number | null) => {
    throw new Error(`EXIT_${code ?? 0}`);
  });
const stderrSpy = jest
  .spyOn(process.stderr, 'write')
  .mockImplementation(() => true);
const stdoutSpy = jest
  .spyOn(process.stdout, 'write')
  .mockImplementation(() => true);

describe('CLI 子命令分发 (subcommandMode)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('应正确分发 model 子命令（之前丢失的命令）', async () => {
    await subcommandMode(['model', 'list']);
    expect(handleModelCommandCLI).toHaveBeenCalledTimes(1);
  });

  it('应正确分发 security 子命令', async () => {
    await subcommandMode(['security', 'report']);
    expect(handleSecurityCommandCLI).toHaveBeenCalledTimes(1);
  });

  it('应正确分发 performance 子命令', async () => {
    await subcommandMode(['performance', 'snapshot']);
    expect(handlePerformanceCommandCLI).toHaveBeenCalledTimes(1);
  });

  it('应正确分发 mcp 子命令', async () => {
    await subcommandMode(['mcp', 'servers']);
    expect(handleMcpCommandCLI).toHaveBeenCalledTimes(1);
  });

  it('应正确分发 system 子命令', async () => {
    await subcommandMode(['system', 'resources']);
    expect(handleSystemCommandCLI).toHaveBeenCalledTimes(1);
  });

  it('应正确分发 conversations 子命令', async () => {
    await subcommandMode(['conversations', 'list']);
    expect(handleConversationsCommandCLI).toHaveBeenCalledTimes(1);
  });

  it('应正确分发 docs 子命令', async () => {
    await subcommandMode(['docs', 'list']);
    expect(handleDocsCommandCLI).toHaveBeenCalledTimes(1);
  });

  it('应正确分发 curator 子命令', async () => {
    await subcommandMode(['curator', 'status']);
    expect(handleCuratorCommandCLI).toHaveBeenCalledTimes(1);
  });

  it('应正确分发 ask 子命令', async () => {
    await subcommandMode(['ask', '你好']);
    expect(handleAskCommand).toHaveBeenCalledWith('你好', expect.any(Object));
  });

  it('应正确分发 status 子命令', async () => {
    await subcommandMode(['status']);
    expect(handleStatusCommandCLI).toHaveBeenCalledTimes(1);
  });

  it('应正确分发 search 子命令', async () => {
    await subcommandMode(['search', '天气']);
    expect(handleSearchCommand).toHaveBeenCalledWith(
      '天气',
      expect.any(Object)
    );
  });

  it('应将后续参数传递给处理器', async () => {
    await subcommandMode(['model', 'switch', 'gpt-4', '--json']);
    expect(handleModelCommandCLI).toHaveBeenCalledWith(
      ['switch', 'gpt-4'],
      expect.objectContaining({ json: true })
    );
  });

  it('未知子命令应退出码 1 并输出错误', async () => {
    await expect(subcommandMode(['nonexistent'])).rejects.toThrow('EXIT_1');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('未知子命令: nonexistent')
    );
  });

  it('缺少子命令应退出码 1 并输出帮助', async () => {
    await expect(subcommandMode([])).rejects.toThrow('EXIT_1');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('缺少子命令')
    );
  });

  it('help 命令应输出帮助信息', async () => {
    await subcommandMode(['help']);
    expect(stdoutSpy).toHaveBeenCalledWith(
      expect.stringContaining('Jiabaixing CLI 子命令')
    );
  });
});
