"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FILE_READ_DEF = void 0;
exports.createFileReadExecutor = createFileReadExecutor;
const promises_1 = __importDefault(require("fs/promises"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const Logger_1 = require("../../../utils/Logger");
const types_1 = require("../../types");
exports.FILE_READ_DEF = {
    name: 'file_read',
    description: '读取指定文件的内容。适用场景：查看源代码文件、读取配置文件、获取文档内容。不适用：列出目录内容（用 file_list）、搜索文件（用 file_search）。',
    category: types_1.ToolCategory.FILE,
    parameters: {
        file_path: {
            type: 'string',
            description: '要读取的文件路径（绝对路径或相对于项目根目录的路径）',
        },
        encoding: {
            type: 'string',
            description: '文件编码格式',
            enum: ['utf-8', 'ascii', 'base64', 'hex'],
            default: 'utf-8',
        },
        offset: {
            type: 'number',
            description: '起始行号（从1开始），用于读取文件的部分内容',
            default: 1,
        },
        limit: {
            type: 'number',
            description: '最多读取的行数，0表示读取全部',
            default: 0,
        },
        line_numbers: {
            type: 'boolean',
            description: '是否在每行前标注行号',
            default: false,
        },
    },
    requiredParams: ['file_path'],
    requiredPermissions: [types_1.Permission.FILE_READ],
    riskLevel: 'low',
    idempotent: true,
    timeout: 10000,
};
const MAX_FILE_SIZE = 2 * 1024 * 1024;
const MAX_OUTPUT_LENGTH = 50000;
const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
    '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flv',
    '.zip', '.tar', '.gz', '.rar', '.7z', '.bz2',
    '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.sqlite', '.db', '.mdb',
]);

function isBinaryFile(filePath) {
    const ext = path_1.default.extname(filePath).toLowerCase();
    return BINARY_EXTENSIONS.has(ext);
}
/** Windows 路径兼容：将 Unix 风格路径转换为当前平台兼容路径 */
function normalizePath(rawPath) {
    // /tmp/ → Windows 临时目录
    if (rawPath.startsWith('/tmp/')) {
        const tmpDir = os_1.default.tmpdir().replace(/\\/g, '/');
        return rawPath.replace('/tmp/', tmpDir + '/');
    }
    // /home/user/ → USERPROFILE
    if (rawPath.startsWith('/home/') && process.platform === 'win32') {
        const home = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Default';
        return rawPath.replace(/^\/home\/[^/]+\//, home.replace(/\\/g, '/') + '/');
    }
    return rawPath;
}
function createFileReadExecutor(deps = {}) {
    return async (params, _context) => {
        const startTime = Date.now();
        let rawPath = normalizePath(String(params.file_path || ''));
        const encoding = String(params.encoding || 'utf-8');
        const offset = Math.max(1, Number(params.offset) || 1);
        const limit = Number(params.limit) || 0;
        const lineNumbers = params.line_numbers === true;
        if (!rawPath) {
            return {
                success: false,
                output: null,
                error: '文件路径不能为空',
                duration: Date.now() - startTime,
                validated: false,
            };
        }
        if (isBinaryFile(rawPath)) {
            return {
                success: false,
                output: null,
                error: `文件 "${rawPath}" 是二进制文件，无法以文本方式读取。请使用 file_list 查看目录或使用专用工具处理此文件类型。`,
                duration: Date.now() - startTime,
                validated: false,
            };
        }
        try {
            let content;
            if (deps.readFileContent) {
                content = await deps.readFileContent(rawPath);
            }
            else {
                let resolvedPath = path_1.default.isAbsolute(rawPath)
                    ? rawPath
                    : path_1.default.resolve(deps.projectRoot || process.cwd(), rawPath);
                // 自动修正: 尝试常见路径变体
                let statResult = null;
                const pathCandidates = [resolvedPath];
                if (!path_1.default.isAbsolute(rawPath)) {
                    pathCandidates.push(path_1.default.resolve(process.cwd(), rawPath), path_1.default.resolve(process.cwd(), 'src', rawPath));
                }
                for (const candidate of pathCandidates) {
                    try {
                        statResult = await promises_1.default.stat(candidate);
                        resolvedPath = candidate;
                        break;
                    }
                    catch {
                        continue;
                    }
                }
                if (!statResult) {
                    await promises_1.default.stat(resolvedPath);
                }
                else if (statResult.size > MAX_FILE_SIZE) {
                    return {
                        success: false,
                        output: null,
                        error: `文件过大 (${(Number(statResult.size) / 1024 / 1024).toFixed(1)}MB)，超过最大限制 2MB。请使用 offset 和 limit 参数分段读取。`,
                        duration: Date.now() - startTime,
                        validated: false,
                    };
                }
                content = await promises_1.default.readFile(resolvedPath, {
                    encoding: encoding,
                });
            }
            if (limit > 0 || offset > 1) {
                const lines = content.split('\n');
                const startLine = offset - 1;
                const endLine = limit > 0 ? startLine + limit : lines.length;
                const selectedLines = lines.slice(startLine, endLine);
                if (lineNumbers) {
                    content = selectedLines
                        .map((line, i) => `${startLine + i + 1}→${line}`)
                        .join('\n');
                } else {
                    content = selectedLines.join('\n');
                }
            }
            else if (lineNumbers) {
                const lines = content.split('\n');
                content = lines.map((line, i) => `${i + 1}→${line}`).join('\n');
            }
            if (content.length > MAX_OUTPUT_LENGTH) {
                content =
                    content.substring(0, MAX_OUTPUT_LENGTH) + '\n\n... (内容已截断)';
            }
            Logger_1.Logger.info(`📄 file_read 成功: ${rawPath} (${content.length}字符)`, 'FileRead');
            return {
                success: true,
                output: content,
                duration: Date.now() - startTime,
                validated: false,
                metadata: { filePath: rawPath, encoding, offset, limit },
            };
        }
        catch (err) {
            const error = err;
            let userMessage;
            if (error.code === 'ENOENT') {
                userMessage = `文件不存在: ${rawPath}`;
            }
            else if (error.code === 'EACCES') {
                userMessage = `权限不足，无法读取文件: ${rawPath}`;
            }
            else if (error.code === 'EISDIR') {
                userMessage = `路径是目录而非文件: ${rawPath}，请使用 file_list 工具列出目录内容`;
            }
            else {
                userMessage = `读取文件失败: ${error.message}`;
            }
            Logger_1.Logger.error('❌ file_read 失败', error, 'FileRead');
            return {
                success: false,
                output: null,
                error: userMessage,
                duration: Date.now() - startTime,
                validated: false,
            };
        }
    };
}
