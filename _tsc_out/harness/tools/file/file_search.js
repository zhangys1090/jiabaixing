"use strict";
/**
 * Harness Tool: file_search - 在文件内容中搜索关键词
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FILE_SEARCH_DEF = void 0;
exports.createFileSearchExecutor = createFileSearchExecutor;
const types_1 = require("../../types");
const Logger_1 = require("../../../utils/Logger");
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
exports.FILE_SEARCH_DEF = {
    name: 'file_search',
    description: '在文件内容中搜索关键词或模式。适用场景：查找某个函数定义、搜索包含特定文本的文件、定位代码中的某个配置项。不适用：按文件名查找（用 file_list）。',
    category: types_1.ToolCategory.FILE,
    parameters: {
        query: {
            type: 'string',
            description: '搜索关键词或正则表达式',
        },
        directory: {
            type: 'string',
            description: '搜索目录路径，默认为项目根目录',
        },
        filePattern: {
            type: 'string',
            description: '文件匹配模式，如 "*.ts"、"*.json"',
            default: '*',
        },
        maxResults: {
            type: 'number',
            description: '最大返回结果数，默认20',
            default: 20,
        },
    },
    requiredParams: ['query'],
    requiredPermissions: [types_1.Permission.FILE_READ],
    riskLevel: 'low',
    idempotent: true,
    timeout: 15000,
};
const SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    '.next',
    'coverage',
    '__pycache__',
    '.cache',
    'tmp',
    'data',
]);
function matchesFilePattern(fileName, pattern) {
    if (pattern === '*' || pattern === '**/*')
        return true;
    const ext = pattern.replace('*.', '');
    if (fileName.endsWith(`.${ext}`))
        return true;
    const regexStr = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${regexStr}$`, 'i').test(fileName);
}
async function searchWithFs(query, directory, filePattern, maxResults, projectRoot) {
    const results = [];
    let regex;
    try {
        regex = new RegExp(query, 'gi');
    }
    catch {
        const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        regex = new RegExp(escaped, 'gi');
    }
    async function walkAndSearch(dir, depth) {
        if (results.length >= maxResults)
            return;
        if (depth > 15)
            return;
        let entries;
        try {
            entries = await promises_1.default.readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (results.length >= maxResults)
                return;
            const fullPath = path_1.default.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name))
                    continue;
                await walkAndSearch(fullPath, depth + 1);
            }
            else if (entry.isFile() &&
                matchesFilePattern(entry.name, filePattern)) {
                try {
                    const stat = await promises_1.default.stat(fullPath);
                    if (stat.size > 1024 * 1024)
                        continue;
                    const content = await promises_1.default.readFile(fullPath, 'utf-8');
                    const lines = content.split('\n');
                    for (let i = 0; i < lines.length && results.length < maxResults; i++) {
                        regex.lastIndex = 0;
                        if (regex.test(lines[i])) {
                            const relativePath = path_1.default.relative(projectRoot, fullPath);
                            results.push({
                                filePath: relativePath || fullPath,
                                line: i + 1,
                                content: lines[i].trim().substring(0, 200),
                                match: lines[i].trim().substring(0, 100),
                            });
                        }
                    }
                }
                catch {
                    /* skip unreadable files */
                }
            }
        }
    }
    await walkAndSearch(directory, 0);
    return results;
}
/** 创建 file_search 执行器 */
function createFileSearchExecutor(deps = {}) {
    return async (params, _context) => {
        const startTime = Date.now();
        const query = String(params.query || '');
        const directory = params.directory || '.';
        const filePattern = params.filePattern || '*';
        const maxResults = Number(params.maxResults) || 20;
        if (!query) {
            return {
                success: false,
                output: null,
                error: '搜索关键词不能为空',
                duration: Date.now() - startTime,
                validated: false,
            };
        }
        try {
            // Validate directory exists
            const resolvedDir = path_1.default.isAbsolute(directory)
                ? directory
                : path_1.default.resolve(deps.projectRoot || process.cwd(), directory);
            let dirStat;
            try {
                dirStat = await promises_1.default.stat(resolvedDir);
            }
            catch {
                Logger_1.Logger.warn(`file_search: 目录不存在或无法访问 "${resolvedDir}"`, 'FileSearch');
                return {
                    success: false,
                    output: `搜索目录不存在: "${directory}"`,
                    error: `Directory not found: ${resolvedDir}`,
                    duration: Date.now() - startTime,
                    validated: false,
                };
            }
            if (!dirStat.isDirectory()) {
                return {
                    success: false,
                    output: `搜索路径不是一个目录: "${directory}"`,
                    error: `Path is not a directory: ${resolvedDir}`,
                    duration: Date.now() - startTime,
                    validated: false,
                };
            }
            let results;
            if (deps.searchInFiles) {
                results = await deps.searchInFiles({
                    query,
                    directory,
                    filePattern,
                    maxResults,
                });
            }
            else {
                results = await searchWithFs(query, resolvedDir, filePattern, maxResults, deps.projectRoot || process.cwd());
            }
            if (results.length === 0) {
                return {
                    success: true,
                    output: `未找到包含"${query}"的内容`,
                    duration: Date.now() - startTime,
                    validated: false,
                };
            }
            const formatted = results
                .map((r, i) => `${i + 1}. ${r.filePath}:${r.line} — ${r.match}`)
                .join('\n');
            Logger_1.Logger.info(`🔍 file_search 成功: "${query}" (${results.length}结果)`, 'FileSearch');
            return {
                success: true,
                output: formatted,
                duration: Date.now() - startTime,
                validated: false,
                metadata: { resultCount: results.length },
            };
        }
        catch (error) {
            Logger_1.Logger.error('❌ file_search 失败', error, 'FileSearch');
            return {
                success: false,
                output: `搜索失败: ${error.message}`,
                error: error.message,
                duration: Date.now() - startTime,
                validated: false,
            };
        }
    };
}
