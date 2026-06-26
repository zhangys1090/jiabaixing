/**
 * 全双工语音会话管理器
 *
 * 管理语音会话生命周期：idle → listening → processing → speaking → idle
 * 支持中断和恢复
 * 设计参考: Hermes Agent 语音模式
 */

import { Logger } from '../utils/Logger';

/** 语音会话状态 */
export type VoiceSessionStatus =
  | 'idle'
  | 'listening'
  | 'processing'
  | 'speaking';

/** 语音会话配置 */
export interface VoiceSessionConfig {
  /** 语言 */
  language: string;
  /** 语音识别提供商 */
  sttProvider?: string;
  /** 语音合成提供商 */
  ttsProvider?: string;
  /** 是否连续监听 */
  continuous?: boolean;
  /** 静音超时（毫秒） */
  silenceTimeout?: number;
}

/** 语音会话 */
export interface VoiceSession {
  /** 会话 ID */
  id: string;
  /** 当前状态 */
  status: VoiceSessionStatus;
  /** 配置 */
  config: VoiceSessionConfig;
  /** 创建时间 */
  createdAt: number;
  /** 最后活动时间 */
  lastActivityAt: number;
  /** 状态变更历史 */
  stateHistory: Array<{
    from: VoiceSessionStatus;
    to: VoiceSessionStatus;
    timestamp: number;
  }>;
}

/** 状态转换规则 */
const VALID_TRANSITIONS: Record<VoiceSessionStatus, VoiceSessionStatus[]> = {
  idle: ['listening'],
  listening: ['processing', 'idle'],
  processing: ['speaking', 'idle'],
  speaking: ['idle', 'listening'],
};

export class VoiceSessionManager {
  private sessions: Map<string, VoiceSession> = new Map();
  private sessionCounter: number = 0;

  /**
   * 创建语音会话
   * @param config - 语音会话配置
   * @returns 新创建的语音会话
   */
  createSession(config: VoiceSessionConfig): VoiceSession {
    this.sessionCounter++;
    const id = `voice_${Date.now()}_${this.sessionCounter}`;
    const now = Date.now();

    const session: VoiceSession = {
      id,
      status: 'idle',
      config,
      createdAt: now,
      lastActivityAt: now,
      stateHistory: [],
    };

    this.sessions.set(id, session);
    Logger.info(`语音会话已创建: ${id}`, 'VoiceSessionManager');

    return session;
  }

  /**
   * 获取会话
   * @param sessionId - 会话 ID
   * @returns 语音会话或 undefined
   */
  getSession(sessionId: string): VoiceSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * 开始监听
   * @param sessionId - 会话 ID
   * @returns 转换是否成功
   */
  startListening(sessionId: string): boolean {
    return this.transition(sessionId, 'listening');
  }

  /**
   * 开始处理
   * @param sessionId - 会话 ID
   * @returns 转换是否成功
   */
  startProcessing(sessionId: string): boolean {
    return this.transition(sessionId, 'processing');
  }

  /**
   * 开始说话
   * @param sessionId - 会话 ID
   * @returns 转换是否成功
   */
  startSpeaking(sessionId: string): boolean {
    return this.transition(sessionId, 'speaking');
  }

  /**
   * 停止（回到 idle）
   * @param sessionId - 会话 ID
   * @returns 转换是否成功
   */
  stop(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    if (session.status === 'idle') return true;

    return this.transition(sessionId, 'idle');
  }

  /**
   * 中断当前状态（直接回到 idle）
   * @param sessionId - 会话 ID
   * @returns 中断是否成功
   */
  interrupt(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const previousStatus = session.status;
    session.status = 'idle';
    session.lastActivityAt = Date.now();
    session.stateHistory.push({
      from: previousStatus,
      to: 'idle',
      timestamp: Date.now(),
    });

    Logger.info(
      `语音会话中断: ${sessionId} (${previousStatus} → idle)`,
      'VoiceSessionManager'
    );
    return true;
  }

  /**
   * 销毁会话
   * @param sessionId - 会话 ID
   * @returns 销毁是否成功
   */
  destroySession(sessionId: string): boolean {
    const removed = this.sessions.delete(sessionId);
    if (removed) {
      Logger.info(`语音会话已销毁: ${sessionId}`, 'VoiceSessionManager');
    }
    return removed;
  }

  /**
   * 获取所有活跃会话
   * @returns 非 idle 状态的会话列表
   */
  getActiveSessions(): VoiceSession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.status !== 'idle'
    );
  }

  /**
   * 获取所有会话
   * @returns 全部会话列表
   */
  getAllSessions(): VoiceSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * 状态转换
   * @param sessionId - 会话 ID
   * @param targetStatus - 目标状态
   * @returns 转换是否成功
   */
  private transition(
    sessionId: string,
    targetStatus: VoiceSessionStatus
  ): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      Logger.warn(`会话不存在: ${sessionId}`, 'VoiceSessionManager');
      return false;
    }

    const allowedTargets = VALID_TRANSITIONS[session.status];
    if (!allowedTargets.includes(targetStatus)) {
      Logger.warn(
        `非法状态转换: ${session.status} → ${targetStatus} (会话: ${sessionId})`,
        'VoiceSessionManager'
      );
      return false;
    }

    const previousStatus = session.status;
    session.status = targetStatus;
    session.lastActivityAt = Date.now();
    session.stateHistory.push({
      from: previousStatus,
      to: targetStatus,
      timestamp: Date.now(),
    });

    Logger.debug(
      `语音状态转换: ${sessionId} (${previousStatus} → ${targetStatus})`,
      'VoiceSessionManager'
    );

    return true;
  }
}
