/**
 * D7-P0 Bypass Closure — 全局回归测试
 *
 * 验证：
 * 1. CronJobScheduler 不执行 shell（emit scheduled_action_pending）
 * 2. ScenarioAwareScheduler 不调用 llmCore.processInput（emit 事件）
 * 3. MemoryEngineBridge Python 不可用时 fail-closed（不返回伪 MemoryItem）
 * 4. Scheduler 不可直接进入 Tool / Desktop / Shell / SelfModification
 */

jest.mock('../../src/utils/Logger', () => {
  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  return {
    __esModule: true,
    default: mockLogger,
    Logger: mockLogger,
  };
});

jest.mock('../../src/shared/EventBus', () => {
  const mockInstance = {
    emit: jest.fn(),
    on: jest.fn(),
  };
  return {
    __esModule: true,
    default: mockInstance,
    EventBus: mockInstance,
  };
});

jest.mock('../../src/ide/bridgeRegistry', () => ({
  getActivePythonBridge: jest.fn(),
}));

import { CronJobScheduler } from '../../src/cron/CronJobScheduler';
import {
  ScenarioAwareScheduler,
} from '../../src/core/ScenarioAwareScheduler';
import { MemoryEngine, MemoryType } from '../../src/memory/MemoryEngine';
import { EventBus } from '../../src/shared/EventBus';
import { getActivePythonBridge } from '../../src/ide/bridgeRegistry';

const mockGetBridge = getActivePythonBridge as jest.Mock;
const mockEventBusEmit = EventBus.emit as jest.Mock;

