"use strict";
/**
 * 桌面Agent安全防护系统
 * 参考 Codex Computer Use 安全设计
 *
 * v2: 推进能力边界增强
 *   - 行为异常检测: 识别异常操作模式（快速重复点击、循环导航、无进展停滞）
 *   - 动态安全级别: 根据应用上下文自动调整安全策略（可信应用更宽松）
 *   - 动作序列验证: 检测危险动作链（如连续删除→清空回收站），阻止级联风险
 *   - 沙盒预演模式: 在执行前模拟预判操作影响，不实际执行
 *   - 安全策略热更新: 运行时动态添加/移除安全规则，无需重启
 *
 * 安全层级：
 * 1. 事前拦截 - 危险操作黑名单
 * 2. 事中监控 - 操作频率、异常行为检测
 * 3. 紧急停止 - 快捷键、鼠标角、超时
 * 4. 事后回滚 - 检查点恢复
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.safetyGuard = exports.DesktopSafetyGuard = void 0;
const events_1 = require("events");
const DesktopEventStream_1 = require("./DesktopEventStream");
const Logger_1 = require("../utils/Logger");
const DEFAULT_CONFIG = {
    level: 'moderate',
    maxActionsPerMinute: 60,
    maxActionsPerTask: 100,
    enableMouseCornerStop: true,
    enableKeyboardStop: true,
    emergencyStopKey: 'Escape',
    taskTimeoutMs: 300000,
    requireConfirmationForDangerous: true,
    allowedApps: [],
    forbiddenApps: [],
    allowedPaths: [],
    forbiddenPaths: [],
};
const ANOMALY_DEFAULTS = {
    enabled: true,
    rapidClickThreshold: 10,
    rapidClickWindowMs: 3000,
    loopDetectionWindow: 5,
    loopSimilarityThreshold: 0.8,
    stagnationThreshold: 8,
    stagnationWindowMs: 30000,
};
const DANGEROUS_SEQUENCES = [
    {
        id: 'delete_chain',
        name: '连续删除链',
        patterns: [['type:delete', 'type:delete'], ['type:delete', 'key:enter'], ['key:delete', 'key:delete']],
        severity: 'high',
        description: '连续执行删除操作，可能造成数据丢失',
    },
    {
        id: 'delete_empty_recycle',
        name: '删除后清空回收站',
        patterns: [['type:delete', 'type:empty_recycle'], ['key:delete', 'click:recycle_bin']],
        severity: 'critical',
        description: '删除文件后清空回收站，数据不可恢复',
    },
    {
        id: 'system_config_chain',
        name: '系统配置修改链',
        patterns: [['type:regedit', 'type:regedit'], ['type:msconfig', 'type:regedit']],
        severity: 'high',
        description: '连续修改系统配置，可能导致系统不稳定',
    },
];
const TRUSTED_APP_PATTERNS = [
    { pattern: /notepad|记事本/i, level: 'low', maxActionsPerMinute: 120 },
    { pattern: /calculator|计算器/i, level: 'low', maxActionsPerMinute: 120 },
    { pattern: /chrome|firefox|edge|浏览器/i, level: 'moderate', maxActionsPerMinute: 80 },
    { pattern: /word|excel|powerpoint|office/i, level: 'moderate', maxActionsPerMinute: 80 },
    { pattern: /explorer|文件资源管理器/i, level: 'moderate', maxActionsPerMinute: 60 },
    { pattern: /cmd|powershell|terminal/i, level: 'strict', maxActionsPerMinute: 30 },
    { pattern: /regedit|注册表/i, level: 'strict', maxActionsPerMinute: 20 },
];
// 危险操作定义
const DANGEROUS_ACTIONS = [
    // 系统级危险操作
    {
        type: 'system',
        pattern: /shutdown|restart|halt|poweroff/i,
        severity: 'critical',
        description: '系统关机/重启操作',
        requireConfirmation: true,
    },
    {
        type: 'system',
        pattern: /taskkill.*\/f.*svchost|taskkill.*\/f.*explorer/i,
        severity: 'high',
        description: '终止系统关键进程',
        requireConfirmation: true,
    },
    // 文件删除危险操作
    {
        type: 'file',
        pattern: /rm\s+-rf\s+(\/|\/\*|C:\\Windows|C:\\Windows\\.*)/i,
        severity: 'critical',
        description: '删除系统目录',
        requireConfirmation: true,
    },
    {
        type: 'file',
        pattern: /format\s+[A-Z]:/i,
        severity: 'critical',
        description: '格式化磁盘',
        requireConfirmation: true,
    },
    {
        type: 'file',
        pattern: /del\s+\/s\s+.*\\Windows|del\s+\/s\s+.*\\System32/i,
        severity: 'critical',
        description: '删除系统文件',
        requireConfirmation: true,
    },
    // 注册表危险操作
    {
        type: 'registry',
        pattern: /reg\s+delete|reg\s+add\s+HKLM/i,
        severity: 'high',
        description: '修改系统注册表',
        requireConfirmation: true,
    },
    // 网络危险操作
    {
        type: 'network',
        pattern: /netsh\s+firewall|netsh\s+advfirewall/i,
        severity: 'medium',
        description: '修改防火墙规则',
        requireConfirmation: true,
    },
    // 用户管理危险操作
    {
        type: 'user',
        pattern: /net\s+user\s+.*\/add|net\s+localgroup\s+administrators/i,
        severity: 'high',
        description: '用户账户管理操作',
        requireConfirmation: true,
    },
    // 加密/擦除操作
    {
        type: 'security',
        pattern: /cipher\s+\/w/i,
        severity: 'high',
        description: '安全擦除磁盘空闲空间',
        requireConfirmation: true,
    },
    {
        type: 'security',
        pattern: /diskpart|bcdedit/i,
        severity: 'high',
        description: '磁盘分区/启动配置修改',
        requireConfirmation: true,
    },
];
class DesktopSafetyGuard extends events_1.EventEmitter {
    constructor(config) {
        super();
        this.isRunning = false;
        this.isPaused = false;
        this.isStopped = false;
        this.actionCount = 0;
        this.actionTimestamps = [];
        this.taskStartTime = 0;
        this.emergencyStopCallbacks = [];
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.eventStream = DesktopEventStream_1.DesktopEventStream.getInstance();
        this._anomalyConfig = { ...ANOMALY_DEFAULTS, ...config?.anomaly };
        this._actionSequence = [];
        this._maxSequenceLength = 20;
        this._currentAppContext = null;
        this._dynamicLevel = this.config.level;
        this._dynamicMaxActions = this.config.maxActionsPerMinute;
        this._hotRules = [];
        this._anomalyDetections = [];
        this._maxAnomalyDetections = 100;
        this._dryRunMode = false;
        this._dryRunLog = [];
    }
    static getInstance(config) {
        if (!DesktopSafetyGuard.instance) {
            DesktopSafetyGuard.instance = new DesktopSafetyGuard(config);
        }
        return DesktopSafetyGuard.instance;
    }
    /**
     * 初始化安全防护
     */
    async initialize() {
        Logger_1.Logger.info('🛡️  安全防护系统初始化', 'SafetyGuard');
        Logger_1.Logger.info(`   安全级别: ${this.config.level}`, 'SafetyGuard');
        Logger_1.Logger.info(`   每分钟最大操作数: ${this.config.maxActionsPerMinute}`, 'SafetyGuard');
        Logger_1.Logger.info(`   任务超时: ${this.config.taskTimeoutMs / 1000}秒`, 'SafetyGuard');
        // 设置紧急停止监听
        if (this.config.enableKeyboardStop) {
            this.setupKeyboardStop();
        }
        if (this.config.enableMouseCornerStop) {
            this.setupMouseCornerStop();
        }
        this.isRunning = true;
        Logger_1.Logger.info('✅ 安全防护系统已启动', 'SafetyGuard');
    }
    /**
     * 开始任务前检查
     */
    startTask() {
        this.actionCount = 0;
        this.actionTimestamps = [];
        this.taskStartTime = Date.now();
        this.isStopped = false;
        this.isPaused = false;
    }
    /**
     * 检查操作是否允许执行
     * 返回 { allowed: boolean, reason?: string, requireConfirmation?: boolean }
     */
    checkAction(actionType, actionDescription, actionParams) {
        if (this.isStopped) {
            return { allowed: false, reason: '已触发紧急停止' };
        }
        if (this.isPaused) {
            return { allowed: false, reason: '任务已暂停' };
        }
        if (this._dryRunMode) {
            this._dryRunLog.push({
                actionType,
                actionDescription,
                actionParams,
                timestamp: Date.now(),
                result: 'dry_run_skip',
            });
            return { allowed: false, reason: '沙盒预演模式：操作仅记录不执行', dryRun: true };
        }
        const rateCheck = this.checkRateLimit();
        if (!rateCheck.allowed) {
            return rateCheck;
        }
        const timeoutCheck = this.checkTaskTimeout();
        if (!timeoutCheck.allowed) {
            return timeoutCheck;
        }
        if (this.actionCount >= this.config.maxActionsPerTask) {
            return {
                allowed: false,
                reason: `已达到单任务最大操作数: ${this.config.maxActionsPerTask}`,
                severity: 'medium',
            };
        }
        if (this._anomalyConfig.enabled) {
            const anomalyCheck = this._checkAnomaly(actionType, actionDescription);
            if (anomalyCheck.detected) {
                this.eventStream.emitSafetyWarning('anomaly', anomalyCheck.description, anomalyCheck.severity);
                if (anomalyCheck.severity === 'high' || anomalyCheck.severity === 'critical') {
                    return {
                        allowed: false,
                        reason: `异常行为检测: ${anomalyCheck.description}`,
                        severity: anomalyCheck.severity,
                        anomalyType: anomalyCheck.type,
                    };
                }
            }
        }
        const sequenceCheck = this._checkDangerousSequence(actionType, actionDescription);
        if (sequenceCheck.detected) {
            this.eventStream.emitSafetyWarning('dangerous_sequence', sequenceCheck.description, sequenceCheck.severity);
            if (this._dynamicLevel === 'strict' || sequenceCheck.severity === 'critical') {
                return {
                    allowed: false,
                    reason: `危险动作序列拦截: ${sequenceCheck.description}`,
                    severity: sequenceCheck.severity,
                    sequenceId: sequenceCheck.id,
                };
            }
            if (this.config.requireConfirmationForDangerous) {
                return {
                    allowed: false,
                    reason: `需要确认危险序列: ${sequenceCheck.description}`,
                    severity: sequenceCheck.severity,
                    requireConfirmation: true,
                    sequenceId: sequenceCheck.id,
                };
            }
        }
        const hotRuleCheck = this._checkHotRules(actionType, actionDescription, actionParams);
        if (hotRuleCheck.blocked) {
            return {
                allowed: false,
                reason: `热规则拦截: ${hotRuleCheck.reason}`,
                severity: hotRuleCheck.severity,
                ruleId: hotRuleCheck.ruleId,
            };
        }
        const dangerCheck = this.checkDangerousAction(actionType, actionDescription, actionParams);
        if (dangerCheck.found) {
            const danger = dangerCheck.danger;
            this.eventStream.emitSafetyWarning(danger.type, danger.description, danger.severity);
            if (this._dynamicLevel === 'strict') {
                return {
                    allowed: false,
                    reason: `危险操作已拦截: ${danger.description}`,
                    severity: danger.severity,
                };
            }
            if (danger.requireConfirmation &&
                this.config.requireConfirmationForDangerous) {
                return {
                    allowed: false,
                    reason: `需要用户确认: ${danger.description}`,
                    severity: danger.severity,
                    requireConfirmation: true,
                };
            }
        }
        return { allowed: true };
    }
    /**
     * 记录操作执行
     */
    recordAction(actionType, actionDescription) {
        this.actionCount++;
        this.actionTimestamps.push(Date.now());
        const oneMinuteAgo = Date.now() - 60000;
        this.actionTimestamps = this.actionTimestamps.filter((t) => t > oneMinuteAgo);
        this._actionSequence.push({
            type: actionType || 'unknown',
            description: actionDescription || '',
            timestamp: Date.now(),
        });
        if (this._actionSequence.length > this._maxSequenceLength) {
            this._actionSequence.shift();
        }
    }
    /**
     * 紧急停止
     */
    emergencyStop(reason = '用户触发') {
        if (this.isStopped)
            return;
        this.isStopped = true;
        this.isRunning = false;
        Logger_1.Logger.warn(`🚨 紧急停止: ${reason}`, 'SafetyGuard');
        this.eventStream.emitSafetyWarning('emergency_stop', reason, 'high');
        // 调用所有紧急停止回调
        this.emergencyStopCallbacks.forEach((callback) => {
            try {
                callback();
            }
            catch (err) {
                Logger_1.Logger.error(`紧急停止回调错误: ${err.message}`, err, 'SafetyGuard');
            }
        });
        this.emit('emergency_stop', { reason });
    }
    /**
     * 暂停任务
     */
    pause(reason = '用户暂停') {
        this.isPaused = true;
        Logger_1.Logger.info(`⏸️  任务暂停: ${reason}`, 'SafetyGuard');
        this.emit('paused', { reason });
    }
    /**
     * 恢复任务
     */
    resume() {
        this.isPaused = false;
        Logger_1.Logger.info('▶️  任务恢复', 'SafetyGuard');
        this.emit('resumed');
    }
    /**
     * 注册紧急停止回调
     */
    onEmergencyStop(callback) {
        this.emergencyStopCallbacks.push(callback);
        return () => {
            const index = this.emergencyStopCallbacks.indexOf(callback);
            if (index > -1) {
                this.emergencyStopCallbacks.splice(index, 1);
            }
        };
    }
    /**
     * 更新安全配置
     */
    updateConfig(config) {
        this.config = { ...this.config, ...config };
        Logger_1.Logger.info(`⚙️  安全配置已更新，级别: ${this.config.level}`, 'SafetyGuard');
    }
    /**
     * 获取当前安全状态
     */
    getStatus() {
        const oneMinuteAgo = Date.now() - 60000;
        const actionsInLastMinute = this.actionTimestamps.filter((t) => t > oneMinuteAgo).length;
        return {
            isRunning: this.isRunning,
            isPaused: this.isPaused,
            isStopped: this.isStopped,
            actionCount: this.actionCount,
            actionsPerMinute: actionsInLastMinute,
            level: this.config.level,
        };
    }
    /**
     * 检查操作频率限制
     */
    checkRateLimit() {
        const oneMinuteAgo = Date.now() - 60000;
        const actionsInLastMinute = this.actionTimestamps.filter((t) => t > oneMinuteAgo).length;
        const limit = this._dynamicMaxActions || this.config.maxActionsPerMinute;
        if (actionsInLastMinute >= limit) {
            return {
                allowed: false,
                reason: `操作频率过高: ${actionsInLastMinute}次/分钟，限制: ${limit}次/分钟`,
            };
        }
        return { allowed: true };
    }
    /**
     * 检查任务超时
     */
    checkTaskTimeout() {
        if (this.taskStartTime === 0)
            return { allowed: true };
        const elapsed = Date.now() - this.taskStartTime;
        if (elapsed >= this.config.taskTimeoutMs) {
            return {
                allowed: false,
                reason: `任务超时: ${Math.round(elapsed / 1000)}秒，限制: ${this.config.taskTimeoutMs / 1000}秒`,
            };
        }
        return { allowed: true };
    }
    /**
     * 检查是否为危险操作
     */
    checkDangerousAction(actionType, description, params) {
        const checkText = `${actionType} ${description} ${JSON.stringify(params || {})}`;
        for (const danger of DANGEROUS_ACTIONS) {
            if (danger.pattern instanceof RegExp) {
                if (danger.pattern.test(checkText)) {
                    return { found: true, danger };
                }
            }
            else {
                if (checkText.toLowerCase().includes(danger.pattern.toLowerCase())) {
                    return { found: true, danger };
                }
            }
        }
        return { found: false };
    }
    /**
     * 设置键盘紧急停止
     */
    setupKeyboardStop() {
        // 注意：实际实现需要全局键盘钩子
        // 这里提供框架，具体实现依赖系统输入模块
        Logger_1.Logger.info(`⌨️  键盘紧急停止已启用，按 ${this.config.emergencyStopKey} 键停止`, 'SafetyGuard');
        // 可以通过 SystemInput 模块注册全局快捷键
        this.emit('keyboard_stop_setup', { key: this.config.emergencyStopKey });
    }
    /**
     * 设置鼠标角紧急停止
     * 当鼠标移动到屏幕左上角时触发停止
     */
    setupMouseCornerStop() {
        // 注意：实际实现需要持续监控鼠标位置
        // 这里提供框架
        Logger_1.Logger.info('🖱️  鼠标角紧急停止已启用（移到左上角停止）', 'SafetyGuard');
        this.emit('mouse_corner_stop_setup');
    }
    /**
     * 检查鼠标是否在停止角落
     * 可在每次操作前调用
     */
    checkMouseCorner(x, y) {
        const CORNER_SIZE = 20;
        return x < CORNER_SIZE && y < CORNER_SIZE;
    }
    _checkAnomaly(actionType, actionDescription) {
        const now = Date.now();
        const recentActions = this._actionSequence.filter((a) => now - a.timestamp < this._anomalyConfig.rapidClickWindowMs);
        if (recentActions.length >= this._anomalyConfig.rapidClickThreshold) {
            const detection = {
                detected: true,
                type: 'rapid_action',
                description: `快速重复操作: ${recentActions.length}次/${this._anomalyConfig.rapidClickWindowMs / 1000}秒`,
                severity: 'high',
                timestamp: now,
            };
            this._anomalyDetections.push(detection);
            if (this._anomalyDetections.length > this._maxAnomalyDetections) {
                this._anomalyDetections.shift();
            }
            return detection;
        }
        if (this._actionSequence.length >= this._anomalyConfig.loopDetectionWindow) {
            const recent = this._actionSequence.slice(-this._anomalyConfig.loopDetectionWindow);
            const halfLen = Math.floor(recent.length / 2);
            const firstHalf = recent.slice(0, halfLen);
            const secondHalf = recent.slice(halfLen);
            let matchCount = 0;
            for (let i = 0; i < halfLen; i++) {
                if (firstHalf[i].type === secondHalf[i].type &&
                    firstHalf[i].description === secondHalf[i].description) {
                    matchCount++;
                }
            }
            const similarity = matchCount / halfLen;
            if (similarity >= this._anomalyConfig.loopSimilarityThreshold) {
                const detection = {
                    detected: true,
                    type: 'loop',
                    description: `循环操作检测: 相似度${(similarity * 100).toFixed(0)}%，可能陷入死循环`,
                    severity: 'high',
                    timestamp: now,
                };
                this._anomalyDetections.push(detection);
                if (this._anomalyDetections.length > this._maxAnomalyDetections) {
                    this._anomalyDetections.shift();
                }
                return detection;
            }
        }
        if (this.taskStartTime > 0) {
            const sameTypeActions = this._actionSequence.filter((a) => a.type === actionType);
            const recentSameType = sameTypeActions.filter((a) => now - a.timestamp < this._anomalyConfig.stagnationWindowMs);
            if (recentSameType.length >= this._anomalyConfig.stagnationThreshold) {
                const detection = {
                    detected: true,
                    type: 'stagnation',
                    description: `操作停滞: 同类型操作${recentSameType.length}次/${this._anomalyConfig.stagnationWindowMs / 1000}秒无进展`,
                    severity: 'medium',
                    timestamp: now,
                };
                this._anomalyDetections.push(detection);
                if (this._anomalyDetections.length > this._maxAnomalyDetections) {
                    this._anomalyDetections.shift();
                }
                return detection;
            }
        }
        return { detected: false };
    }
    _checkDangerousSequence(actionType, actionDescription) {
        const actionKey = `${actionType}:${(actionDescription || '').substring(0, 30)}`;
        const recentKeys = this._actionSequence.slice(-5).map((a) => `${a.type}:${a.description.substring(0, 30)}`);
        for (const seq of DANGEROUS_SEQUENCES) {
            for (const pattern of seq.patterns) {
                const lastN = recentKeys.slice(-pattern.length);
                let match = true;
                for (let i = 0; i < pattern.length; i++) {
                    if (!lastN[i] || !this._actionMatchesPattern(lastN[i], pattern[i])) {
                        match = false;
                        break;
                    }
                }
                if (match) {
                    return {
                        detected: true,
                        id: seq.id,
                        description: seq.description,
                        severity: seq.severity,
                    };
                }
            }
        }
        return { detected: false };
    }
    _actionMatchesPattern(actionKey, pattern) {
        const [pType, pDesc] = pattern.split(':');
        const [aType, aDesc] = actionKey.split(':');
        if (pType !== aType) return false;
        if (!pDesc) return true;
        return aDesc.includes(pDesc);
    }
    _checkHotRules(actionType, actionDescription, actionParams) {
        for (const rule of this._hotRules) {
            if (!rule.enabled) continue;
            const text = `${actionType} ${actionDescription || ''} ${JSON.stringify(actionParams || {})}`;
            if (rule.pattern instanceof RegExp) {
                if (rule.pattern.test(text)) {
                    return {
                        blocked: rule.action === 'block',
                        reason: rule.description || `热规则匹配: ${rule.id}`,
                        severity: rule.severity || 'medium',
                        ruleId: rule.id,
                    };
                }
            }
            else if (typeof rule.pattern === 'string') {
                if (text.toLowerCase().includes(rule.pattern.toLowerCase())) {
                    return {
                        blocked: rule.action === 'block',
                        reason: rule.description || `热规则匹配: ${rule.id}`,
                        severity: rule.severity || 'medium',
                        ruleId: rule.id,
                    };
                }
            }
        }
        return { blocked: false };
    }
    updateAppContext(appName) {
        this._currentAppContext = appName;
        const matched = TRUSTED_APP_PATTERNS.find((t) => t.pattern.test(appName));
        if (matched) {
            this._dynamicLevel = matched.level;
            this._dynamicMaxActions = matched.maxActionsPerMinute;
            Logger_1.Logger.info(`🛡️ 动态安全调整: 应用"${appName}" → 级别=${matched.level}, 限制=${matched.maxActionsPerMinute}次/分`, 'SafetyGuard');
        }
        else {
            this._dynamicLevel = this.config.level;
            this._dynamicMaxActions = this.config.maxActionsPerMinute;
        }
    }
    addHotRule(rule) {
        const existing = this._hotRules.findIndex((r) => r.id === rule.id);
        if (existing >= 0) {
            this._hotRules[existing] = rule;
        }
        else {
            this._hotRules.push(rule);
        }
        Logger_1.Logger.info(`🛡️ 热规则${existing >= 0 ? '更新' : '添加'}: ${rule.id} (${rule.action})`, 'SafetyGuard');
    }
    removeHotRule(ruleId) {
        const idx = this._hotRules.findIndex((r) => r.id === ruleId);
        if (idx >= 0) {
            this._hotRules.splice(idx, 1);
            Logger_1.Logger.info(`🛡️ 热规则移除: ${ruleId}`, 'SafetyGuard');
            return true;
        }
        return false;
    }
    enableDryRun(enabled) {
        this._dryRunMode = enabled;
        if (enabled) {
            this._dryRunLog = [];
        }
        Logger_1.Logger.info(`🛡️ 沙盒预演模式: ${enabled ? '启用' : '禁用'}`, 'SafetyGuard');
    }
    getDryRunLog() {
        return [...this._dryRunLog];
    }
    clearDryRunLog() {
        this._dryRunLog = [];
    }
    getAnomalyDetections(limit) {
        const dets = [...this._anomalyDetections];
        return limit ? dets.slice(-limit) : dets;
    }
    getActionSequence() {
        return [...this._actionSequence];
    }
    getDynamicSafetyStatus() {
        return {
            baseLevel: this.config.level,
            dynamicLevel: this._dynamicLevel,
            dynamicMaxActions: this._dynamicMaxActions,
            appContext: this._currentAppContext,
            hotRulesCount: this._hotRules.length,
            dryRunMode: this._dryRunMode,
            anomalyDetectionsCount: this._anomalyDetections.length,
            sequenceLength: this._actionSequence.length,
        };
    }
    configureAnomaly(config) {
        this._anomalyConfig = { ...this._anomalyConfig, ...config };
        Logger_1.Logger.info(`🛡️ 异常检测配置已更新: enabled=${this._anomalyConfig.enabled}`, 'SafetyGuard');
    }
    shutdown() {
        this.isRunning = false;
        this.isPaused = false;
        this.isStopped = false;
        this.actionCount = 0;
        this.actionTimestamps = [];
        this._actionSequence = [];
        this._anomalyDetections = [];
        this._hotRules = [];
        this._dryRunLog = [];
        this.emergencyStopCallbacks = [];
        this.removeAllListeners();
        Logger_1.Logger.info('🛡️ DesktopSafetyGuard 已关闭', 'SafetyGuard');
    }
}
exports.DesktopSafetyGuard = DesktopSafetyGuard;
DesktopSafetyGuard.instance = null;
let _safetyGuardInstance = null;
function getSafetyGuard() {
    if (!_safetyGuardInstance) {
        _safetyGuardInstance = DesktopSafetyGuard.getInstance();
    }
    return _safetyGuardInstance;
}
exports.safetyGuard = { get instance() { return getSafetyGuard(); } };
