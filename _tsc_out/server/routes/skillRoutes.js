"use strict";
/**
 * 技能路由 - skills execute / list
 * 提取公共处理逻辑，消除 Router 和 registerSkillRoutes 之间的重复代码
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.skillRoutes = void 0;
exports.registerSkillRoutes = registerSkillRoutes;
const express_1 = __importDefault(require("express"));
const SkillRegistry_1 = require("../../skills/SkillRegistry");
const Logger_1 = require("../../utils/Logger");
const SKILL_RATE_LIMIT_WINDOW_MS = 60000;
const SKILL_RATE_LIMIT_MAX = 30;
const _skillRateMap = new Map();
const MAX_SKILL_NAME_LENGTH = 128;
function checkSkillRate(key) {
    const now = Date.now();
    const entry = _skillRateMap.get(key);
    if (!entry || now >= entry.resetAt) {
        _skillRateMap.set(key, {
            count: 1,
            resetAt: now + SKILL_RATE_LIMIT_WINDOW_MS,
        });
        return { allowed: true, resetIn: 0 };
    }
    if (entry.count >= SKILL_RATE_LIMIT_MAX) {
        return { allowed: false, resetIn: entry.resetAt - now };
    }
    entry.count++;
    return { allowed: true, resetIn: 0 };
}
async function handleSkillExecute(req, res) {
    try {
        const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
        const rateResult = checkSkillRate(clientIp);
        if (!rateResult.allowed) {
            res.setHeader('Retry-After', Math.ceil(rateResult.resetIn / 1000));
            res
                .status(429)
                .json({ success: false, error: '技能调用过于频繁，请稍后再试' });
            return;
        }
        const { skillName, params } = req.body;
        if (!skillName) {
            res.status(400).json({ success: false, error: '缺少 skillName' });
            return;
        }
        if (typeof skillName !== 'string' ||
            skillName.length > MAX_SKILL_NAME_LENGTH) {
            res.status(400).json({ success: false, error: 'skillName 格式无效' });
            return;
        }
        const registry = SkillRegistry_1.SkillRegistry.getInstance();
        const skill = registry.getSkill(skillName);
        if (!skill) {
            res
                .status(404)
                .json({ success: false, error: `技能不存在: ${skillName}` });
            return;
        }
        const validation = await skill.validate(params || {});
        if (!validation.valid) {
            res
                .status(400)
                .json({ success: false, error: validation.errors.join(', ') });
            return;
        }
        const context = {
            userId: req.body.userId || 'api_user',
            traceId: Logger_1.Logger.generateTraceId(),
        };
        const startTime = Date.now();
        const result = await skill.execute(params || {}, context);
        const duration = Date.now() - startTime;
        res.json({
            success: result.success,
            output: result.output,
            error: result.error,
            metadata: { ...result.metadata, duration },
        });
    }
    catch (error) {
        Logger_1.Logger.error('❌ 技能执行失败', error, 'API');
        res.status(500).json({ success: false, error: error.message });
    }
}
/**
 * 技能列表公共处理逻辑
 */
function handleSkillList(_req, res) {
    try {
        const registry = SkillRegistry_1.SkillRegistry.getInstance();
        const skills = registry.getAllSkillMeta();
        res.json({ success: true, skills, count: skills.length });
    }
    catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}
// 兼容 server/index.ts 的 Router 导出
exports.skillRoutes = express_1.default.Router();
exports.skillRoutes.post('/execute', express_1.default.json({ limit: '10mb' }), handleSkillExecute);
exports.skillRoutes.get('/list', handleSkillList);
// main.ts 使用的注册函数
function registerSkillRoutes(app, _core) {
    app.post('/api/skills/execute', express_1.default.json({ limit: '10mb' }), handleSkillExecute);
    app.get('/api/skills/list', handleSkillList);
}
