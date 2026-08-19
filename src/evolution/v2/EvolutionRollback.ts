import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../utils/Logger';
import { EvolutionAction, RollbackCheckpoint } from './types';

export class EvolutionRollback {
  private checkpointDir: string;
  private checkpoints: Map<string, RollbackCheckpoint> = new Map();

  constructor(checkpointDir: string = './.evolution-checkpoints') {
    this.checkpointDir = path.resolve(checkpointDir);
    this.ensureCheckpointDir();
  }

  private ensureCheckpointDir(): void {
    if (!fs.existsSync(this.checkpointDir)) {
      fs.mkdirSync(this.checkpointDir, { recursive: true });
    }
  }

  /**
   * 创建回滚检查点：为所有涉及文件创建快照
   */
  createCheckpoint(
    planId: string,
    actions: EvolutionAction[]
  ): RollbackCheckpoint {
    const snapshot: Record<string, string> = {};

    for (const action of actions) {
      if (action.type === 'MODIFY_FILE' || action.type === 'DELETE_FILE') {
        const filePath =
          (action.target as import('./types').CodeLocation).filePath ||
          (action.target as string);
        if (fs.existsSync(filePath)) {
          try {
            snapshot[filePath] = fs.readFileSync(filePath, 'utf-8');
            Logger.debug(`Snapshot saved: ${filePath}`, 'EvolutionRollback');
          } catch (e) {
            Logger.error(
              `Failed to snapshot ${filePath}`,
              e as Error,
              'EvolutionRollback'
            );
          }
        }
      }
    }

    const checkpoint: RollbackCheckpoint = {
      id: `checkpoint-${planId}-${Date.now()}`,
      planId,
      timestamp: Date.now(),
      snapshot,
    };

    this.saveCheckpoint(checkpoint);
    this.checkpoints.set(checkpoint.id, checkpoint);
    Logger.info(
      `💾 Checkpoint created: ${checkpoint.id} (${Object.keys(snapshot).length} files)`,
      'EvolutionRollback'
    );
    return checkpoint;
  }

  /**
   * 执行回滚
   */
  async rollback(
    checkpointId: string
  ): Promise<{ success: boolean; error?: string }> {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) {
      return { success: false, error: `Checkpoint not found: ${checkpointId}` };
    }

    try {
      Logger.info(
        `⏪ Starting rollback to checkpoint: ${checkpointId}`,
        'EvolutionRollback'
      );

      for (const [filePath, originalContent] of Object.entries(
        checkpoint.snapshot
      )) {
        if (originalContent) {
          fs.writeFileSync(filePath, originalContent, 'utf-8');
          Logger.debug(`Rolled back: ${filePath}`, 'EvolutionRollback');
        } else {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            Logger.debug(
              `Rolled back delete: ${filePath}`,
              'EvolutionRollback'
            );
          }
        }
      }

      Logger.info(
        `✅ Rollback completed: ${checkpointId}`,
        'EvolutionRollback'
      );
      return { success: true };
    } catch (error) {
      Logger.error(
        `❌ Rollback failed: ${checkpointId}`,
        error as Error,
        'EvolutionRollback'
      );
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * 获取指定计划的所有检查点 ID（按时间戳降序）
   */
  getCheckpointIdsByPlanId(planId: string): string[] {
    return Array.from(this.checkpoints.values())
      .filter((cp) => cp.planId === planId)
      .sort((a, b) => b.timestamp - a.timestamp)
      .map((cp) => cp.id);
  }

  /**
   * 持久化检查点到磁盘
   */
  private saveCheckpoint(checkpoint: RollbackCheckpoint): void {
    const checkpointPath = path.join(
      this.checkpointDir,
      `${checkpoint.id}.json`
    );
    fs.writeFileSync(
      checkpointPath,
      JSON.stringify(checkpoint, null, 2),
      'utf-8'
    );
  }

  /**
   * 从磁盘加载检查点
   */
  loadCheckpoint(checkpointId: string): RollbackCheckpoint | null {
    if (this.checkpoints.has(checkpointId)) {
      return this.checkpoints.get(checkpointId)!;
    }

    const checkpointPath = path.join(
      this.checkpointDir,
      `${checkpointId}.json`
    );
    if (fs.existsSync(checkpointPath)) {
      const content = fs.readFileSync(checkpointPath, 'utf-8');
      const checkpoint = JSON.parse(content) as RollbackCheckpoint;
      this.checkpoints.set(checkpointId, checkpoint);
      return checkpoint;
    }

    return null;
  }

  /**
   * 清理旧检查点
   */
  cleanOldCheckpoints(daysToKeep: number = 7): void {
    const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;

    if (!fs.existsSync(this.checkpointDir)) return;

    const files = fs.readdirSync(this.checkpointDir);
    let deleted = 0;

    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const fullPath = path.join(this.checkpointDir, file);
          const stat = fs.statSync(fullPath);
          if (stat.mtime.getTime() < cutoff) {
            fs.unlinkSync(fullPath);
            deleted++;
          }
        } catch {
          // ignore
        }
      }
    }

    if (deleted > 0) {
      Logger.info(
        `🧹 Cleaned up ${deleted} old checkpoints`,
        'EvolutionRollback'
      );
    }
  }
}

export default EvolutionRollback;
