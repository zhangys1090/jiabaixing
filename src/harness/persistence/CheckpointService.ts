/**
 * 工作目录检查点服务
 *
 * 在文件变更前自动创建快照，支持回滚
 * 设计参考: Hermes Agent 检查点系统
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Logger } from '../../utils/Logger';

export interface CheckpointConfig {
  projectRoot: string;
  dataDir: string;
  maxCheckpoints?: number;
  ignorePatterns?: string[];
}

export interface CheckpointEntry {
  id: string;
  label: string;
  timestamp: number;
  fileCount: number;
  totalSize: number;
  files: Array<{ relativePath: string; hash: string; size: number }>;
}

/**
 * 检查点服务接口（供工具依赖注入使用，统一 createCheckpoint/listCheckpoints/rollback）
 */
export interface ICheckpointService {
  createCheckpoint(label: string): Promise<CheckpointEntry>;
  listCheckpoints(): CheckpointEntry[];
  rollback(labelOrId: string): Promise<boolean>;
}

const DEFAULT_IGNORE = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'data',
  '.checkpoints',
  'coverage',
];

const DEFAULT_MAX_CHECKPOINTS = 10;

export class CheckpointService {
  private config: Required<CheckpointConfig>;
  private checkpointsDir: string;

  constructor(config: CheckpointConfig) {
    this.config = {
      projectRoot: config.projectRoot,
      dataDir: config.dataDir,
      maxCheckpoints: config.maxCheckpoints ?? DEFAULT_MAX_CHECKPOINTS,
      ignorePatterns: config.ignorePatterns ?? DEFAULT_IGNORE,
    };
    this.checkpointsDir = path.join(this.config.dataDir, 'snapshots');
    fs.mkdirSync(this.checkpointsDir, { recursive: true });
  }

