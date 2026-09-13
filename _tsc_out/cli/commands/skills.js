"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleSkillsCommand = handleSkillsCommand;
exports.handleSkillCommand = handleSkillCommand;
const Logger_1 = require("../../utils/Logger");
const constants_1 = require("../constants");
const ipc_1 = require("../ipc");
const utils_1 = require("../utils");
/**
 * 处理 /skills 命令（REPL 模式）
 * 显示技能列表
 */
async function handleSkillsCommand() {
    try {
        const data = await (0, ipc_1.requestWithFallback)('skill.list', {}, { path: '/api/skills/list' });
        Logger_1.Logger.info(`\n  ${constants_1.COLORS.bold}技能列表 (${data.count || 0})${constants_1.COLORS.reset}\n`, 'CLI');
        if (data.skills) {
            for (const skill of data.skills) {
                Logger_1.Logger.info(`  ${constants_1.COLORS.cyan}■${constants_1.COLORS.reset} ${constants_1.COLORS.bold}${skill.name}${constants_1.COLORS.reset}`, 'CLI');
                Logger_1.Logger.info(`    ${constants_1.COLORS.dim}${skill.description.substring(0, 80)}${skill.description.length > 80 ? '...' : ''}${constants_1.COLORS.reset}`, 'CLI');
                Logger_1.Logger.info(`    ${constants_1.COLORS.yellow}分类: ${skill.category}${constants_1.COLORS.reset}\n`, 'CLI');
            }
        }
    }
    catch {
        Logger_1.Logger.info(`  ${(0, constants_1.c)(constants_1.COLORS.red, '❌ 获取技能列表失败')}`, 'CLI');
    }
    Logger_1.Logger.info('', 'CLI');
}
/**
 * 处理 skill 子命令 — 技能管理
 * @param subArgs - 子命令参数
 * @param options - 子命令选项
 */
async function handleSkillCommand(subArgs, options) {
    const action = subArgs[0] || 'list';
    switch (action) {
        case 'list': {
            try {
                let data;
                // 优先尝试 IPC
                try {
                    const ipcResult = await (0, ipc_1.ipcSend)('skill.list');
                    data = ipcResult;
                }
                catch {
                    Logger_1.Logger.warn('IPC 不可用，降级到 HTTP', 'IPC');
                    const resp = await fetch(`${constants_1.backendUrl}/api/skills/list`);
                    data = (await resp.json());
                }
                if (options.json) {
                    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
                }
                else {
                    const skills = data.skills || [];
                    if (!options.quiet) {
                        process.stdout.write(`技能列表 (${data.count || skills.length})\n\n`);
                    }
                    for (const skill of skills) {
                        process.stdout.write(`  ${skill.name}  ${skill.description.substring(0, 60)}  [${skill.category}]\n`);
                    }
                }
            }
            catch (err) {
                Logger_1.Logger.error('获取技能列表失败', err, 'SkillCommand');
                process.stderr.write(`获取技能列表失败: ${err.message}\n`);
                process.exit(1);
            }
            break;
        }
        case 'execute': {
            const skillName = subArgs[1];
            if (!skillName) {
                process.stderr.write('错误: skill execute 需要提供技能名称\n');
                process.exit(1);
            }
            let params = {};
            if (subArgs[2]) {
                try {
                    params = JSON.parse(subArgs[2]);
                }
                catch {
                    params = { query: subArgs.slice(2).join(' ') };
                }
            }
            Logger_1.Logger.info(`执行技能: ${skillName}`, 'SkillCommand');
            try {
                let data;
                try {
                    const ipcResult = await (0, ipc_1.ipcSend)('skill.execute', {
                        skillName,
                        params,
                    });
                    data = ipcResult;
                }
                catch {
                    Logger_1.Logger.warn('IPC 不可用，降级到 HTTP', 'IPC');
                    const resp = await fetch(`${constants_1.backendUrl}/api/skills/execute`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ skillName, params }),
                        signal: AbortSignal.timeout(120000),
                    });
                    data = (await resp.json());
                }
                if (options.json) {
                    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
                }
                else {
                    const output = data.output ||
                        data.error ||
                        JSON.stringify(data);
                    process.stdout.write((0, utils_1.stripAnsi)(output) + '\n');
                }
            }
            catch (err) {
                Logger_1.Logger.error('技能执行失败', err, 'SkillCommand');
                process.stderr.write(`技能执行失败: ${err.message}\n`);
                process.exit(1);
            }
            break;
        }
        default:
            process.stderr.write(`未知 skill 子命令: ${action}\n`);
            process.stderr.write('用法: skill list | skill execute <名称> [参数]\n');
            process.exit(1);
    }
}
