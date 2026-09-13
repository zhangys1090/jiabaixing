"use strict";
/**
 * Harness Tool: file_grep — 使用系统 grep/ripgrep 快速搜索代码
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FILE_GREP_DEF = void 0;
exports.createFileGrepExecutor = createFileGrepExecutor;
const types_1 = require("../../types");
const Logger_1 = require("../../../utils/Logger");
const child_process_1 = require("child_process");
const util_1 = require("util");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
exports.FILE_GREP_DEF = {
    name: 'file_grep',
    description: '使用系统 grep/ripgrep 在代码库中快速搜索内容，支持正则、文件类型过滤、行数预览等。适用场景：代码搜索、查找引用、定位问题。',
    category: types_1.ToolCategory.FILE,
    parameters: {
        pattern: {
            type: 'string',
            description: '搜索模式（正则或关键字）',
        },
        directory: {
            type: 'string',
            description: '搜索目录路径，默认为项目根目录',
        },
        file_pattern: {
            type: 'string',
            description: '文件类型过滤，例如 *.ts,*.tsx,*.js,*.json',
        },
        ignore_case: {
            type: 'boolean',
            description: '是否忽略大小写',
            default: false,
        },
        show_context: {
            type: 'number',
            description: '显示匹配行的上下文行数',
            default: 2,
        },
        max_results: {
            type: 'number',
            description: '最大返回结果数',
            default: 50,
        },
    },
    requiredParams: ['pattern'],
    requiredPermissions: [types_1.Permission.FILE_READ],
    riskLevel: 'low',
    idempotent: true,
    timeout: 30000,
};
function createFileGrepExecutor(deps = {}) {
    return async (params, _context) => {
        const startTime = Date.now();
        const pattern = String(params.pattern || '');
        const directory = params.directory || deps.projectRoot || process.cwd();
        const filePattern = params.file_pattern || '';
        const ignoreCase = Boolean(params.ignore_case);
        const showContext = Number(params.show_context) || 2;
        const maxResults = Number(params.max_results) || 50;
        if (!pattern) {
            return {
                success: false,
                output: null,
                error: '搜索模式不能为空',
                duration: Date.now() - startTime,
                validated: false,
            };
        }
        try {
            Logger_1.Logger.info(`🔍 file_grep: 搜索模式="${pattern}" 在目录 "${directory}"`, 'FileGrep');
            let result;
            let usedTool;
            // 优先尝试 ripgrep (rg)，更快
            if (deps.useRgPath || (await isCommandAvailable('rg'))) {
                usedTool = 'rg';
                result = await runRipGrep(pattern, directory, {
                    filePattern,
                    ignoreCase,
                    showContext,
                    maxResults,
                    rgPath: deps.useRgPath,
                });
            }
            else {
                usedTool = 'grep';
                result = await runGrep(pattern, directory, {
                    filePattern,
                    ignoreCase,
                    showContext,
                    maxResults,
                });
            }
            return {
                success: true,
                output: `搜索结果 (使用 ${usedTool})\n${result}`,
                duration: Date.now() - startTime,
                validated: false,
                metadata: { tool: usedTool },
            };
        }
        catch (err) {
            Logger_1.Logger.error('❌ file_grep 失败', err, 'FileGrep');
            return {
                success: false,
                output: null,
                error: `搜索失败: ${err.message}`,
                duration: Date.now() - startTime,
                validated: false,
            };
        }
    };
}
async function isCommandAvailable(command) {
    try {
        await execAsync(`${command} --version`, { timeout: 2000 });
        return true;
    }
    catch {
        return false;
    }
}
async function runRipGrep(pattern, directory, options) {
    const args = [
        options.ignoreCase ? '-i' : '',
        `-C` + options.showContext,
        '--color',
        'never',
        '--max-count',
        String(options.maxResults),
    ].filter(Boolean);
    if (options.filePattern) {
        const patterns = options.filePattern.split(',').map((p) => p.trim());
        for (const p of patterns) {
            if (p)
                args.push('-g', p);
        }
    }
    args.push(pattern);
    const rgCmd = options.rgPath || 'rg';
    const { stdout } = await execAsync(`${rgCmd} ${args.join(' ')}`, {
        cwd: directory,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 25000,
    });
    return stdout;
}
async function runGrep(pattern, directory, options) {
    let args = [
        '-r',
        '-n',
        options.ignoreCase ? '-i' : '',
        `-C` + options.showContext,
        '--color=never',
    ].filter(Boolean);
    // 构建文件类型过滤
    if (options.filePattern) {
        const patterns = options.filePattern.split(',').map((p) => p.trim());
        for (const p of patterns) {
            if (p)
                args.push(`--include=${p}`);
        }
    }
    args.push(pattern, '.');
    const { stdout } = await execAsync(`grep ${args.join(' ')}`, {
        cwd: directory,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 25000,
    });
    return stdout;
}
