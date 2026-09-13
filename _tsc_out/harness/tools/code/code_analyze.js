"use strict";
/**
 * Harness Tool: code_analyze - 分析代码质量和安全
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CODE_ANALYZE_DEF = void 0;
exports.createCodeAnalyzeExecutor = createCodeAnalyzeExecutor;
const types_1 = require("../../types");
exports.CODE_ANALYZE_DEF = {
    name: 'code_analyze',
    description: '分析代码的质量、安全和性能问题。适用场景：用户要求代码审查、检查潜在bug、评估代码质量。不适用：生成新代码（用 code_generate）、修复代码（用 code_fix）。',
    category: types_1.ToolCategory.CODE,
    parameters: {
        code: {
            type: 'string',
            description: '要分析的代码内容',
        },
        language: {
            type: 'string',
            description: '代码语言，如 typescript、python、java',
            default: 'typescript',
        },
        analysisType: {
            type: 'string',
            description: '分析类型: comprehensive=综合分析, security=安全检查, performance=性能分析',
            enum: ['comprehensive', 'security', 'performance'],
            default: 'comprehensive',
        },
    },
    requiredParams: ['code'],
    requiredPermissions: [types_1.Permission.CODE_EXECUTE],
    riskLevel: 'low',
    idempotent: true,
    timeout: 20000,
};
/** 创建 code_analyze 执行器 */
function createCodeAnalyzeExecutor(deps) {
    return async (params, _context) => {
        const code = String(params.code || '');
        const language = params.language || 'typescript';
        const analysisType = params.analysisType || 'comprehensive';
        if (!deps.analyzeCode) {
            // 降级：基础静态分析
            const issues = performBasicAnalysis(code, analysisType);
            return {
                success: true,
                output: formatAnalysisResult(issues, 0, '基础静态分析（LLM分析不可用）'),
                duration: 0,
                validated: false,
                metadata: { analysisType, fallback: true },
            };
        }
        try {
            const result = await deps.analyzeCode({
                code,
                language,
                analysisType,
            });
            return {
                success: true,
                output: formatAnalysisResult(result.issues, result.score, result.summary),
                duration: 0,
                validated: false,
                metadata: {
                    analysisType,
                    score: result.score,
                    issueCount: result.issues.length,
                },
            };
        }
        catch (error) {
            return {
                success: false,
                output: `代码分析失败: ${error.message}`,
                error: error.message,
                duration: 0,
                validated: false,
            };
        }
    };
}
/** 基础静态分析（降级方案） */
function performBasicAnalysis(code, analysisType) {
    const issues = [];
    const lines = code.split('\n');
    lines.forEach((line, i) => {
        const lineNum = i + 1;
        const trimmed = line.trim();
        if (analysisType === 'comprehensive' || analysisType === 'security') {
            if (/\beval\s*\(/.test(trimmed)) {
                issues.push({
                    severity: 'error',
                    message: '检测到 eval() 使用，存在代码注入风险',
                    line: lineNum,
                });
            }
            if (/innerHTML\s*=/.test(trimmed) && !/sanitize/.test(trimmed)) {
                issues.push({
                    severity: 'warning',
                    message: '直接赋值 innerHTML，存在 XSS 风险',
                    line: lineNum,
                });
            }
            if (/password|secret|api[_-]?key/i.test(trimmed) && /=/.test(trimmed)) {
                issues.push({
                    severity: 'warning',
                    message: '可能包含硬编码的敏感信息',
                    line: lineNum,
                });
            }
        }
        if (analysisType === 'comprehensive' || analysisType === 'performance') {
            if (trimmed.length > 120) {
                issues.push({
                    severity: 'info',
                    message: '行长度超过120字符，建议拆分',
                    line: lineNum,
                });
            }
        }
        if (analysisType === 'comprehensive') {
            if (/catch\s*\(\w*\)\s*\{\s*\}/.test(trimmed)) {
                issues.push({
                    severity: 'warning',
                    message: '空 catch 块，错误被静默吞没',
                    line: lineNum,
                });
            }
            if (/console\.(log|error|warn)\(/.test(trimmed)) {
                issues.push({
                    severity: 'info',
                    message: '检测到 console 输出，生产环境应使用 Logger',
                    line: lineNum,
                });
            }
        }
    });
    return issues;
}
/** 格式化分析结果 */
function formatAnalysisResult(issues, score, summary) {
    const severityIcon = {
        error: '❌',
        warning: '⚠️',
        info: 'ℹ️',
    };
    const issueList = issues
        .map((issue) => `${severityIcon[issue.severity] || '•'} [${issue.severity.toUpperCase()}]${issue.line ? ` L${issue.line}` : ''} ${issue.message}`)
        .join('\n');
    return `${summary}\n\n${issueList}${score > 0 ? `\n\n质量评分: ${score}/100` : ''}`;
}
