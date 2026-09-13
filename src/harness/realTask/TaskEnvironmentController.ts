import * as fs from 'fs';
import * as path from 'path';
import type { RealTask, TaskEnvironment, DisturbanceSpec } from './RealTaskTypes';
import { Logger } from '../../utils/Logger';

export interface EnvironmentSnapshot {
  timestamp: number;
  files: string[];
  directories: string[];
  metadata: Record<string, unknown>;
}

export interface TaskEnvironmentController {
  setup(task: RealTask, env: TaskEnvironment): Promise<void>;
  injectDisturbance(task: RealTask, env: TaskEnvironment): Promise<boolean>;
  verifyDisturbance(task: RealTask, env: TaskEnvironment): Promise<{ disturbed: boolean; evidence: string }>;
  snapshot(env: TaskEnvironment): Promise<EnvironmentSnapshot>;
  cleanup(task: RealTask, env: TaskEnvironment): Promise<void>;
}

class TaskEnvironmentControllerImpl implements TaskEnvironmentController {
  async setup(task: RealTask, env: TaskEnvironment): Promise<void> {
    if (task.setup) {
      await task.setup(env);
      Logger.info(
        `[D8-2.1] TaskEnvironmentController.setup: ${task.taskId} at ${env.tempDir}`,
        'TaskEnvironmentController'
      );
    }
  }

  async injectDisturbance(task: RealTask, env: TaskEnvironment): Promise<boolean> {
    if (!task.disturbance) {
      Logger.info(
        `[D8-2.1] No disturbance defined for ${task.taskId}`,
        'TaskEnvironmentController'
      );
      return false;
    }

    Logger.info(
      `[D8-2.1] Injecting disturbance for ${task.taskId}: ${task.disturbance.description}`,
      'TaskEnvironmentController'
    );

    try {
      await task.disturbance.execute(env);
      const verifyResult = await task.disturbance.verify(env);
      Logger.info(
        `[D8-2.1] Disturbance injected: disturbed=${verifyResult.disturbed} evidence="${verifyResult.evidence}"`,
        'TaskEnvironmentController'
      );
      return verifyResult.disturbed;
    } catch (err) {
      Logger.error(
        `[D8-2.1] Disturbance injection failed: ${(err as Error).message}`,
        err as Error,
        'TaskEnvironmentController'
      );
      return false;
    }
  }

  async verifyDisturbance(task: RealTask, env: TaskEnvironment): Promise<{ disturbed: boolean; evidence: string }> {
    if (!task.disturbance) {
      return { disturbed: false, evidence: 'no disturbance defined' };
    }
    return task.disturbance.verify(env);
  }

  async snapshot(env: TaskEnvironment): Promise<EnvironmentSnapshot> {
    const timestamp = Date.now();
    const files: string[] = [];
    const directories: string[] = [];

    try {
      if (fs.existsSync(env.tempDir)) {
        const entries = fs.readdirSync(env.tempDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile()) files.push(entry.name);
          if (entry.isDirectory()) directories.push(entry.name);
        }
      }
    } catch {}

    return {
      timestamp,
      files,
      directories,
      metadata: { tempDir: env.tempDir, platform: env.platform },
    };
  }

  async cleanup(task: RealTask, env: TaskEnvironment): Promise<void> {
    if (task.teardown) {
      try {
        await task.teardown(env);
        Logger.info(
          `[D8-2.1] TaskEnvironmentController.cleanup: ${task.taskId}`,
          'TaskEnvironmentController'
        );
      } catch (err) {
        Logger.error(
          `[D8-2.1] Cleanup failed for ${task.taskId}: ${(err as Error).message}`,
          err as Error,
          'TaskEnvironmentController'
        );
      }
    }
  }
}

let instance: TaskEnvironmentController | null = null;

export function getTaskEnvironmentController(): TaskEnvironmentController {
  if (!instance) {
    instance = new TaskEnvironmentControllerImpl();
  }
  return instance;
}

export function resetTaskEnvironmentController(): void {
  instance = null;
}
