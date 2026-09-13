"use strict";
/**
 * 系统初始化进度状态管理器
 *
 * 用于支持「先开门后加载」的懒加载启动模式：
 * - HTTP/WS 服务优先开启（秒级启动）
 * - 核心模块在后台异步初始化
 * - 未就绪时 API 返回进度信息
 * - 每步完成时通过回调广播到 WS 客户端
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SystemInitState = void 0;
const Logger_1 = require("../utils/Logger");
/**
 * 系统初始化状态单例
 *
 * 使用方法：
 *   const state = SystemInitState.getInstance();
 *   state.registerStep('database', '数据库系统');
 *   state.markStepRunning('database');
 *   state.markStepDone('database');
 */
class SystemInitState {
    static _instance = null;
    _steps = new Map();
    _stepOrder = [];
    _listeners = new Set();
    _startedAt = Date.now();
    _status = 'loading';
    _firstError = null;
    constructor() { }
    static create() {
        return new SystemInitState();
    }
    static getInstance() {
        if (!SystemInitState._instance) {
            SystemInitState._instance = new SystemInitState();
        }
        return SystemInitState._instance;
    }
    /** 注册一个初始化步骤（按注册顺序决定 overallProgress 的序号） */
    registerStep(name, displayName) {
        if (this._steps.has(name)) {
            return;
        }
        this._steps.set(name, { name, displayName, status: 'pending' });
        this._stepOrder.push(name);
    }
    /** 批量注册步骤 */
    registerSteps(list) {
        for (const step of list) {
            this.registerStep(step.name, step.displayName);
        }
    }
    /** 标记某步骤开始执行 */
    markStepRunning(name) {
        const step = this._steps.get(name);
        if (!step) {
            Logger_1.Logger.warn(`[SystemInitState] 未知步骤: ${name}，自动注册`, 'SystemInitState');
            this.registerStep(name, name);
        }
        const s = this._steps.get(name);
        s.status = 'running';
        s.startedAt = Date.now();
        this._notify();
    }
    /** 标记某步骤完成 */
    markStepDone(name) {
        const step = this._steps.get(name);
        if (!step)
            return;
        step.status = 'done';
        step.finishedAt = Date.now();
        step.durationMs = step.startedAt ? step.finishedAt - step.startedAt : 0;
        Logger_1.Logger.info(`✅ ${step.displayName} 已就绪 (${step.durationMs}ms)`, 'SystemInitState');
        // 如果全部步骤完成，整体状态切为 ready
        const allDone = this._stepOrder.every((n) => this._steps.get(n)?.status === 'done');
        if (allDone) {
            this._status = 'ready';
            Logger_1.Logger.info(`🎯 系统初始化全部完成 (${Math.round(Date.now() - this._startedAt)}ms)`, 'SystemInitState');
        }
        this._notify();
    }
    /** 标记某步骤失败 */
    markStepError(name, err) {
        const step = this._steps.get(name);
        if (!step)
            return;
        step.status = 'error';
        step.finishedAt = Date.now();
        step.durationMs = step.startedAt ? step.finishedAt - step.startedAt : 0;
        step.error = err.message;
        if (!this._firstError) {
            this._firstError = `${name}: ${err.message}`;
            this._status = 'error';
        }
        Logger_1.Logger.error(`❌ ${step.displayName} 初始化失败`, err, 'SystemInitState');
        this._notify();
    }
    /** 是否所有关键步骤已就绪 */
    isReady() {
        return this._status === 'ready';
    }
    /** 是否出现错误 */
    hasError() {
        return this._status === 'error';
    }
    /** 获取某步骤 */
    getStep(name) {
        return this._steps.get(name);
    }
    /** 获取所有步骤（按注册顺序） */
    getAllSteps() {
        return this._stepOrder.map((n) => this._steps.get(n)).filter(Boolean);
    }
    /** 获取总体进度 */
    getOverallProgress() {
        const total = this._stepOrder.length;
        const completed = this._stepOrder.filter((n) => this._steps.get(n)?.status === 'done' ||
            this._steps.get(n)?.status === 'error').length;
        const activeStepName = this._stepOrder.find((n) => this._steps.get(n)?.status === 'running');
        const activeStep = activeStepName
            ? (() => {
                const s = this._steps.get(activeStepName);
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
    getSnapshot() {
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
    subscribe(listener) {
        this._listeners.add(listener);
        // 立即推送一次当前状态
        try {
            listener(this.getSnapshot());
        }
        catch (e) {
            Logger_1.Logger.warn('初始化进度监听器首次推送失败', 'SystemInitState', {
                error: e.message,
            });
        }
        return () => this._listeners.delete(listener);
    }
    /** 手动触发通知（外部模块使用） */
    notify() {
        this._notify();
    }
    /** 重置状态（用于测试） */
    reset() {
        this._steps.clear();
        this._stepOrder.length = 0;
        this._listeners.clear();
        this._startedAt = Date.now();
        this._status = 'loading';
        this._firstError = null;
    }
    _notify() {
        if (this._listeners.size === 0)
            return;
        const snapshot = this.getSnapshot();
        for (const listener of this._listeners) {
            try {
                listener(snapshot);
            }
            catch (e) {
                Logger_1.Logger.warn('初始化进度监听器异常', 'SystemInitState', {
                    error: e.message,
                });
            }
        }
    }
}
exports.SystemInitState = SystemInitState;
