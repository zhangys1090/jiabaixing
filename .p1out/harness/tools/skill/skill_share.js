"use strict";
/**
 * Skill 分享工具 — 一键导出/导入/运行 Skill
 *
 * 从 Hermes 学到的核心原则：
 * - Skill 是传播单元：写完 Skill 分享出去，别人一个命令就能跑
 * - 一句话可传播的结果
 * - 全自主闭环
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SKILL_SHARE_DEF = void 0;
exports.createSkillShareExecutor = createSkillShareExecutor;
const types_1 = require("../../types");
const Logger_1 = require("../../../utils/Logger");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
exports.SKILL_SHARE_DEF = {
    name: 'skill_share',
    description: 'Skill 分享工具：导出/导入/运行可分享的技能包。USE WHEN: 用户要分享技能、导入别人的技能、运行一个技能包。DO NOT USE WHEN: 用户要创建新技能（用skill_create）。Skill是传播单元：写完分享，别人一个命令就能跑。',
    category: types_1.ToolCategory.NETWORK,
    parameters: {
        action: {
            type: 'string',
            description: '操作类型',
            enum: ['export', 'import', 'run', 'list'],
        },
        skill_name: {
            type: 'string',
            description: '技能名称（export/run 时必填）',
        },
        skill_file: {
            type: 'string',
            description: '技能文件路径（import 时必填）',
        },
        prompt: {
            type: 'string',
            description: '运行技能时的用户输入（run 时可选）',
        },
    },
    requiredParams: ['action'],
    requiredPermissions: [types_1.Permission.FILE_READ, types_1.Permission.FILE_WRITE],
    riskLevel: 'low',
    idempotent: true,
    timeout: 30000,
};
const SKILLS_DIR = path.join(process.cwd(), 'data', 'skills');
function ensureSkillsDir() {
    if (!fs.existsSync(SKILLS_DIR)) {
        fs.mkdirSync(SKILLS_DIR, { recursive: true });
    }
}
function createSkillShareExecutor() {
    return async (params, _context) => {
        const startTime = Date.now();
        const action = String(params.action || '');
        const skillName = String(params.skill_name || '');
        const skillFile = String(params.skill_file || '');
        const prompt = String(params.prompt || '');
        try {
            ensureSkillsDir();
            switch (action) {
                case 'export':
                    return await exportSkill(skillName, startTime);
                case 'import':
                    return await importSkill(skillFile, startTime);
                case 'run':
                    return await runSkill(skillName, prompt, startTime);
                case 'list':
                    return listSkills(startTime);
                default:
                    return {
                        success: false,
                        output: null,
                        error: `未知操作: ${action}。支持: export, import, run, list`,
                        duration: Date.now() - startTime,
                        validated: false,
                    };
            }
        }
        catch (err) {
            return {
                success: false,
                output: null,
                error: `Skill 操作失败: ${err.message}`,
                duration: Date.now() - startTime,
                validated: false,
            };
        }
    };
}
async function exportSkill(name, startTime) {
    const filePath = path.join(SKILLS_DIR, `${name}.json`);
    if (!fs.existsSync(filePath)) {
        return {
            success: false,
            output: null,
            error: `技能 "${name}" 不存在。使用 action=list 查看可用技能。`,
            duration: Date.now() - startTime,
            validated: false,
        };
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const skill = JSON.parse(content);
    // 生成可分享的格式
    const shareable = `<!-- jiabaixing skill: ${skill.name} v${skill.version} -->
# ${skill.name}
${skill.description}

## 触发条件
${skill.trigger}

## 使用工具
${skill.tools.join(', ')}

## 执行步骤
${skill.steps.map((s, i) => `${i + 1}. ${s.description} (${s.tool})`).join('\n')}

## 运行命令
\`\`\`
/skill run ${skill.name}
\`\`\`

---
*由 jiabaixing v5.0 生成*`;
    return {
        success: true,
        output: shareable,
        duration: Date.now() - startTime,
        validated: true,
    };
}
async function importSkill(filePath, startTime) {
    if (!fs.existsSync(filePath)) {
        return {
            success: false,
            output: null,
            error: `文件不存在: ${filePath}`,
            duration: Date.now() - startTime,
            validated: false,
        };
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    let skill;
    try {
        skill = JSON.parse(content);
    }
    catch {
        return {
            success: false,
            output: null,
            error: '文件格式错误：不是有效的 JSON',
            duration: Date.now() - startTime,
            validated: false,
        };
    }
    if (!skill.name || !skill.steps) {
        return {
            success: false,
            output: null,
            error: '技能包缺少必要字段: name, steps',
            duration: Date.now() - startTime,
            validated: false,
        };
    }
    ensureSkillsDir();
    const destPath = path.join(SKILLS_DIR, `${skill.name}.json`);
    fs.writeFileSync(destPath, JSON.stringify(skill, null, 2), 'utf-8');
    Logger_1.Logger.info(`📦 技能导入: ${skill.name}`, 'SkillShare');
    return {
        success: true,
        output: `✅ 技能 "${skill.name}" 导入成功！\n\n描述: ${skill.description}\n步骤: ${skill.steps.length} 步\n工具: ${skill.tools.join(', ')}\n\n运行: /skill run ${skill.name}`,
        duration: Date.now() - startTime,
        validated: true,
    };
}
async function runSkill(name, userPrompt, startTime) {
    const filePath = path.join(SKILLS_DIR, `${name}.json`);
    if (!fs.existsSync(filePath)) {
        return {
            success: false,
            output: null,
            error: `技能 "${name}" 不存在。使用 action=list 查看可用技能。`,
            duration: Date.now() - startTime,
            validated: false,
        };
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const skill = JSON.parse(content);
    // 构建执行指令
    const instruction = `执行技能 "${skill.name}": ${skill.description}

执行步骤:
${skill.steps.map((s, i) => `${i + 1}. ${s.description} (工具: ${s.tool})`).join('\n')}

${skill.prompt ? `特殊指令: ${skill.prompt}` : ''}

用户输入: ${userPrompt || '(无)'}

请按步骤执行，每步调用对应工具，最后汇总结果。`;
    return {
        success: true,
        output: instruction,
        duration: Date.now() - startTime,
        validated: true,
        metadata: {
            skillName: skill.name,
            stepsCount: skill.steps.length,
            tools: skill.tools,
        },
    };
}
function listSkills(startTime) {
    ensureSkillsDir();
    const files = fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith('.json'));
    if (files.length === 0) {
        return {
            success: true,
            output: '暂无已保存的技能。使用 skill_create 创建新技能，或使用 action=import 导入技能包。',
            duration: Date.now() - startTime,
            validated: true,
        };
    }
    const lines = ['📦 已保存的技能:\n'];
    for (const file of files) {
        try {
            const content = fs.readFileSync(path.join(SKILLS_DIR, file), 'utf-8');
            const skill = JSON.parse(content);
            lines.push(`• ${skill.name} v${skill.version || '1.0'}`);
            lines.push(`  ${skill.description}`);
            lines.push(`  步骤: ${skill.steps?.length || 0} | 工具: ${skill.tools?.join(', ') || '无'}`);
            lines.push('');
        }
        catch {
            lines.push(`• ${file} (格式错误)`);
        }
    }
    return {
        success: true,
        output: lines.join('\n'),
        duration: Date.now() - startTime,
        validated: true,
    };
}
