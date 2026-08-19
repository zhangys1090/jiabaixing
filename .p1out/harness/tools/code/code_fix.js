"use strict";
/**
 * Harness Tool: code_fix - 修复代码问题
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CODE_FIX_DEF = void 0;
exports.createCodeFixExecutor = createCodeFixExecutor;
const types_1 = require("../../types");
exports.CODE_FIX_DEF = {
    name: 'code_fix',
    description: '修复代码中的错误或问题。适用场景：代码有bug需要修复、代码有安全漏洞需要修补、代码不符合规范需要调整。不适用：生成全新代码（用 code_generate）、仅分析不修复（用 code_analyze）。',
    category: types_1.ToolCategory.CODE,
    parameters: {
        code: {
            type: 'string',
            description: '需要修复的原始代码',
        },
        errorDescription: {
            type: 'string',
            description: '错误描述或修复要求，如"TypeError: Cannot read property of undefined"、"修复SQL注入漏洞"',
        },
        language: {
            type: 'string',
            description: '代码语言，如 typescript、python',
            default: 'typescript',
        },
    },
    requiredParams: ['code', 'errorDescription'],
    requiredPermissions: [types_1.Permission.CODE_EXECUTE, types_1.Permission.FILE_WRITE],
    riskLevel: 'medium',
    idempotent: false,
    timeout: 30000,
    requiresConfirmation: true,
};
/** 创建 code_fix 执行器 */
function createCodeFixExecutor(deps) {
    return async (params, _context) => {
        const code = String(params.code || '');
        const errorDescription = String(params.errorDescription || '');
        const language = params.language || 'typescript';
        if (!deps.fixCode) {
            const result = performBasicFix(code, language);
            const changeList = result.changes
                .map((c) => `- [${c.type}] ${c.description}`)
                .join('\n');
            const note = result.changes.length > 0
                ? `基础修复完成（LLM不可用，仅执行模式匹配修复），变更如下：\n${changeList}\n\n\`\`\`${language}\n${result.fixedCode}\n\`\`\``
                : `基础修复未发现可自动修复的问题（LLM不可用）。建议手动修复或启用LLM服务。`;
            return {
                success: result.changes.length > 0,
                output: note,
                duration: 0,
                validated: false,
                metadata: {
                    changeCount: result.changes.length,
                    language,
                    fallback: true,
                },
            };
        }
        try {
            const result = await deps.fixCode({
                code,
                errorDescription,
                language,
            });
            const changeList = result.changes
                .map((c) => `- [${c.type}] ${c.description}`)
                .join('\n');
            const output = `修复完成，变更如下：\n${changeList}\n\n\`\`\`${language}\n${result.fixedCode}\n\`\`\``;
            return {
                success: true,
                output,
                duration: 0,
                validated: false,
                metadata: {
                    changeCount: result.changes.length,
                    language,
                },
            };
        }
        catch (error) {
            return {
                success: false,
                output: `代码修复失败: ${error.message}`,
                error: error.message,
                duration: 0,
                validated: false,
            };
        }
    };
}
function performBasicFix(code, language) {
    const changes = [];
    let fixed = code;
    const isJsLike = ['typescript', 'javascript', 'ts', 'js'].includes(language.toLowerCase());
    const isPython = ['python', 'py'].includes(language.toLowerCase());
    if (isJsLike) {
        const varRegex = /\bvar\s+/g;
        const varMatches = fixed.match(varRegex);
        if (varMatches) {
            fixed = fixed.replace(/\bvar\s+(\w+)\s*=/g, (_match, name) => {
                const rest = fixed.slice(fixed.indexOf(_match) + _match.length);
                const isReassigned = new RegExp(`\\b${name}\\s*=`).test(rest);
                return `${isReassigned ? 'let' : 'const'} ${name} =`;
            });
            changes.push({
                type: 'improvement',
                description: `替换 var 为 const/let (${varMatches.length}处)`,
            });
        }
        const eqRegex = /([^=!<>])={2}([^=])/g;
        if (eqRegex.test(fixed)) {
            fixed = fixed.replace(/([^=!<>])={2}([^=])/g, '$1===$2');
            changes.push({ type: 'fix', description: '替换 == 为 ===' });
        }
        const lines = fixed.split('\n');
        const fixedLines = [];
        let addedSemi = false;
        for (const line of lines) {
            const trimmed = line.trimEnd();
            if (trimmed.length > 0 &&
                !trimmed.endsWith(';') &&
                !trimmed.endsWith('{') &&
                !trimmed.endsWith('}') &&
                !trimmed.endsWith(',') &&
                !trimmed.endsWith(':') &&
                !trimmed.endsWith(')') &&
                !trimmed.startsWith('//') &&
                !trimmed.startsWith('*') &&
                !trimmed.startsWith('/*')) {
                if (/^(?:const|let|var|return|throw|break|continue|import|export)\s/.test(trimmed) ||
                    /^\w+\.\w+\(.*\)$/.test(trimmed) ||
                    /^\w+\s*=/.test(trimmed)) {
                    fixedLines.push(line + ';');
                    addedSemi = true;
                    continue;
                }
            }
            fixedLines.push(line);
        }
        if (addedSemi) {
            fixed = fixedLines.join('\n');
            changes.push({ type: 'fix', description: '添加缺失的分号' });
        }
    }
    if (isPython) {
        const trailingSemiRegex = /;+\s*$/gm;
        if (trailingSemiRegex.test(fixed)) {
            fixed = fixed.replace(/;+\s*$/gm, '');
            changes.push({
                type: 'improvement',
                description: '移除Python代码中的尾部分号',
            });
        }
    }
    return { fixedCode: fixed, changes };
}
