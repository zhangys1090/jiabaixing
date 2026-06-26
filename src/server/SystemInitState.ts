/**
 * 系统初始化进度状态管理器
 *
 * 用于支持「先开门后加载」的懒加载启动模式：
 * - HTTP/WS 服务优先开启（秒级启动）
 * - 核心模块在后台异步初始化
 * - 未就绪时 API 返回进度信息
 * - 每步完成时通过回调广播到 WS 客户端
 */

import { Logger } from '../utils/Logger';

/** 单步初始化状态 */
export type InitStepStatus = 'pending' | 'running' | 'done' | 'error';

/** 单步初始化信息 */
export interface InitStep {
  name: string;
  displayName: string;
  status: InitStepStatus;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  error?: string;
}

/** 总体进度信息 */
export interface OverallProgress {
  current: number;
  total: number;
  percent: number;
  status: 'loading' | 'ready' | 'error';
  activeStep?: {
    name: string;
    displayName: string;
    elapsedMs: number;
  };
  firstError?: string;
}

/** 完整初始化快照（供 API 轮询返回） */
export interface InitSnapshot {
  status: 'loading' | 'ready' | 'error';
  progress: {
    current: number;
    total: number;
    percent: number;
  };
  activeStep?: {
    name: string;
    displayName: string;
    elapsedMs: number;
  };
  steps: Array<{
    name: string;
    displayName: string;
    status: InitStepStatus;
    durationMs?: number;
    error?: string;
  }>;
  timestamp: string;
  firstError?: string;
}

/** 进度变化回调类型 */
export type ProgressListener = (snapshot: InitSnapshot) => void;

/**
 * 系统初始化状态单例
 *
 * 使用方法：
 *   const state = SystemInitState.getInstance();
 *   state.registerStep('database', '数据库系统');
 *   state.markStepRunning('database');
 *   state.markStepDone('database');
 */
export class SystemInitState {
  private static _instance: SystemInitState | null = null;

  private readonly _steps: Map<string, InitStep> = new Map();
  private readonly _stepOrder: string[] = [];
  private readonly _listeners: Set<ProgressListener> = new Set();
  private _startedAt: number = Date.now();
  private _status: 'loading' | 'ready' | 'error' = 'loading';
  private _firstError: string | null = null;

  private constructor() {}

  /** 获取全局单例 */
  public static getInstance(): SystemInitState {
    if (!SystemInitState._instance) {
      SystemInitState._instance = new SystemInitState();
    }
    return SystemInitState._instance;
  }

  /** 注册一个初始化步骤（按注册顺序决定 overallProgress 的序号） */
  public registerStep(name: string, displayName: string): void {
    if (this._steps.has(name)) {
      return;
    }
    this._steps.set(name, { name, displayName, status: 'pending' });
    this._stepOrder.push(name);
  }

  /** 批量注册步骤 */
  public registerSteps(
    list: Array<{ name: string; displayName: string }>
  ): void {
    for (const step of list) {
      this.registerStep(step.name, step.displayName);
    }
  }

  /** 标记某步骤开始执行 */
  public markStepRunning(name: string): void {
    const step = this._steps.get(name);
    if (!step) {
      Logger.warn(
        `[SystemInitState] 未知步骤: ${name}，自动注册`,
        'SystemInitState'
      );
      this.registerStep(name, name);
    }
    const s = this._steps.get(name)!;
    s.status = 'running';
    s.startedAt = Date.now();
    this._notify();
  }

  /** 标记某步骤完成 */
  public markStepDone(name: string): void {
    const step = this._steps.get(name);
    if (!step) return;
    step.status = 'done';
    step.finishedAt = Date.now();
    step.durationMs = step.startedAt ? step.finishedAt - step.startedAt : 0;
    Logger.info(
      `✅ ${step.displayName} 已就绪 (${step.durationMs}ms)`,
      'SystemInitState'
    );
    // 如果全部步骤完成，整体状态切为 ready
    const allDone = this._stepOrder.every(
      (n) => this._steps.get(n)?.status === 'done'
    );
    if (allDone) {
      this._status = 'ready';
      Logger.info(
        `🎯 系统初始化全部完成 (${Math.round(Date.now() - this._startedAt)}ms)`,
        'SystemInitState'
      );
    }
    this._notify();
  }

