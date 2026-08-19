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
        sort_by: {
            type: 'string',
            description: '排序方式',
            enum: ['name', 'size', 'type', 'path'],
            default: 'name',
        },
        max_depth: {
            type: 'number',
            description: '递归最大深度（默认10）',
            default: 10,
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
async function listWithFs(directory, pattern, recursive, projectRoot, maxDepth = 10) {
    const resolvedDir = path_1.default.isAbsolute(directory)
        ? directory
        : path_1.default.resolve(projectRoot, directory);
    const results = [];
    async function walkDir(dir, depth) {
        if (recursive && depth > maxDepth) return;
        let entries;
        try {
            entries = await promises_1.default.readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.') && entry.name !== '.env.example' && entry.name !== '.env' && entry.name !== '.gitignore' && entry.name !== '.eslintrc.js' && entry.name !== '.prettierrc.js')
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
        const sortBy = String(params.sort_by || 'name');
        const maxDepth = Math.min(20, Math.max(1, Number(params.max_depth) || 10));
        try {
            let entries;
            if (deps.listDirectory) {
                entries = await deps.listDirectory({
                    directory,
                    pattern,
                    recursive,
                });
            }
            else {
                entries = await listWithFs(directory, pattern, recursive, deps.projectRoot || process.cwd(), maxDepth);
            }
            if (entries.length === 0) {
                return {
                    success: true,
                    output: `目录 "${directory}" 为空或无匹配项`,
                    duration: 0,
                    validated: false,
                };
            }
            entries.sort((a, b) => {
                switch (sortBy) {
                    case 'size':
                        return (b.size || 0) - (a.size || 0);
                    case 'type':
                        return a.type.localeCompare(b.type) || a.name.localeCompare(b.name);
                    case 'path':
                        return a.path.localeCompare(b.path);
                    case 'name':
                    default:
                        return a.name.localeCompare(b.name);
                }
            });
            const formatted = entries
                .map((e) => {
                const sizeStr = e.size != null ? ` (${formatSize(e.size)})` : '';
                return `${e.type === 'directory' ? '📁' : '📄'} ${e.path}${sizeStr}`;
            })
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
                    sortBy,
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

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
