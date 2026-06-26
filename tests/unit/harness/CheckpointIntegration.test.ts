/**
 * CheckpointService ↔ incremental_edit / rollback_changes 集成测试
 *
 * 验证：
 * 1. incremental_edit 在文件修改前自动创建检查点
 * 2. rollback_changes 优先使用检查点回滚整个工作目录
 * 3. 未注入 checkpointService 时回退到历史记录模式（向后兼容）
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CheckpointService } from '../../../src/harness/persistence/CheckpointService';
import {
  createIncrementalEditExecutor,
  type IncrementalEditDeps,
} from '../../../src/harness/tools/file/incremental_edit';
import {
  createRollbackChangesExecutor,
  type RollbackChangesDeps,
} from '../../../src/harness/tools/system/rollback_changes';
import type { ToolContext } from '../../../src/harness/types';
import { Permission } from '../../../src/harness/types';

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../../src/shared/EventBus', () => ({
  EventBus: {
    emit: jest.fn().mockResolvedValue(undefined),
  },
}));

const toolContext: ToolContext = {
  permissions: new Set<Permission>([
    Permission.FILE_WRITE,
    Permission.FILE_READ,
  ]),
  metadata: {},
};

interface FileChangeHistoryEntry {
  content: string;
  timestamp: number;
  description: string;
}

function makeHistoryStore(): {
  store: Map<string, FileChangeHistoryEntry[]>;
  addToHistory: IncrementalEditDeps['addToHistory'];
  getHistory: RollbackChangesDeps['getHistory'];
  removeHistory: RollbackChangesDeps['removeHistory'];
} {
  const store = new Map<string, FileChangeHistoryEntry[]>();
  return {
    store,
    addToHistory: async (filePath, entry) => {
      const list = store.get(filePath) || [];
      list.unshift(entry);
      store.set(filePath, list);
    },
    getHistory: async (filePath) => store.get(filePath) || [],
    removeHistory: async (filePath, steps) => {
      const list = store.get(filePath) || [];
      const removed = list.splice(0, steps);
      store.set(filePath, list);
      return removed;
    },
  };
}

function makeTempProject(): { projectRoot: string; dataDir: string } {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-integration-'));
  const dataDir = path.join(projectRoot, '.checkpoints');
  return { projectRoot, dataDir };
}

describe('CheckpointService ↔ incremental_edit 集成', () => {
  let projectRoot: string;
  let dataDir: string;
  let checkpointService: CheckpointService;
  let history: ReturnType<typeof makeHistoryStore>;

  beforeEach(() => {
    const env = makeTempProject();
    projectRoot = env.projectRoot;
    dataDir = env.dataDir;
    checkpointService = new CheckpointService({ projectRoot, dataDir });
    history = makeHistoryStore();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('incremental_edit 在写入前自动创建检查点', async () => {
    const filePath = path.join(projectRoot, 'target.ts');
    fs.writeFileSync(filePath, 'const x = 1;\n', 'utf-8');

    const beforeCount = checkpointService.listCheckpoints().length;

    const executor = createIncrementalEditExecutor({
      addToHistory: history.addToHistory,
      validateCodeSyntax: () => [],
      checkpointService,
    });

    const result = await executor(
      {
        file_path: filePath,
        edits: [
          {
            search: 'const x = 1;',
            replace: 'const x = 2;',
            description: '修改 x 值',
          },
        ],
      },
      toolContext
    );

    expect(result.success).toBe(true);
    const afterCount = checkpointService.listCheckpoints().length;
    expect(afterCount).toBe(beforeCount + 1);

    const latest = checkpointService.listCheckpoints()[0];
    expect(latest.label).toContain('incremental_edit');
    expect(latest.label).toContain('target.ts');
  });

  it('检查点创建失败不阻断文件修改', async () => {
    const filePath = path.join(projectRoot, 'target.ts');
    fs.writeFileSync(filePath, 'const x = 1;\n', 'utf-8');

    const failingService = {
      createCheckpoint: jest.fn().mockRejectedValue(new Error('disk full')),
    };

    const executor = createIncrementalEditExecutor({
      addToHistory: history.addToHistory,
      validateCodeSyntax: () => [],
      checkpointService: failingService as never,
    });

    const result = await executor(
      {
        file_path: filePath,
        edits: [
          {
            search: 'const x = 1;',
            replace: 'const x = 2;',
          },
        ],
      },
      toolContext
    );

    expect(result.success).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toContain('const x = 2;');
  });

  it('未注入 checkpointService 时正常工作（向后兼容）', async () => {
    const filePath = path.join(projectRoot, 'target.ts');
    fs.writeFileSync(filePath, 'const x = 1;\n', 'utf-8');

    const executor = createIncrementalEditExecutor({
      addToHistory: history.addToHistory,
      validateCodeSyntax: () => [],
    });

    const result = await executor(
      {
        file_path: filePath,
        edits: [
          {
            search: 'const x = 1;',
            replace: 'const x = 99;',
          },
        ],
      },
      toolContext
    );

    expect(result.success).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toContain('const x = 99;');
  });
});

describe('CheckpointService ↔ rollback_changes 集成', () => {
  let projectRoot: string;
  let dataDir: string;
  let checkpointService: CheckpointService;
  let history: ReturnType<typeof makeHistoryStore>;

  beforeEach(() => {
    const env = makeTempProject();
    projectRoot = env.projectRoot;
    dataDir = env.dataDir;
    checkpointService = new CheckpointService({ projectRoot, dataDir });
    history = makeHistoryStore();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('rollback_changes 优先使用检查点回滚工作目录', async () => {
    const filePath = path.join(projectRoot, 'doc.txt');
    fs.writeFileSync(filePath, 'original content\n', 'utf-8');

    // 创建检查点（保存原始状态）
    await checkpointService.createCheckpoint('before-edit');

    // 修改文件
    fs.writeFileSync(filePath, 'modified content\n', 'utf-8');
    expect(fs.readFileSync(filePath, 'utf-8')).toContain('modified content');

    const executor = createRollbackChangesExecutor({
      getHistory: history.getHistory,
      removeHistory: history.removeHistory,
      checkpointService,
    });

    const result = await executor(
      { file_path: filePath, steps: 1 },
      toolContext
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('检查点');
    // 文件应恢复到检查点时的状态
    expect(fs.readFileSync(filePath, 'utf-8')).toContain('original content');
  });

  it('无检查点时回退到历史记录模式', async () => {
    const filePath = path.join(projectRoot, 'doc.txt');
    fs.writeFileSync(filePath, 'version-2\n', 'utf-8');

    // 只往历史记录写入，不创建检查点
    await history.addToHistory(filePath, {
      content: 'version-1\n',
      timestamp: Date.now(),
      description: '上一次版本',
    });

    const executor = createRollbackChangesExecutor({
      getHistory: history.getHistory,
      removeHistory: history.removeHistory,
      checkpointService,
    });

    const result = await executor(
      { file_path: filePath, steps: 1 },
      toolContext
    );

    expect(result.success).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toContain('version-1');
  });

  it('未注入 checkpointService 时使用历史记录回滚（向后兼容）', async () => {
    const filePath = path.join(projectRoot, 'doc.txt');
    fs.writeFileSync(filePath, 'current\n', 'utf-8');

    await history.addToHistory(filePath, {
      content: 'previous\n',
      timestamp: Date.now(),
      description: '旧版本',
    });

    const executor = createRollbackChangesExecutor({
      getHistory: history.getHistory,
      removeHistory: history.removeHistory,
    });

    const result = await executor(
      { file_path: filePath, steps: 1 },
      toolContext
    );

    expect(result.success).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toContain('previous');
  });
});

describe('incremental_edit → rollback_changes 端到端', () => {
  let projectRoot: string;
  let dataDir: string;
  let checkpointService: CheckpointService;
  let history: ReturnType<typeof makeHistoryStore>;

  beforeEach(() => {
    const env = makeTempProject();
    projectRoot = env.projectRoot;
    dataDir = env.dataDir;
    checkpointService = new CheckpointService({ projectRoot, dataDir });
    history = makeHistoryStore();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('修改后通过检查点回滚恢复原始内容', async () => {
    const filePath = path.join(projectRoot, 'app.ts');
    fs.writeFileSync(filePath, 'export const VERSION = "1.0.0";\n', 'utf-8');

    const editExecutor = createIncrementalEditExecutor({
      addToHistory: history.addToHistory,
      validateCodeSyntax: () => [],
      checkpointService,
    });

    // 第一次修改
    await editExecutor(
      {
        file_path: filePath,
        edits: [
          {
            search: '"1.0.0"',
            replace: '"2.0.0"',
            description: '升级版本',
          },
        ],
      },
      toolContext
    );
    expect(fs.readFileSync(filePath, 'utf-8')).toContain('"2.0.0"');

    // 第二次修改
    await editExecutor(
      {
        file_path: filePath,
        edits: [
          {
            search: '"2.0.0"',
            replace: '"3.0.0"',
            description: '再次升级版本',
          },
        ],
      },
      toolContext
    );
    expect(fs.readFileSync(filePath, 'utf-8')).toContain('"3.0.0"');

    // 通过检查点回滚到第一次修改前的状态
    const rollbackExecutor = createRollbackChangesExecutor({
      getHistory: history.getHistory,
      removeHistory: history.removeHistory,
      checkpointService,
    });

    const result = await rollbackExecutor(
      { file_path: filePath, steps: 2 },
      toolContext
    );

    expect(result.success).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toContain('"1.0.0"');
  });
});
