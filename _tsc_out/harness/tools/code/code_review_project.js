"use strict";
/**
 * 项目级代码审查工具 — 多文件审查 + 汇总报告
 *
 * 编排已有工具：
 * 1. file_list 发现目录下代码文件
 * 2. code_review 逐文件审查（四层：语法→逻辑→安全→性能）
 * 3. 汇总 findings，生成项目级结构化报告
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
exports.CODE_REVIEW_PROJECT_DEF = void 0;
exports.createCodeReviewProjectExecutor = createCodeReviewProjectExecutor;
const types_1 = require("../../types");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const code_review_1 = require("./code_review");
exports.CODE_REVIEW_PROJECT_DEF = {
    name: 'code_review_project',
    description: '审查整个项目或目录的代码质量。自动发现代码文件，逐文件审查，生成汇总报告。USE WHEN: 用户要求审查项目、目录、代码库的代码质量或安全。DO NOT USE WHEN: 用户只审查单个文件（用code_review）或要修改代码（用code_fix）。',
    category: types_1.ToolCategory.CODE,
    parameters: {
        path: {
            type: 'string',
            description: '要审查的目录或文件路径',
        },
        focus: {
            type: 'string',
            description: '审查重点',
            enum: ['all', 'security', 'performance', 'quality'],
            default: 'all',
        },
        max_files: {
            type: 'number',
            description: '最多审查的文件数',
            default: 20,
        },
        file_pattern: {
            type: 'string',
            description: '文件名匹配模式，如 "*.ts"、"*.py"',
        },
    },
    requiredParams: ['path'],
    requiredPermissions: [types_1.Permission.FILE_READ, types_1.Permission.CODE_EXECUTE],
    riskLevel: 'low',
    idempotent: true,
    timeout: 120000,
};
// 默认代码文件扩展名
const CODE_EXTENSIONS = new Set([
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.py',
    '.java',
    '.go',
    '.rs',
    '.cpp',
    '.c',
    '.h',
    '.hpp',
    '.cs',
    '.rb',
    '.php',
    '.swift',
    '.kt',
    '.scala',
    '.vue',
    '.svelte',
]);
function collectCodeFiles(dir, maxFiles, filePattern) {
    const results = [];
    function walk(currentDir) {
        if (results.length >= maxFiles)
            return;
        let entries;
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        }
        catch {
            return; // 无权限等
        }
        for (const entry of entries) {
            if (results.length >= maxFiles)
                break;
            const fullPath = path.join(currentDir, entry.name);
            // 跳过常见非代码目录
            if (entry.isDirectory()) {
                if ([
                    'node_modules',
                    '.git',
                    'dist',
                    'build',
                    '__pycache__',
                    '.next',
                    'coverage',
                ].includes(entry.name)) {
                    continue;
                }
                walk(fullPath);
            }
            else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                // 文件名模式匹配
                if (filePattern) {
                    const patternRegex = new RegExp('^' + filePattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$', 'i');
                    if (!patternRegex.test(entry.name))
                        continue;
                }
                if (CODE_EXTENSIONS.has(ext)) {
                    results.push(fullPath);
                }
            }
        }
    }
    walk(dir);
    return results;
}
function aggregateFindings(fileResults) {
    const all = fileResults.flatMap((r) => r.findings);
    const bySeverity = {
        critical: all.filter((f) => f.severity === 'critical'),
        high: all.filter((f) => f.severity === 'high'),
        medium: all.filter((f) => f.severity === 'medium'),
        low: all.filter((f) => f.severity === 'low'),
        info: all.filter((f) => f.severity === 'info'),
    };
    const byCategory = {
        security: all.filter((f) => f.category === 'security'),
        performance: all.filter((f) => f.category === 'performance'),
        quality: all.filter((f) => f.category === 'quality'),
        style: all.filter((f) => f.category === 'style'),
    };
    return { all, bySeverity, byCategory };
}
function formatProjectReport(targetPath, fileResults, focus) {
    const { all, bySeverity, byCategory } = aggregateFindings(fileResults);
    const totalLines = fileResults.reduce((sum, r) => sum + r.totalLines, 0);
    const lines = [];
    lines.push('📋 项目代码审查报告');
    lines.push('━'.repeat(40));
    lines.push(`路径: ${targetPath}`);
    lines.push(`文件数: ${fileResults.length} | 总行数: ${totalLines}`);
    lines.push(`审查重点: ${focus}`);
    lines.push(`总发现: ${all.length} 个`);
    lines.push('');
    if (all.length === 0) {
        lines.push('✅ 所有文件审查通过，未发现问题。');
        return lines.join('\n');
    }
    // 严重度分布
    const sevParts = [];
    if (bySeverity.critical.length)
        sevParts.push(`🔴 严重: ${bySeverity.critical.length}`);
    if (bySeverity.high.length)
        sevParts.push(`🟠 高: ${bySeverity.high.length}`);
    if (bySeverity.medium.length)
        sevParts.push(`🟡 中: ${bySeverity.medium.length}`);
    if (bySeverity.low.length)
        sevParts.push(`🔵 低: ${bySeverity.low.length}`);
    if (bySeverity.info.length)
        sevParts.push(`ℹ️ 信息: ${bySeverity.info.length}`);
    lines.push(sevParts.join('  '));
    lines.push('');
    // 类别分布
    const catParts = [];
    if (byCategory.security.length)
        catParts.push(`安全: ${byCategory.security.length}`);
    if (byCategory.performance.length)
        catParts.push(`性能: ${byCategory.performance.length}`);
    if (byCategory.quality.length)
        catParts.push(`质量: ${byCategory.quality.length}`);
    if (byCategory.style.length)
        catParts.push(`风格: ${byCategory.style.length}`);
    if (catParts.length) {
        lines.push(`按类别: ${catParts.join('  ')}`);
        lines.push('');
    }
    // 各文件详情
    lines.push('━'.repeat(20) + ' 文件详情 ' + '━'.repeat(20));
    lines.push('');
    for (const fileResult of fileResults) {
        if (fileResult.findings.length === 0)
            continue;
        const relativePath = path.relative(targetPath, fileResult.filePath);
        lines.push(`📄 ${relativePath} (${fileResult.totalLines}行)`);
        for (const f of fileResult.findings) {
            const icon = {
                critical: '🔴',
                high: '🟠',
                medium: '🟡',
                low: '🔵',
                info: 'ℹ️',
            }[f.severity];
            const lineRef = f.line ? `:L${f.line}` : '';
            lines.push(`  ${icon} [${f.category}${lineRef}] ${f.message}`);
            lines.push(`     → ${f.suggestion}`);
        }
        lines.push('');
    }
    // 优先修复建议（取 top 5 最严重的问题）
    const topIssues = [...all]
        .sort((a, b) => {
        const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
        return order[a.severity] - order[b.severity];
    })
        .slice(0, 5);
    if (topIssues.length > 0) {
        lines.push('━'.repeat(20) + ' 优先修复建议 ' + '━'.repeat(18));
        lines.push('');
        topIssues.forEach((f, i) => {
            const icon = {
                critical: '🔴',
                high: '🟠',
                medium: '🟡',
                low: '🔵',
                info: 'ℹ️',
            }[f.severity];
            lines.push(`${i + 1}. ${icon} ${f.message}`);
            lines.push(`   → ${f.suggestion}`);
        });
    }
    return lines.join('\n');
}
function createCodeReviewProjectExecutor(deps) {
    const codeReviewExec = (0, code_review_1.createCodeReviewExecutor)(deps);
    return async (params, context) => {
        const startTime = Date.now();
        try {
            const targetPath = String(params.path || '');
            const focus = String(params.focus || 'all');
            const maxFiles = Number(params.max_files) || 20;
            const filePattern = params.file_pattern
                ? String(params.file_pattern)
                : undefined;
            // 路径校验
            if (!fs.existsSync(targetPath)) {
                return {
                    success: false,
                    output: null,
                    error: `路径不存在: ${targetPath}`,
                    duration: Date.now() - startTime,
                    validated: false,
                };
            }
            const stat = fs.statSync(targetPath);
            let files = [];
            if (stat.isFile()) {
                // 单文件直接审查
                files = [targetPath];
            }
            else if (stat.isDirectory()) {
                files = collectCodeFiles(targetPath, maxFiles, filePattern);
            }
            if (files.length === 0) {
                return {
                    success: true,
                    output: `📋 项目代码审查报告\n路径: ${targetPath}\n\n✅ 未找到匹配的代码文件。`,
                    duration: Date.now() - startTime,
                    validated: true,
                    metadata: {
                        filePath: targetPath,
                        findingsCount: 0,
                        filesReviewed: 0,
                    },
                };
            }
            // 逐文件审查
            const fileResults = [];
            for (const file of files) {
                try {
                    const result = await codeReviewExec({ file_path: file, focus }, context);
                    if (result.success && result.metadata) {
                        const meta = result.metadata;
                        fileResults.push({
                            filePath: file,
                            totalLines: meta.totalLines || 0,
                            findings: meta.findings || [],
                        });
                    }
                }
                catch {
                    // 单文件审查失败，跳过
                }
            }
            // 如果 code_review 没有返回 findings 元数据，从 output 解析
            // （code_review 的 output 是格式化文本，metadata 里有 findingsCount 但没有 findings 数组）
            // 所以我们重新运行规则检查来获取结构化数据
            const structuredResults = [];
            for (const file of files) {
                try {
                    const content = fs.readFileSync(file, 'utf-8');
                    const fileLines = content.split('\n');
                    const ext = path.extname(file).toLowerCase();
                    // 复用 code_review 的规则检查逻辑
                    const findings = [];
                    // 规则检查
                    if (ext === '.ts' ||
                        ext === '.js' ||
                        ext === '.tsx' ||
                        ext === '.jsx') {
                        for (let i = 0; i < fileLines.length; i++) {
                            const line = fileLines[i];
                            if (line.includes('console.log') &&
                                !line.trim().startsWith('//')) {
                                findings.push({
                                    severity: 'low',
                                    category: 'quality',
                                    line: i + 1,
                                    message: '生产代码中包含 console.log',
                                    suggestion: '使用 Logger 替代或移除',
                                });
                            }
                            if (line.includes(': any') && !line.trim().startsWith('//')) {
                                findings.push({
                                    severity: 'low',
                                    category: 'quality',
                                    line: i + 1,
                                    message: '使用了 any 类型',
                                    suggestion: '考虑使用更具体的类型定义',
                                });
                            }
                            if (line.match(/catch\s*\(\s*\w*\s*\)\s*\{\s*\}/)) {
                                findings.push({
                                    severity: 'medium',
                                    category: 'quality',
                                    line: i + 1,
                                    message: '空的 catch 块',
                                    suggestion: '至少记录错误日志',
                                });
                            }
                        }
                    }
                    // 安全检查
                    for (let i = 0; i < fileLines.length; i++) {
                        const line = fileLines[i];
                        if (/(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"]{8,}['"]/i.test(line) &&
                            !line.trim().startsWith('//')) {
                            findings.push({
                                severity: 'critical',
                                category: 'security',
                                line: i + 1,
                                message: '检测到硬编码密钥',
                                suggestion: '使用环境变量替代',
                            });
                        }
                        if (/(?:sk-|api_)[a-zA-Z0-9]{20,}/.test(line)) {
                            findings.push({
                                severity: 'critical',
                                category: 'security',
                                line: i + 1,
                                message: '检测到 API 密钥',
                                suggestion: '移除硬编码密钥',
                            });
                        }
                        if (/query\(.*\$\{/i.test(line) && !line.trim().startsWith('//')) {
                            findings.push({
                                severity: 'high',
                                category: 'security',
                                line: i + 1,
                                message: 'SQL 注入风险',
                                suggestion: '使用参数化查询',
                            });
                        }
                        if (/\beval\s*\(/.test(line) && !line.trim().startsWith('//')) {
                            findings.push({
                                severity: 'high',
                                category: 'security',
                                line: i + 1,
                                message: '使用 eval()，代码注入风险',
                                suggestion: '避免使用 eval',
                            });
                        }
                    }
                    if (fileLines.length > 500) {
                        findings.push({
                            severity: 'low',
                            category: 'quality',
                            message: `文件过长 (${fileLines.length} 行)`,
                            suggestion: '考虑拆分',
                        });
                    }
                    structuredResults.push({
                        filePath: file,
                        totalLines: fileLines.length,
                        findings: findings.slice(0, 20),
                    });
                }
                catch {
                    // 读取失败，跳过
                }
            }
            // 生成报告
            const output = formatProjectReport(targetPath, structuredResults, focus);
            const totalFindings = structuredResults.reduce((sum, r) => sum + r.findings.length, 0);
            const criticalCount = structuredResults.reduce((sum, r) => sum + r.findings.filter((f) => f.severity === 'critical').length, 0);
            const highCount = structuredResults.reduce((sum, r) => sum + r.findings.filter((f) => f.severity === 'high').length, 0);
            return {
                success: true,
                output,
                duration: Date.now() - startTime,
                validated: true,
                metadata: {
                    filePath: targetPath,
                    filesReviewed: structuredResults.length,
                    totalLines: structuredResults.reduce((sum, r) => sum + r.totalLines, 0),
                    findingsCount: totalFindings,
                    criticalCount,
                    highCount,
                },
            };
        }
        catch (err) {
            return {
                success: false,
                output: null,
                error: `项目代码审查失败: ${err.message}`,
                duration: Date.now() - startTime,
                validated: false,
            };
        }
    };
}
