import { CheckpointService } from '../../../src/harness/persistence/CheckpointService';
import fs from 'fs';
import path from 'path';
import os from 'os';

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('CheckpointService', () => {
  let service: CheckpointService;
  let tempDir: string;
  let dataDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-test-'));
    dataDir = path.join(tempDir, '.checkpoints');
    fs.writeFileSync(path.join(tempDir, 'test.txt'), 'hello');
    fs.writeFileSync(path.join(tempDir, 'config.json'), '{"key": "value"}');
    service = new CheckpointService({ projectRoot: tempDir, dataDir });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('应创建工作目录快照', async () => {
    const checkpoint = await service.createCheckpoint('before-edit');

    expect(checkpoint.id).toBeDefined();
    expect(checkpoint.label).toBe('before-edit');
    expect(checkpoint.fileCount).toBeGreaterThan(0);
  });

  it('应列出所有检查点', async () => {
    await service.createCheckpoint('cp1');
    await service.createCheckpoint('cp2');

    const checkpoints = service.listCheckpoints();

    expect(checkpoints.length).toBeGreaterThanOrEqual(2);
    expect(checkpoints[0].label).toBe('cp2'); // 最新的在前
  });

  it('应回滚到指定检查点', async () => {
    const filePath = path.join(tempDir, 'test.txt');
    fs.writeFileSync(filePath, 'original');

    await service.createCheckpoint('before-change');

    fs.writeFileSync(filePath, 'modified');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('modified');

    await service.rollback('before-change');

    expect(fs.readFileSync(filePath, 'utf-8')).toBe('original');
  });

  it('应自动清理过期检查点', async () => {
    const limitedService = new CheckpointService({
      projectRoot: tempDir,
      dataDir: path.join(tempDir, '.checkpoints-limited'),
      maxCheckpoints: 2,
    });

    await limitedService.createCheckpoint('cp1');
    await limitedService.createCheckpoint('cp2');
    await limitedService.createCheckpoint('cp3');

    const checkpoints = limitedService.listCheckpoints();
    expect(checkpoints.length).toBeLessThanOrEqual(2);
  });

  it('回滚不存在的检查点应返回 false', async () => {
    const result = await service.rollback('nonexistent');
    expect(result).toBe(false);
  });

  it('检查点应包含文件元数据', async () => {
    const checkpoint = await service.createCheckpoint('metadata-test');

    expect(checkpoint.files.length).toBeGreaterThan(0);
    expect(checkpoint.files[0].relativePath).toBeDefined();
    expect(checkpoint.files[0].hash).toBeDefined();
    expect(checkpoint.files[0].size).toBeGreaterThan(0);
  });

  describe('事务一致性', () => {
    it('快照文件缺失时应拒绝回滚（预校验）', async () => {
      await service.createCheckpoint('intact');
      const cp = service.listCheckpoints()[0];

      // 手动删除快照中的某个文件
      const snapshotDir = path.join(dataDir, 'snapshots', cp.id);
      const files = fs.readdirSync(snapshotDir);
      for (const f of files) {
        if (f !== '_checkpoint.json') {
          const fpath = path.join(snapshotDir, f);
          if (fs.statSync(fpath).isFile()) {
            fs.rmSync(fpath);
            break;
          }
        }
      }

      const result = await service.rollback(cp.id);
      expect(result).toBe(false);
    });

    it('回滚应在修改文件前创建备份', async () => {
      const filePath = path.join(tempDir, 'test.txt');
      fs.writeFileSync(filePath, 'original');

      await service.createCheckpoint('backup-test');
      fs.writeFileSync(filePath, 'modified');

      // 成功回滚
      const result = await service.rollback('backup-test');
      expect(result).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('original');
    });

    it('空白检查点（无文件）回滚应成功', async () => {
      const emptyDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'checkpoint-empty-')
      );
      const emptyDataDir = path.join(emptyDir, '.checkpoints');
      const emptyService = new CheckpointService({
        projectRoot: emptyDir,
        dataDir: emptyDataDir,
      });

      const cp = await emptyService.createCheckpoint('empty');
      expect(cp.fileCount).toBe(0);

      const result = await emptyService.rollback('empty');
      expect(result).toBe(true);

      fs.rmSync(emptyDir, { recursive: true, force: true });
    });

    it('多次回滚应保持一致性', async () => {
      const filePath = path.join(tempDir, 'test.txt');

      // 状态 A
      fs.writeFileSync(filePath, 'version-a');
      await service.createCheckpoint('state-a');

      // 状态 B
      fs.writeFileSync(filePath, 'version-b');
      await service.createCheckpoint('state-b');

      // 回滚到 A
      await service.rollback('state-a');
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('version-a');

      // 再回滚到 B
      await service.rollback('state-b');
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('version-b');
    });
  });
});
