"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOL_UNDEFINE_DEF = void 0;
exports.createToolUndefineExecutor = createToolUndefineExecutor;
const Logger_1 = require("../../../utils/Logger");
const types_1 = require("../../types");
const DYNAMIC_TOOL_PREFIX = 'dyn_';
exports.TOOL_UNDEFINE_DEF = {
    name: 'tool_undefine',
    description: '注销动态工具。仅能注销由 tool_define 创建的动态工具，不能注销系统内置工具。适用场景：清理不再需要的动态工具、释放工具槽位、修正错误定义。不适用：注销系统内置工具。',
    category: types_1.ToolCategory.SYSTEM,
    parameters: {
        name: {
            type: 'string',
            description: '要注销的动态工具名称（含 dyn_ 前缀）',
        },
    },
    requiredParams: ['name'],
    requiredPermissions: [types_1.Permission.SYSTEM_ADMIN],
    riskLevel: 'medium',
    idempotent: true,
    timeout: 5000,
    tags: ['meta', 'dynamic', 'self-modifying'],
};
function createToolUndefineExecutor(deps) {
    return async (params, _context) => {
        const startTime = Date.now();
        const name = String(params.name || '').trim();
        if (!name) {
            return { success: false, output: null, error: '工具名称不能为空', duration: Date.now() - startTime, validated: false };
        }
        if (!name.startsWith(DYNAMIC_TOOL_PREFIX)) {
            return { success: false, output: null, error: `只能注销动态工具（以 ${DYNAMIC_TOOL_PREFIX} 开头）。系统内置工具不可注销。`, duration: Date.now() - startTime, validated: false };
        }
        if (!deps.toolRegistry || !deps.toolRegistry.has(name)) {
            return { success: false, output: null, error: `工具不存在: ${name}`, duration: Date.now() - startTime, validated: false };
        }
        const tool = deps.toolRegistry.get(name);
        const isDynamic = tool?.definition.tags?.includes('dynamic') ?? false;
        if (!isDynamic) {
            return { success: false, output: null, error: `"${name}" 不是动态工具，无法注销。系统内置工具受保护。`, duration: Date.now() - startTime, validated: false };
        }
        deps.toolRegistry.unregister(name);
        Logger_1.Logger.info(`动态工具已注销: ${name}`, 'ToolUndefine');
        return {
            success: true,
            output: `动态工具 "${name}" 已成功注销。`,
            duration: Date.now() - startTime,
            validated: false,
        };
    };
}
