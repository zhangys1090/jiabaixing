/**
 * ACP 活动追踪器
 *
 * 桥接 EventBus 事件 → ACP 会话活动数据
 * 追踪文件变更、终端命令、工具调用，按 sessionId 聚合
 * 让 ACPServer 的 getFileDiffs/getTerminalCommands/getToolActivities 返回真实数据
 */

import type {
    ACPFileDiff,
    ACPTerminalCommand,
    ACPToolActivity,
} from '../ide/ACPServer';
import { Logger } from '../utils/Logger';

interface TrackedFileDiff {
  sessionId: string;
  diff: ACPFileDiff;
  timestamp: number;
}

interface TrackedTerminalCommand {
  sessionId: string;
  command: ACPTerminalCommand;
  timestamp: number;
}

interface TrackedToolActivity {
  sessionId: string;
  activity: ACPToolActivity;
  timestamp: number;
}

interface SessionActivitySnapshot {
  fileDiffs: ACPFileDiff[];
  terminalCommands: ACPTerminalCommand[];
  toolActivities: ACPToolActivity[];
}

export class ACPActivityTracker {
  private static instance: ACPActivityTracker | null = null;

  private fileDiffs: TrackedFileDiff[] = [];
  private terminalCommands: TrackedTerminalCommand[] = [];
  private toolActivities: TrackedToolActivity[] = [];

  private readonly MAX_PER_SESSION = 500;
  private readonly MAX_GLOBAL = 5000;
  private cleanupInterval: ReturnType<typeof setInterval>;

  private constructor() {
    this.cleanupInterval = setInterval(() => this.prune(), 10 * 60 * 1000);
  }

  static create(): ACPActivityTracker {
    return new ACPActivityTracker();
  }

  static getInstance(): ACPActivityTracker {
    if (!ACPActivityTracker.instance) {
      ACPActivityTracker.instance = new ACPActivityTracker();
    }
    return ACPActivityTracker.instance;
  }

  static resetInstance(): void {
    if (ACPActivityTracker.instance) {
      clearInterval(ACPActivityTracker.instance.cleanupInterval);
      ACPActivityTracker.instance = null;
    }
  }

  trackFileDiff(sessionId: string, diff: ACPFileDiff): void {
    this.fileDiffs.push({ sessionId, diff, timestamp: Date.now() });
    this.enforceLimit('fileDiffs');
  }

  trackTerminalCommand(sessionId: string, command: ACPTerminalCommand): void {
    this.terminalCommands.push({ sessionId, command, timestamp: Date.now() });
    this.enforceLimit('terminalCommands');
  }

  trackToolActivity(sessionId: string, activity: ACPToolActivity): void {
    this.toolActivities.push({ sessionId, activity, timestamp: Date.now() });
    this.enforceLimit('toolActivities');
  }

  getSessionActivities(sessionId: string): SessionActivitySnapshot {
    return {
      fileDiffs: this.fileDiffs
        .filter((t) => t.sessionId === sessionId)
        .map((t) => t.diff),
      terminalCommands: this.terminalCommands
        .filter((t) => t.sessionId === sessionId)
        .map((t) => t.command),
      toolActivities: this.toolActivities
        .filter((t) => t.sessionId === sessionId)
        .map((t) => t.activity),
    };
  }

  getFileDiffs(sessionId: string): ACPFileDiff[] {
    return this.fileDiffs
      .filter((t) => t.sessionId === sessionId)
      .map((t) => t.diff);
  }

  getTerminalCommands(sessionId: string): ACPTerminalCommand[] {
    return this.terminalCommands
      .filter((t) => t.sessionId === sessionId)
      .map((t) => t.command);
  }

  getToolActivities(sessionId: string): ACPToolActivity[] {
    return this.toolActivities
      .filter((t) => t.sessionId === sessionId)
      .map((t) => t.activity);
  }

  clearSession(sessionId: string): void {
    this.fileDiffs = this.fileDiffs.filter((t) => t.sessionId !== sessionId);
    this.terminalCommands = this.terminalCommands.filter(
      (t) => t.sessionId !== sessionId
    );
    this.toolActivities = this.toolActivities.filter(
      (t) => t.sessionId !== sessionId
    );
  }

  getStats(): {
    fileDiffs: number;
    terminalCommands: number;
    toolActivities: number;
    sessions: number;
  } {
    const sessions = new Set<string>();
    for (const t of this.fileDiffs) sessions.add(t.sessionId);
    for (const t of this.terminalCommands) sessions.add(t.sessionId);
    for (const t of this.toolActivities) sessions.add(t.sessionId);

    return {
      fileDiffs: this.fileDiffs.length,
      terminalCommands: this.terminalCommands.length,
      toolActivities: this.toolActivities.length,
      sessions: sessions.size,
    };
  }

  private enforceLimit(
    kind: 'fileDiffs' | 'terminalCommands' | 'toolActivities'
  ): void {
    const arr = this[kind] as Array<{ sessionId: string; timestamp: number }>;
    if (arr.length > this.MAX_GLOBAL) {
      arr.splice(0, arr.length - this.MAX_GLOBAL);
    }
  }

  private prune(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    this.fileDiffs = this.fileDiffs.filter((t) => t.timestamp > cutoff);
    this.terminalCommands = this.terminalCommands.filter(
      (t) => t.timestamp > cutoff
    );
    this.toolActivities = this.toolActivities.filter(
      (t) => t.timestamp > cutoff
    );
    Logger.debug(
      `ACP 活动追踪器清理完成: ${this.fileDiffs.length} diffs, ${this.terminalCommands.length} commands, ${this.toolActivities.length} activities`,
      'ACPActivityTracker'
    );
  }
}