  /** 标记某步骤失败 */
  public markStepError(name: string, err: Error): void {
    const step = this._steps.get(name);
    if (!step) return;
    step.status = 'error';
    step.finishedAt = Date.now();
    step.durationMs = step.startedAt ? step.finishedAt - step.startedAt : 0;
    step.error = err.message;
    if (!this._firstError) {
      this._firstError = `${name}: ${err.message}`;
      this._status = 'error';
    }
    Logger.error(`❌ ${step.displayName} 初始化失败`, err, 'SystemInitState');
    this._notify();
  }

  /** 是否所有关键步骤已就绪 */
  public isReady(): boolean {
    return this._status === 'ready';
  }

  /** 是否出现错误 */
  public hasError(): boolean {
    return this._status === 'error';
  }

  /** 获取某步骤 */
  public getStep(name: string): InitStep | undefined {
    return this._steps.get(name);
  }

  /** 获取所有步骤（按注册顺序） */
  public getAllSteps(): InitStep[] {
    return this._stepOrder.map((n) => this._steps.get(n)!).filter(Boolean);
  }

  /** 获取总体进度 */
  public getOverallProgress(): OverallProgress {
    const total = this._stepOrder.length;
    const completed = this._stepOrder.filter(
      (n) =>
        this._steps.get(n)?.status === 'done' ||
        this._steps.get(n)?.status === 'error'
    ).length;

    const activeStepName = this._stepOrder.find(
      (n) => this._steps.get(n)?.status === 'running'
    );
    const activeStep = activeStepName
      ? (() => {
          const s = this._steps.get(activeStepName)!;
          return {
            name: s.name,
            displayName: s.displayName,
            elapsedMs: s.startedAt ? Date.now() - s.startedAt : 0,
          };
        })()
      : undefined;

    return {
      current: completed,
      total,
      percent: total === 0 ? 100 : Math.round((completed / total) * 100),
      status: this._status,
      activeStep,
      firstError: this._firstError ?? undefined,
    };
  }

  /** 获取完整快照（供 API / WS 推送使用） */
  public getSnapshot(): InitSnapshot {
    const overall = this.getOverallProgress();
    return {
      status: this._status,
      progress: {
        current: overall.current,
        total: overall.total,
        percent: overall.percent,
      },
      activeStep: overall.activeStep,
      steps: this.getAllSteps().map((s) => ({
        name: s.name,
        displayName: s.displayName,
        status: s.status,
        durationMs: s.durationMs,
        error: s.error,
      })),
      timestamp: new Date().toISOString(),
      firstError: this._firstError ?? undefined,
    };
  }

  /** 订阅进度变化（返回取消函数） */
  public subscribe(listener: ProgressListener): () => void {
    this._listeners.add(listener);
    // 立即推送一次当前状态
    try {
      listener(this.getSnapshot());
    } catch (e) {
      Logger.warn('初始化进度监听器首次推送失败', 'SystemInitState', {
        error: (e as Error).message,
      });
    }
    return () => this._listeners.delete(listener);
  }

  /** 手动触发通知（外部模块使用） */
  public notify(): void {
    this._notify();
  }

  /** 重置状态（用于测试） */
  public reset(): void {
    this._steps.clear();
    this._stepOrder.length = 0;
    this._listeners.clear();
    this._startedAt = Date.now();
    this._status = 'loading';
    this._firstError = null;
  }

  private _notify(): void {
    if (this._listeners.size === 0) return;
    const snapshot = this.getSnapshot();
    for (const listener of this._listeners) {
      try {
        listener(snapshot);
      } catch (e) {
        Logger.warn('初始化进度监听器异常', 'SystemInitState', {
          error: (e as Error).message,
        });
      }
    }
  }
}
