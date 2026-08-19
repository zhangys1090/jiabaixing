"use strict";
/**
 * Harness Tool: osv_scan - 依赖漏洞扫描
 *
 * 使用 OSV (Open Source Vulnerabilities) 数据库
 * 扫描项目依赖中的已知安全漏洞。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OSV_SCAN_DEF = void 0;
exports.createOsvScanExecutor = createOsvScanExecutor;
const child_process_1 = require("child_process");
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const util_1 = require("util");
const Logger_1 = require("../../../utils/Logger");
const types_1 = require("../../types");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
exports.OSV_SCAN_DEF = {
    name: 'osv_scan',
    description: '扫描项目依赖中的已知安全漏洞（基于OSV数据库）。适用场景：安全审计、依赖升级决策、CI/CD安全检查。不适用：代码逻辑漏洞检测。',
    category: types_1.ToolCategory.SYSTEM,
    parameters: {
        directory: {
            type: 'string',
            description: '项目根目录路径，默认为当前工作目录',
        },
        lockfile: {
            type: 'string',
            description: '指定锁文件路径（package-lock.json/yarn.lock/pnpm-lock.yaml），不填则自动检测',
        },
        severity: {
            type: 'string',
            description: '最低严重级别过滤: LOW|MEDIUM|HIGH|CRITICAL',
            default: 'MEDIUM',
        },
        format: {
            type: 'string',
            description: '输出格式: summary|json|table',
            default: 'summary',
        },
    },
    requiredParams: [],
    requiredPermissions: [types_1.Permission.FILE_READ, types_1.Permission.NETWORK_ACCESS],
    riskLevel: 'low',
    idempotent: true,
    timeout: 60000,
};
const SEVERITY_ORDER = {
    LOW: 1,
    MEDIUM: 2,
    HIGH: 3,
    CRITICAL: 4,
};
async function detectLockfile(projectRoot) {
    const candidates = [
        'package-lock.json',
        'yarn.lock',
        'pnpm-lock.yaml',
        'composer.lock',
        'Gemfile.lock',
        'requirements.txt',
        'Pipfile.lock',
        'go.sum',
        'Cargo.lock',
    ];
    for (const file of candidates) {
        try {
            await promises_1.default.access(path_1.default.join(projectRoot, file));
            return file;
        }
        catch {
            continue;
        }
    }
    return null;
}
async function parsePackageJson(projectRoot) {
    try {
        const content = await promises_1.default.readFile(path_1.default.join(projectRoot, 'package.json'), 'utf-8');
        const pkg = JSON.parse(content);
        const deps = [];
        for (const [name, version] of Object.entries(pkg.dependencies || {})) {
            deps.push({ name, version: String(version).replace(/^[\^~]/, '') });
        }
        for (const [name, version] of Object.entries(pkg.devDependencies || {})) {
            deps.push({ name, version: String(version).replace(/^[\^~]/, '') });
        }
        return deps;
    }
    catch {
        return [];
    }
}
async function runOsvScanner(projectRoot, lockfilePath) {
    try {
        const lockArg = lockfilePath ? `--lockfile=${lockfilePath}` : '';
        const { stdout, stderr } = await execAsync(`osv-scanner scan ${lockArg} --format=json "${projectRoot}"`, {
            cwd: projectRoot,
            timeout: 45000,
        });
        return { stdout, stderr };
    }
    catch (err) {
        const e = err;
        if (e.stdout) {
            return { stdout: e.stdout, stderr: e.stderr || '' };
        }
        throw err;
    }
}
function parseOsvOutput(stdout) {
    const vulns = [];
    try {
        const result = JSON.parse(stdout);
        const results = result.results || [];
        for (const r of results) {
            const packages = r.packages || [];
            for (const pkg of packages) {
                const vulnList = pkg.vulnerabilities || [];
                for (const v of vulnList) {
                    const severity = v.database_specific?.severity || v.severity?.[0]?.score || 'MEDIUM';
                    let fixedIn;
                    if (v.affected?.[0]?.ranges?.[0]?.events) {
                        for (const event of v.affected[0].ranges[0].events) {
                            if (event.fixed) {
                                fixedIn = event.fixed;
                                break;
                            }
                        }
                    }
                    vulns.push({
                        id: v.id || 'UNKNOWN',
                        package: pkg.package?.name || r.source?.path || 'unknown',
                        version: pkg.package?.version || 'unknown',
                        severity: typeof severity === 'string' ? severity.toUpperCase() : 'MEDIUM',
                        summary: v.summary || v.details?.substring(0, 200) || 'No description',
                        fixedIn,
                        url: v.references?.[0]?.url,
                    });
                }
            }
        }
    }
    catch {
        // JSON parse failed, return empty
    }
    return vulns;
}
async function fallbackScan(projectRoot) {
    const deps = await parsePackageJson(projectRoot);
    if (deps.length === 0)
        return [];
    const vulns = [];
    for (const dep of deps.slice(0, 50)) {
        try {
            const url = `https://api.osv.dev/v1/query`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    package: { name: dep.name, ecosystem: 'npm' },
                    version: dep.version,
                }),
            });
            if (!response.ok)
                continue;
            const data = await response.json();
            const vulnList = data.vulns || [];
            for (const v of vulnList) {
                const severity = v.database_specific?.severity || v.severity?.[0]?.score || 'MEDIUM';
                let fixedIn;
                if (v.affected?.[0]?.ranges?.[0]?.events) {
                    for (const event of v.affected[0].ranges[0].events) {
                        if (event.fixed) {
                            fixedIn = event.fixed;
                            break;
                        }
                    }
                }
                vulns.push({
                    id: v.id,
                    package: dep.name,
                    version: dep.version,
                    severity: typeof severity === 'string' ? severity.toUpperCase() : 'MEDIUM',
                    summary: v.summary || 'No description',
                    fixedIn,
                    url: v.references?.[0]?.url,
                });
            }
        }
        catch {
            continue;
        }
    }
    return vulns;
}
function createOsvScanExecutor(deps) {
    return async (params, _context) => {
        const startTime = Date.now();
        const directory = params.directory || '.';
        const lockfile = params.lockfile;
        const minSeverity = (params.severity || 'MEDIUM').toUpperCase();
        const outputFormat = params.format || 'summary';
        const projectRoot = path_1.default.isAbsolute(directory)
            ? directory
            : path_1.default.resolve(deps?.projectRoot || process.cwd(), directory);
        try {
            Logger_1.Logger.info(`🛡️ osv_scan 开始: ${projectRoot}`, 'OsvScan');
            let vulns;
            // 先尝试 osv-scanner CLI
            try {
                const lockfilePath = lockfile || (await detectLockfile(projectRoot)) || undefined;
                const { stdout } = await runOsvScanner(projectRoot, lockfilePath);
                vulns = parseOsvOutput(stdout);
            }
            catch {
                // CLI 不可用，使用 API 回退
                Logger_1.Logger.info('🛡️ osv-scanner CLI 不可用，使用 API 回退', 'OsvScan');
                vulns = await fallbackScan(projectRoot);
            }
            // 按严重级别过滤
            const minOrder = SEVERITY_ORDER[minSeverity] || 2;
            const filtered = vulns.filter((v) => (SEVERITY_ORDER[v.severity] || 2) >= minOrder);
            // 按严重级别排序
            filtered.sort((a, b) => (SEVERITY_ORDER[b.severity] || 2) - (SEVERITY_ORDER[a.severity] || 2));
            if (outputFormat === 'json') {
                return {
                    success: true,
                    output: JSON.stringify(filtered, null, 2),
                    duration: Date.now() - startTime,
                    validated: false,
                    metadata: {
                        totalVulns: filtered.length,
                        critical: filtered.filter((v) => v.severity === 'CRITICAL').length,
                        high: filtered.filter((v) => v.severity === 'HIGH').length,
                        medium: filtered.filter((v) => v.severity === 'MEDIUM').length,
                        low: filtered.filter((v) => v.severity === 'LOW').length,
                    },
                };
            }
            const severityIcon = {
                CRITICAL: '🔴',
                HIGH: '🟠',
                MEDIUM: '🟡',
                LOW: '🟢',
            };
            const lines = filtered.slice(0, 50).map((v) => {
                const icon = severityIcon[v.severity] || '⚪';
                const fixed = v.fixedIn ? ` → 修复版本: ${v.fixedIn}` : '';
                return `${icon} [${v.severity}] ${v.package}@${v.version} — ${v.id}\n   ${v.summary.substring(0, 120)}${fixed}`;
            });
            const counts = {
                critical: filtered.filter((v) => v.severity === 'CRITICAL').length,
                high: filtered.filter((v) => v.severity === 'HIGH').length,
                medium: filtered.filter((v) => v.severity === 'MEDIUM').length,
                low: filtered.filter((v) => v.severity === 'LOW').length,
            };
            const output = [
                `🛡️ 依赖漏洞扫描报告`,
                `📂 项目: ${projectRoot}`,
                '',
                `📊 漏洞统计: 🔴严重:${counts.critical} 🟠高危:${counts.high} 🟡中危:${counts.medium} 🟢低危:${counts.low}`,
                '',
                ...(filtered.length > 0 ? lines : ['✅ 未发现已知漏洞']),
                '',
                filtered.length > 0
                    ? '💡 建议: 优先修复 CRITICAL 和 HIGH 级别漏洞，升级到修复版本'
                    : '💡 建议: 定期运行漏洞扫描，保持依赖更新',
            ].join('\n');
            Logger_1.Logger.info(`🛡️ osv_scan 完成: ${filtered.length}个漏洞 (${Date.now() - startTime}ms)`, 'OsvScan');
            return {
                success: true,
                output,
                duration: Date.now() - startTime,
                validated: false,
                metadata: counts,
            };
        }
        catch (error) {
            Logger_1.Logger.error('❌ osv_scan 失败', error, 'OsvScan');
            return {
                success: false,
                output: `漏洞扫描失败: ${error.message}`,
                error: error.message,
                duration: Date.now() - startTime,
                validated: false,
            };
        }
    };
}
