"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WEB_FETCH_DEF = void 0;
exports.htmlToMarkdown = htmlToMarkdown;
exports.createWebFetchExecutor = createWebFetchExecutor;
const Logger_1 = require("../../../utils/Logger");
const types_1 = require("../../types");
exports.WEB_FETCH_DEF = {
    name: 'web_fetch',
    description: '抓取指定URL的网页内容，转为可读文本。USE WHEN: 需要读取某个网页的完整内容、获取API响应、抓取文章正文。DO NOT USE WHEN: 需要搜索信息（先用web_search找到URL再用此工具）、需要交互的网页（用desktop工具）。返回截断后的文本，默认最多10000字符。',
    category: types_1.ToolCategory.NETWORK,
    parameters: {
        url: {
            type: 'string',
            description: '目标网页URL',
        },
        format: {
            type: 'string',
            description: '输出格式',
            enum: ['text', 'markdown', 'html', 'json'],
            default: 'markdown',
        },
        max_length: {
            type: 'number',
            description: '最大返回字符数',
            default: 10000,
        },
        retry_count: {
            type: 'number',
            description: '失败重试次数（0-3），默认1',
            default: 1,
        },
        follow_redirects: {
            type: 'boolean',
            description: '是否跟随重定向，默认true',
            default: true,
        },
    },
    requiredParams: ['url'],
    requiredPermissions: [types_1.Permission.NETWORK_ACCESS],
    riskLevel: 'low',
    idempotent: true,
    timeout: 30000,
};
function htmlToMarkdown(html) {
    let md = html;
    md = md.replace(/<script[\s\S]*?<\/script>/gi, '');
    md = md.replace(/<style[\s\S]*?<\/style>/gi, '');
    md = md.replace(/<nav[\s\S]*?<\/nav>/gi, '');
    md = md.replace(/<footer[\s\S]*?<\/footer>/gi, '');
    md = md.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
    md = md.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
    md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '# $1\n\n');
    md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '## $1\n\n');
    md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '### $1\n\n');
    md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '#### $1\n\n');
    md = md.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '##### $1\n\n');
    md = md.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '###### $1\n\n');
    md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');
    md = md.replace(/<br\s*\/?>/gi, '\n');
    md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
    md = md.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
    md = md.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
    md = md.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
    md = md.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*');
    md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
    md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '```\n$1\n```\n');
    md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
    md = md.replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, '[$1]');
    md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '> $1\n\n');
    md = md.replace(/<hr\s*\/?>/gi, '---\n\n');
    md = md.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, tableContent) => {
        return convertTableToMarkdown(tableContent);
    });
    md = md.replace(/<[^>]+>/g, '');
    md = md.replace(/&amp;/g, '&');
    md = md.replace(/&lt;/g, '<');
    md = md.replace(/&gt;/g, '>');
    md = md.replace(/&quot;/g, '"');
    md = md.replace(/&#39;/g, "'");
    md = md.replace(/&nbsp;/g, ' ');
    md = md.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
    md = md.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    md = md.replace(/\n{3,}/g, '\n\n');
    return md.trim();
}
function convertTableToMarkdown(tableContent) {
    const rows = [];
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(tableContent)) !== null) {
        const cells = [];
        const cellRegex = /<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/gi;
        let cellMatch;
        while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
            cells.push(cellMatch[1].replace(/<[^>]+>/g, '').trim());
        }
        if (cells.length > 0)
            rows.push(cells);
    }
    if (rows.length === 0)
        return '';
    const maxCols = Math.max(...rows.map((r) => r.length));
    const normalized = rows.map((r) => {
        while (r.length < maxCols)
            r.push('');
        return r;
    });
    const lines = [];
    if (normalized.length > 0) {
        lines.push('| ' + normalized[0].join(' | ') + ' |');
        lines.push('| ' + normalized[0].map(() => '---').join(' | ') + ' |');
        for (let i = 1; i < normalized.length; i++) {
            lines.push('| ' + normalized[i].join(' | ') + ' |');
        }
    }
    return lines.join('\n') + '\n\n';
}
function ok(output, duration, metadata) {
    return { success: true, output, duration, validated: false, metadata };
}
function fail(error, duration, output = '') {
    return { success: false, output, error, duration, validated: false };
}
function createWebFetchExecutor(deps = {}) {
    return async (params, _context) => {
        const startTime = Date.now();
        const url = params.url;
        const format = params.format || 'markdown';
        const maxLength = params.max_length || 10000;
        const retryCount = Math.min(3, Math.max(0, Number(params.retry_count) || 1));
        try {
            if (!url.match(/^https?:\/\//i)) {
                return fail('URL必须以 http:// 或 https:// 开头', Date.now() - startTime);
            }
            if (deps.urlSafetyChecker) {
                const safetyResult = deps.urlSafetyChecker.check(url);
                if (!safetyResult.safe) {
                    return fail(`URL安全检查失败: ${safetyResult.reason} (${safetyResult.category})`, Date.now() - startTime);
                }
            }
            let html;
            if (deps.httpClient) {
                html = await deps.httpClient.get(url);
            }
            else {
                let response;
                let lastError = null;
                for (let attempt = 0; attempt <= retryCount; attempt++) {
                    try {
                        response = await fetch(url, {
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                                Accept: 'text/html,application/xhtml+xml,application/json',
                            },
                            signal: AbortSignal.timeout(25000),
                            redirect: params.follow_redirects !== false ? 'follow' : 'manual',
                        });
                        break;
                    }
                    catch (fetchErr) {
                        lastError = fetchErr;
                        if (attempt < retryCount) {
                            Logger_1.Logger.info(`🌐 web_fetch 重试 (${attempt + 1}/${retryCount}): ${url}`, 'WebFetch');
                            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
                        }
                    }
                }
                if (!response) {
                    return fail(`网页抓取失败: ${lastError?.message || '网络错误'}`, Date.now() - startTime);
                }
                if (!response.ok) {
                    return fail(`HTTP ${response.status}: ${response.statusText}`, Date.now() - startTime);
                }
                const contentLengthHeader = response.headers.get('content-length');
                if (contentLengthHeader && parseInt(contentLengthHeader, 10) > 5 * 1024 * 1024) {
                    return fail(`响应体过大 (${(parseInt(contentLengthHeader, 10) / 1024 / 1024).toFixed(1)}MB)，超过5MB限制`, Date.now() - startTime);
                }
                const contentType = response.headers.get('content-type') || '';
                if (contentType.includes('application/json') || format === 'json') {
                    try {
                        const jsonData = await response.json();
                        const jsonStr = JSON.stringify(jsonData, null, 2);
                        const truncated = jsonStr.length > maxLength
                            ? jsonStr.substring(0, maxLength) + '\n\n... (内容已截断)'
                            : jsonStr;
                        Logger_1.Logger.info(`🌐 web_fetch JSON: ${url} (${jsonStr.length}字符)`, 'WebFetch');
                        return ok(truncated, Date.now() - startTime, {
                            url,
                            format: 'json',
                            contentLength: jsonStr.length,
                        });
                    }
                    catch {
                        html = await response.text();
                    }
                }
                else {
                    html = await response.text();
                }
            }
            let content;
            switch (format) {
                case 'html':
                    content = html;
                    break;
                case 'json':
                    try {
                        const parsed = JSON.parse(html);
                        content = JSON.stringify(parsed, null, 2);
                    }
                    catch {
                        content = html;
                    }
                    break;
                case 'text':
                    content = htmlToMarkdown(html).replace(/[#*`[\]]/g, '');
                    break;
                case 'markdown':
                default:
                    content = htmlToMarkdown(html);
                    break;
            }
            if (content.length > maxLength) {
                content = content.substring(0, maxLength) + '\n\n... (内容已截断)';
            }
            Logger_1.Logger.info(`🌐 web_fetch 成功: ${url} (${content.length}字符)`, 'WebFetch');
            return ok(content, Date.now() - startTime, {
                url,
                format,
                contentLength: content.length,
            });
        }
        catch (error) {
            Logger_1.Logger.error('❌ web_fetch 失败', error, 'WebFetch');
            return fail(`网页抓取失败: ${error.message}`, Date.now() - startTime);
        }
    };
}
