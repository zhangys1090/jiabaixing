/**
 * 对话历史管理器
 * 负责对话历史的存储、检索和持久化
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/Logger';
import { SYSTEM_CONSTANTS } from '../shared/contracts';

export interface ConversationEntry {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
}

export interface ConversationState {
  history: ConversationEntry[];
  lastUpdated: string;
  userId: string;
}

export class ConversationHistoryManager {
  private static readonly MAX_HISTORY = 20;

  private getStateFilePath(userId: string): string {
    return path.join(
      process.cwd(),
      'data',
      `conversation-state-${userId}.json`
    );
  }

  private stateFilePath: string;
  private history: ConversationEntry[] = [];
  private userId: string = 'default';
  private saveDebounceTimer: NodeJS.Timeout | null = null;

  constructor(userId?: string) {
    this.userId = userId || 'default';
    this.stateFilePath = this.getStateFilePath(this.userId);
  }

  /**
   * 异步初始化：从文件加载对话历史
   * 构造函数不能为 async，因此将文件 I/O 延迟到 init()
   */
  async init(): Promise<void> {
    await this.loadState();
  }

  public addUserMessage(content: string): void {
    this.addEntry('user', content);
  }

  public addAssistantMessage(content: string): void {
    this.addEntry('assistant', content);
  }

  public addSystemMessage(content: string): void {
    this.addEntry('system', content);
  }

  private addEntry(role: ConversationEntry['role'], content: string): void {
    this.history.push({
      role,
      content,
      timestamp: new Date(),
    });

    if (this.history.length > ConversationHistoryManager.MAX_HISTORY) {
      this.history = this.history.slice(
        -ConversationHistoryManager.MAX_HISTORY
      );
    }

    this.scheduleSave();
  }

  public addTurn(userContent: string, assistantContent: string): void {
    this.addUserMessage(userContent);
    this.addAssistantMessage(assistantContent);
  }

  public getRecent(count: number = 5): ConversationEntry[] {
    return this.history.slice(-count);
  }

  public getAll(): ConversationEntry[] {
    return [...this.history];
  }

  public async clear(): Promise<void> {
    this.history = [];
    await this.flushSave();
  }

  public setHistory(history: ConversationEntry[]): void {
    this.history = history.slice(-ConversationHistoryManager.MAX_HISTORY);
    this.scheduleSave();
  }

  /**
   * 调度保存（debounce）
   */
  private scheduleSave(): void {
    if (this.saveDebounceTimer !== null) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = setTimeout(() => {
      this.saveState().catch(() => {
        // 忽略
      });
      this.saveDebounceTimer = null;
    }, SYSTEM_CONSTANTS.HISTORY_SAVE_DEBOUNCE_MS);
  }

  /**
   * 立即保存（用于退出/清理场景）
   */
  public async flushSave(): Promise<void> {
    if (this.saveDebounceTimer !== null) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    await this.saveState();
  }

  public getLength(): number {
    return this.history.length;
  }

  public async saveState(): Promise<void> {
    try {
      const dir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const state: ConversationState = {
        history: this.history.map((entry) => ({
          ...entry,
          timestamp:
            entry.timestamp instanceof Date
              ? entry.timestamp
              : new Date(entry.timestamp),
        })),
        lastUpdated: new Date().toISOString(),
        userId: this.userId,
      };

      await fs.promises.writeFile(
        this.stateFilePath,
        JSON.stringify(state, null, 2),
        'utf-8'
      );
    } catch (error) {
      Logger.debug(
        `对话状态保存失败（非关键）: ${(error as Error).message}`,
        'ConversationHistoryManager'
      );
    }
  }

  private async loadState(): Promise<void> {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const raw = await fs.promises.readFile(this.stateFilePath, 'utf-8');
        const state: ConversationState = JSON.parse(raw);

        this.history = (state.history || []).map((entry) => ({
          ...entry,
          timestamp: new Date(entry.timestamp),
        }));
        this.userId = state.userId || this.userId;

        Logger.info(
          `💾 已恢复 ${this.history.length} 条对话历史`,
          'ConversationHistoryManager'
        );
      }
    } catch (error) {
      Logger.debug(
        `对话状态恢复失败（非关键）: ${(error as Error).message}`,
        'ConversationHistoryManager'
      );
    }
  }

  public formatForLLM(): Array<{ role: string; content: string }> {
    return this.history.map((entry) => ({
      role: entry.role,
      content: entry.content,
    }));
  }
}

export default ConversationHistoryManager;