describe('D7-P0 Bypass Closure', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Test 1: CronJobScheduler — shell execution BLOCKED', () => {
    let scheduler: CronJobScheduler;

    beforeEach(() => {
      CronJobScheduler.resetInstance(true);
      scheduler = CronJobScheduler.getInstance();
    });

    afterEach(() => {
      scheduler.stop();
      CronJobScheduler.resetInstance(true);
    });

    it('cron 到期时不得执行 shell — 必须返回 success=false', async () => {
      scheduler.register({
        id: 'test_cron_1',
        name: 'Test Blocked Job',
        schedule: 'every:1m',
        command: 'echo hello',
        enabled: true,
      });

      const jobs = scheduler.getJobs();
      const job = jobs[0];

      const runJobMethod = (scheduler as unknown as { runJob(j: unknown): Promise<unknown> }).runJob.bind(scheduler);
      const result = await runJobMethod(job);

      expect(result).toMatchObject({
        exitCode: -1,
        success: false,
      });
      expect((result as { stderr: string }).stderr).toContain('[D7-P0] Blocked');
    });

    it('cron 到期时必须 emit scheduled_action_pending 事件', async () => {
      mockEventBusEmit.mockClear();
      scheduler.register({
        id: 'test_cron_2',
        name: 'Test Event Job',
        schedule: 'every:1m',
        command: 'npm test',
        enabled: true,
      });

      const jobs = scheduler.getJobs();
      const job = jobs[0];

      const runJobMethod = (scheduler as unknown as { runJob(j: unknown): Promise<unknown> }).runJob.bind(scheduler);
      await runJobMethod(job);

      expect(mockEventBusEmit).toHaveBeenCalledWith(
        'scheduled_action_pending',
        expect.objectContaining({
          source: 'CronJobScheduler',
          jobId: 'test_cron_2',
          jobName: 'Test Event Job',
        })
      );
    });
  });

  describe('Test 3: ScenarioAwareScheduler — 事件替代执行', () => {
    let scheduler: ScenarioAwareScheduler;

    beforeEach(() => {
      scheduler = new ScenarioAwareScheduler();
    });

    afterEach(() => {
      scheduler.stop();
    });

    it('自然语言定时任务到期 — emit scheduled_task_due，不调用 processInput', async () => {
      const task = scheduler.addTaskFromNaturalLanguage('每天早上9点总结收件箱');
      const executeTaskMethod = (scheduler as unknown as { executeTask(t: unknown): Promise<void> }).executeTask.bind(scheduler);
      await executeTaskMethod(task);

      expect(mockEventBusEmit).toHaveBeenCalledWith(
        'scheduled_task_due',
        expect.objectContaining({
          source: 'ScenarioAwareScheduler',
          taskId: task.id,
        })
      );
    });

    it('auto_fix 规则触发 — emit auto_fix_candidate，不调用 processInput', async () => {
      scheduler.addFileChangeRule({
        id: 'rule_auto_fix',
        name: 'Auto Fix Rule',
        pattern: '*.ts',
        action: 'auto_fix',
        enabled: true,
      });

      const handleFileChangeMethod = (scheduler as unknown as { handleFileChange(fp: string, ct: string): Promise<void> }).handleFileChange.bind(scheduler);
      await handleFileChangeMethod('c:\\test\\file.ts', 'modified');

      expect(mockEventBusEmit).toHaveBeenCalledWith(
        'auto_fix_candidate',
        expect.objectContaining({
          source: 'ScenarioAwareScheduler',
          filePath: 'c:\\test\\file.ts',
          changeType: 'modified',
          ruleName: 'Auto Fix Rule',
        })
      );
    });

    it('run_tests 规则触发 — emit test_request_pending，不调用 processInput', async () => {
      scheduler.addFileChangeRule({
        id: 'rule_run_tests',
        name: 'Run Tests Rule',
        pattern: '*.test.ts',
        action: 'run_tests',
        enabled: true,
      });

      const handleFileChangeMethod = (scheduler as unknown as { handleFileChange(fp: string, ct: string): Promise<void> }).handleFileChange.bind(scheduler);
      await handleFileChangeMethod('c:\\test\\file.test.ts', 'modified');

      expect(mockEventBusEmit).toHaveBeenCalledWith(
        'test_request_pending',
        expect.objectContaining({
          source: 'ScenarioAwareScheduler',
          filePath: 'c:\\test\\file.test.ts',
          changeType: 'modified',
          ruleName: 'Run Tests Rule',
        })
      );
    });

    it('custom 规则触发 — emit custom_rule_triggered，不调用 processInput', async () => {
      scheduler.addFileChangeRule({
        id: 'rule_custom',
        name: 'Custom Rule',
        pattern: '*.json',
        action: 'custom',
        customPrompt: '检查配置变更',
        enabled: true,
      });

      const handleFileChangeMethod = (scheduler as unknown as { handleFileChange(fp: string, ct: string): Promise<void> }).handleFileChange.bind(scheduler);
      await handleFileChangeMethod('c:\\test\\config.json', 'modified');

      expect(mockEventBusEmit).toHaveBeenCalledWith(
        'custom_rule_triggered',
        expect.objectContaining({
          source: 'ScenarioAwareScheduler',
          filePath: 'c:\\test\\config.json',
          changeType: 'modified',
          ruleName: 'Custom Rule',
          customPrompt: '检查配置变更',
        })
      );
    });
  });

  describe('Test 4: MemoryEngineBridge — Python 不可用时 fail-closed', () => {
    let memoryEngine: MemoryEngine;

    beforeEach(() => {
      mockGetBridge.mockReturnValue(null);
      memoryEngine = new MemoryEngine();
    });

    it('storeShortTermMemory 不得返回伪 MemoryItem', async () => {
      await expect(memoryEngine.storeShortTermMemory('test')).rejects.toThrow(
        'Python bridge unavailable — fail closed'
      );
    });

    it('storeLongTermMemory 不得返回伪 MemoryItem', async () => {
      await expect(memoryEngine.storeLongTermMemory('test')).rejects.toThrow(
        'Python bridge unavailable — fail closed'
      );
    });

    it('preciseHybridRetrieval 不得返回空数组伪装成功', async () => {
      await expect(memoryEngine.preciseHybridRetrieval('test')).rejects.toThrow(
        'Python bridge unavailable — fail closed'
      );
    });
  });

  describe('Test 5: Scheduler 不可直接进入执行路径', () => {
    it('ScenarioAwareScheduler 不再包含 llmCore.processInput 调用路径', () => {
      const fs = require('fs');
      const path = require('path');
      const sourcePath = path.resolve(__dirname, '../../src/core/ScenarioAwareScheduler.ts');
      const source = fs.readFileSync(sourcePath, 'utf-8');

      const processInputCalls = source.match(/this\.llmCore\.processInput\s*\(/g);
      expect(processInputCalls).toBeNull();
    });

    it('CronJobScheduler 不再包含 child_process.exec 调用路径', () => {
      const fs = require('fs');
      const path = require('path');
      const sourcePath = path.resolve(__dirname, '../../src/cron/CronJobScheduler.ts');
      const source = fs.readFileSync(sourcePath, 'utf-8');

      const execCalls = source.match(/child_process\.exec\s*\(/g);
      expect(execCalls).toBeNull();

      const spawnCalls = source.match(/child_process\.spawn\s*\(/g);
      expect(spawnCalls).toBeNull();
    });
  });
});