  /**
   * 创建工作目录检查点
   * @param label - 检查点标签
   * @returns 检查点条目
   */
  async createCheckpoint(label: string): Promise<CheckpointEntry> {
    const id = `cp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const snapshotDir = path.join(this.checkpointsDir, id);
    fs.mkdirSync(snapshotDir, { recursive: true });

    const files = this.scanProjectFiles();
    let totalSize = 0;

    for (const file of files) {
      const srcPath = path.join(this.config.projectRoot, file.relativePath);
      const destPath = path.join(snapshotDir, file.relativePath);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      try {
        fs.copyFileSync(srcPath, destPath);
        totalSize += file.size;
      } catch {
        // 跳过复制失败的文件
      }
    }

    const entry: CheckpointEntry = {
      id,
      label,
      timestamp: Date.now(),
      fileCount: files.length,
      totalSize,
      files,
    };

    // 保存元数据
    fs.writeFileSync(
      path.join(snapshotDir, '_checkpoint.json'),
      JSON.stringify(entry, null, 2),
      'utf-8'
    );

    Logger.info(
      `📸 检查点已创建: ${label} (${files.length} 文件, ${(totalSize / 1024).toFixed(1)}KB)`,
      'CheckpointService'
    );

    // 清理过期检查点
    this.pruneOldCheckpoints();

    return entry;
  }

  /**
   * 列出所有检查点
   * @returns 按时间降序排列的检查点列表
   */
  listCheckpoints(): CheckpointEntry[] {
    const entries: CheckpointEntry[] = [];

    try {
      const dirs = fs.readdirSync(this.checkpointsDir);
      for (const dir of dirs) {
        const metaPath = path.join(
          this.checkpointsDir,
          dir,
          '_checkpoint.json'
        );
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            entries.push(meta);
          } catch {
            // 跳过损坏的元数据
          }
        }
      }
    } catch {
      // 空目录
    }

    // 按时间降序
    entries.sort((a, b) => b.timestamp - a.timestamp);
    return entries;
  }

  /**
   * 回滚前校验：验证所有快照文件完整
   * @returns 缺失文件列表
   */
  private validateSnapshot(target: CheckpointEntry): string[] {
    const snapshotDir = path.join(this.checkpointsDir, target.id);
    const missing: string[] = [];

    for (const file of target.files) {
      const srcPath = path.join(snapshotDir, file.relativePath);
      if (!fs.existsSync(srcPath)) {
        missing.push(file.relativePath);
        continue;
      }
      // 可选：校验 checksum
      try {
        const actual = crypto
          .createHash('md5')
          .update(fs.readFileSync(srcPath))
          .digest('hex')
          .substring(0, 8);
        if (actual !== file.hash) {
          Logger.warn(
            `⚠️ 检查点文件校验和不匹配: ${file.relativePath} (期望=${file.hash}, 实际=${actual})`,
            'CheckpointService'
          );
        }
      } catch {
        missing.push(file.relativePath);
      }
    }

    return missing;
  }

  /**
   * 回滚到指定检查点
   *
   * 事务性保障：
   *   1. 预校验 — 快照文件完整性检查
   *   2. 备份 — 恢复前备份当前文件
   *   3. 恢复 — 复制快照文件到目标位置
   *   4. 失败回退 — 恢复中断时自动还原备份
   *
   * @param labelOrId - 检查点标签或ID
   * @returns 回滚是否成功
   */
  async rollback(labelOrId: string): Promise<boolean> {
    const checkpoints = this.listCheckpoints();
    const target = checkpoints.find(
      (cp) => cp.id === labelOrId || cp.label === labelOrId
    );

    if (!target) {
      Logger.error(
        `检查点不存在: ${labelOrId}`,
        new Error('Not found'),
        'CheckpointService'
      );
      return false;
    }

    // ==== 第 1 步：预校验 ====
    const missing = this.validateSnapshot(target);
    if (missing.length > 0) {
      Logger.error(
        `❌ 检查点不完整，${missing.length} 个文件丢失: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? `... (共${missing.length}个)` : ''}`,
        new Error('Incomplete checkpoint'),
        'CheckpointService'
      );
      return false;
    }

    const snapshotDir = path.join(this.checkpointsDir, target.id);

    // ==== 第 2 步：备份当前文件 ====
    const backupDir = path.join(
      this.checkpointsDir,
      `_rb_bak_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`
    );
    const restoredFiles: string[] = [];
    let rollbackFailed = false;

    try {
      for (const file of target.files) {
        const srcPath = path.join(snapshotDir, file.relativePath);
        const destPath = path.resolve(
          this.config.projectRoot,
          file.relativePath
        );

        // 安全校验：防止路径遍历
        if (
          !destPath.startsWith(this.config.projectRoot + path.sep) &&
          destPath !== this.config.projectRoot
        ) {
          Logger.warn(
            `跳过非法路径: ${file.relativePath}`,
            'CheckpointService'
          );
          continue;
        }

        // 备份当前文件（如果存在）
        if (fs.existsSync(destPath)) {
          const bakPath = path.join(backupDir, file.relativePath);
          fs.mkdirSync(path.dirname(bakPath), { recursive: true });
          fs.copyFileSync(destPath, bakPath);
        }

        // 恢复快照
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(srcPath, destPath);
        restoredFiles.push(file.relativePath);
      }
    } catch (err) {
      rollbackFailed = true;
      Logger.error(
        `❌ 回滚中断，正在自动回退已修改的 ${restoredFiles.length} 个文件...`,
        err as Error,
        'CheckpointService'
      );
    }

    // ==== 第 4 步：失败时自动回退 ====
    if (rollbackFailed) {
      let restoredCount = 0;
      for (const relPath of restoredFiles) {
        const bakPath = path.join(backupDir, relPath);
        const destPath = path.resolve(this.config.projectRoot, relPath);
        if (fs.existsSync(bakPath)) {
          try {
            fs.copyFileSync(bakPath, destPath);
            restoredCount++;
          } catch {
            Logger.warn(`回退失败: ${relPath}`, 'CheckpointService');
          }
        } else {
          // 备份不存在 → 文件是新增的，删除它
          try {
            fs.rmSync(destPath, { force: true });
          } catch {
            /* ignore */
          }
        }
      }
      Logger.info(
        `🔄 已回退 ${restoredCount}/${restoredFiles.length} 个文件的更改`,
        'CheckpointService'
      );
    }

    // 清理备份目录
    try {
      if (fs.existsSync(backupDir)) {
        fs.rmSync(backupDir, { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }

    if (rollbackFailed) {
      Logger.error(
        `❌ 回滚失败`,
        new Error('Rollback failed'),
        'CheckpointService'
      );
      return false;
    }

    Logger.info(
      `⏪ 已回滚到检查点: ${target.label} (${target.id})`,
      'CheckpointService'
    );
    return true;
  }

  /**
   * 扫描项目文件
   * @returns 文件元数据列表
   */
  private scanProjectFiles(): Array<{
    relativePath: string;
    hash: string;
    size: number;
  }> {
    const files: Array<{ relativePath: string; hash: string; size: number }> =
      [];
    const ignoreSet = new Set(this.config.ignorePatterns);

    const walk = (dir: string, base: string = '') => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (ignoreSet.has(entry.name)) continue;
          if (entry.name.startsWith('.') && entry.name !== '.env.example')
            continue;

          const fullPath = path.join(dir, entry.name);
          const relativePath = base ? `${base}/${entry.name}` : entry.name;

          if (entry.isDirectory()) {
            walk(fullPath, relativePath);
          } else if (entry.isFile()) {
            try {
              const stat = fs.statSync(fullPath);
              if (stat.size > 1024 * 1024) continue; // 跳过 >1MB 文件

              const content = fs.readFileSync(fullPath);
              const hash = crypto
                .createHash('md5')
                .update(content)
                .digest('hex')
                .substring(0, 8);
              files.push({ relativePath, hash, size: stat.size });
            } catch {
              // 跳过读取失败的文件
            }
          }
        }
      } catch {
        // 跳过无权限目录
      }
    };

    walk(this.config.projectRoot);
    return files;
  }

  /**
   * 清理过期检查点
   */
  private pruneOldCheckpoints(): void {
    const checkpoints = this.listCheckpoints();
    if (checkpoints.length <= this.config.maxCheckpoints) return;

    const toRemove = checkpoints.slice(this.config.maxCheckpoints);
    for (const cp of toRemove) {
      const dir = path.join(this.checkpointsDir, cp.id);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 忽略删除失败
      }
    }

    Logger.debug(`清理了 ${toRemove.length} 个过期检查点`, 'CheckpointService');
  }
}
