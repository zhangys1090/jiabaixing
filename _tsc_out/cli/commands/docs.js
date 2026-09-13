"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleDocsCommandCLI = handleDocsCommandCLI;
const Logger_1 = require("../../utils/Logger");
const ipc_1 = require("../ipc");
/**
 * 处理 docs 子命令 — 文档管理
 * 支持: list, generate, view <name>
 * @param subArgs - 子命令参数
 * @param options - 子命令选项
 */
async function handleDocsCommandCLI(subArgs, options) {
    const action = subArgs[0] || 'list';
    switch (action) {
        case 'list': {
            try {
                const data = await (0, ipc_1.requestWithFallback)('docs.list', {}, { path: '/api/docs/index' });
                if (options.json) {
                    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
                }
                else {
                    const docs = data?.docs || [];
                    process.stdout.write(`可用文档 (${docs.length}):\n`);
                    for (const d of docs) {
                        const name = d.name || d.title || JSON.stringify(d);
                        const size = d.size ? ` (${d.size} bytes)` : '';
                        process.stdout.write(`  ${name}${size}\n`);
                    }
                }
            }
            catch (err) {
                Logger_1.Logger.error('获取文档列表失败', err, 'DocsCommand');
                process.stderr.write(`获取文档列表失败: ${err.message}\n`);
                process.exit(1);
            }
            break;
        }
        case 'generate': {
            try {
                const scope = subArgs[1] || 'all';
                const data = await (0, ipc_1.requestWithFallback)('docs.generate', { scope }, { path: '/api/docs/generate', method: 'POST', body: { scope } });
                if (options.json) {
                    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
                }
                else {
                    process.stdout.write(`文档生成: ${data?.message || '完成'}\n`);
                }
            }
            catch (err) {
                Logger_1.Logger.error('生成文档失败', err, 'DocsCommand');
                process.stderr.write(`生成文档失败: ${err.message}\n`);
                process.exit(1);
            }
            break;
        }
        case 'view': {
            const docName = subArgs.slice(1).join(' ');
            if (!docName) {
                process.stderr.write('用法: docs view <文档名称>\n');
                process.exit(1);
            }
            try {
                const data = await (0, ipc_1.requestWithFallback)('docs.view', { name: docName }, { path: `/api/docs/view?name=${encodeURIComponent(docName)}` });
                if (options.json) {
                    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
                }
                else {
                    const content = data?.content;
                    const title = data?.title;
                    if (title) {
                        process.stdout.write(`\n${title}\n${'='.repeat(title.length)}\n\n`);
                    }
                    process.stdout.write(content || '无内容\n');
                }
            }
            catch (err) {
                Logger_1.Logger.error('查看文档失败', err, 'DocsCommand');
                process.stderr.write(`查看文档失败: ${err.message}\n`);
                process.exit(1);
            }
            break;
        }
        default:
            process.stderr.write(`未知 docs 子命令: ${action}。可用: list, generate, view <name>\n`);
            process.exit(1);
    }
}
