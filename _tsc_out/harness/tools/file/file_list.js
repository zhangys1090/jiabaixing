"use strict";
/**
 * Harness Tool: file_list - 列出目录内容
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FILE_LIST_DEF = void 0;
exports.createFileListExecutor = createFileListExecutor;
const types_1 = require("../../types");
const Logger_1 = require("../../../utils/Logger");
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const file_read_1 = require("./file_read");
exports.FILE_LIST_DEF = {
    name: 'file_list',
    description: '列出指定目录下的文件和子目录。适用场景：需要了解项目结构、查找某个目录下有哪些文件、确认文件是否存在。不适用：搜索文件内容（用 file_search）。',
    category: types_1.ToolCategory.FILE,
    parameters: {
        directory: {
            type: 'string',
            description: '要列出的目录路径，默认为项目根目录',
        },
        pattern: {
            type: 'string',
            description: '文件名匹配模式，如 "*.ts"、"src/**"',
            default: '*',
        },
        recursive: {
            type: 'boolean',
            description: '是否递归列出子目录内容',
            default: false,
        },
    },
    requiredParams: [],
    requiredPermissions: [types_1.Permission.FILE_READ],
    riskLevel: 'low',
    idempotent: true,
    timeout: 10000,
};
function matchesPattern(fileName, pattern) {
    if (pattern === '*' || pattern === '**/*')
        return true;
    const regexStr = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${regexStr}$`, 'i').test(fileName);
}
async function listWithFs(directory, pattern, recursive, projectRoot) {
    const resolvedDir = path_1.default.isAbsolute(directory)
        ? directory
        : path_1.default.resolve(projectRoot, directory);
    const results = [];
    async function walkDir(dir, depth) {
        if (recursive && depth > 10)
            return;
        let entries;
        try {
            entries = await promises_1.default.readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.') && entry.name !== '.env.example')
                continue;
            const fullPath = path_1.default.join(dir, entry.name);
            const relativePath = path_1.default.relative(projectRoot, fullPath);
            if (entry.isDirectory()) {
                results.push({
                    name: entry.name,
                    path: relativePath || fullPath,
                    type: 'directory',
                });
                if (recursive) {
                    await walkDir(fullPath, depth + 1);
                }
            }
            else if (entry.isFile() && matchesPattern(entry.name, pattern)) {
                let size;
                try {
                    const stat = await promises_1.default.stat(fullPath);
                    size = stat.size;
                }
                catch {
                    /* best-effort */
                }
                results.push({
                    name: entry.name,
                    path: relativePath || fullPath,
                    type: 'file',
                    size,
                });
            }
        }
    }
    await walkDir(resolvedDir, 0);
    return results;
}
/** 创建 file_list 执行器 */
function createFileListExecutor(deps = {}) {
    return async (params, _context) => {
        const directory = params.directory || '.';
        const pattern = params.pattern || '*';
        const recursive = Boolean(params.recursive);
        // P0-1 沙箱 containment: 越界目录在此抛出，杜绝 file_list 沙箱逃逸。
        // 约束后的 safeDir 同时用于注入分支（deps.listDirectory）与本地 fs 分支（listWithFs）。
        let safeDir;
        try {
            safeDir = (0, file_read_1.resolveWithinRoot)(directory, deps.projectRoot);
        }
        catch (err) {
            Logger_1.Logger.error('❌ file_list 路径越界被拒绝', err, 'FileList');
            return {
                success: false,
                output: `目录列表失败: ${err.message}`,
                error: err.message,
                duration: 0,
                validated: false,
            };
        }
        try {
            let entries;
            if (deps.listDirectory) {
                entries = await deps.listDirectory({
                    directory: safeDir,
                    pattern,
                    recursive,
                });
            }
            else {
                entries = await listWithFs(safeDir, pattern, recursive, deps.projectRoot || process.cwd());
            }
            if (entries.length === 0) {
                return {
                    success: true,
                    output: `目录 "${directory}" 为空或无匹配项`,
                    duration: 0,
                    validated: false,
                };
            }
            const formatted = entries
                .map((e) => `${e.type === 'directory' ? '📁' : '📄'} ${e.path}`)
                .join('\n');
            Logger_1.Logger.info(`📂 file_list 成功: ${directory} (${entries.length}项)`, 'FileList');
            return {
                success: true,
                output: formatted,
                duration: 0,
                validated: false,
                metadata: {
                    totalFiles: entries.filter((e) => e.type === 'file').length,
                    totalDirs: entries.filter((e) => e.type === 'directory').length,
                },
            };
        }
        catch (error) {
            Logger_1.Logger.error('❌ file_list 失败', error, 'FileList');
            return {
                success: false,
                output: `目录列表失败: ${error.message}`,
                error: error.message,
                duration: 0,
                validated: false,
            };
        }
    };
}
