"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WEB_SEARCH_DEF = void 0;
exports.createWebSearchExecutor = createWebSearchExecutor;
const Logger_1 = require("../../../utils/Logger");
const types_1 = require("../../types");
exports.WEB_SEARCH_DEF = {
    name: 'web_search',
    description: '实时网络搜索，返回标题+链接+摘要。USE WHEN: 用户要查最新信息、新闻、技术文档、市场数据。DO NOT USE WHEN: 用户问本地文件（用file_search）、问代码问题（用code_analyze）、要打开网页内容（先搜再用web_fetch）。每次搜索用不同关键词，不要重复搜同一个词。中文搜索提示：DuckDuckGo 对中文查询支持有限，建议中文搜索使用 tavily/brave 提供商或 auto 模式（会自动降级到 Bing 中文搜索）。',
    category: types_1.ToolCategory.NETWORK,
    parameters: {
        query: {
            type: 'string',
            description: '搜索关键词',
        },
        search_type: {
            type: 'string',
            description: '搜索类型',
            enum: ['general', 'technical', 'news'],
            default: 'general',
        },
        max_results: {
            type: 'number',
            description: '最大结果数',
            default: 5,
        },
        language: {
            type: 'string',
            description: '搜索语言',
            default: 'zh-CN',
        },
        search_provider: {
            type: 'string',
            description: '搜索提供商：tavily（需API Key）、duckduckgo（免费）、searxng（自托管）、brave（需API Key）、auto（按优先级自动降级）',
            enum: ['tavily', 'duckduckgo', 'searxng', 'brave', 'auto'],
            default: 'auto',
        },
    },
    requiredParams: ['query'],
    requiredPermissions: [types_1.Permission.NETWORK_ACCESS],
    riskLevel: 'low',
    idempotent: true,
    timeout: 15000,
};
const _searchCache = new Map();
const SEARCH_CACHE_TTL = 5 * 60 * 1000;
const MAX_CACHE_SIZE = 200;
let _cacheCleanupTimer = null;

function startCacheCleanup() {
    if (_cacheCleanupTimer) return;
    _cacheCleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of _searchCache) {
            if (now - entry.timestamp > SEARCH_CACHE_TTL) {
                _searchCache.delete(key);
            }
        }
    }, 60 * 1000);
    if (_cacheCleanupTimer.unref) _cacheCleanupTimer.unref();
}
startCacheCleanup();

function getCacheKey(query, maxResults, searchType) {
    return `${query}|${maxResults}|${searchType}`;
}

function getCachedResult(key) {
    const entry = _searchCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > SEARCH_CACHE_TTL) {
        _searchCache.delete(key);
        return null;
    }
    return entry.results;
}

function setCachedResult(key, results) {
    if (_searchCache.size >= MAX_CACHE_SIZE) {
        let oldestKey = null;
        let oldestTime = Infinity;
        for (const [k, v] of _searchCache) {
            if (v.timestamp < oldestTime) {
                oldestTime = v.timestamp;
                oldestKey = k;
            }
        }
        if (oldestKey) _searchCache.delete(oldestKey);
    }
    _searchCache.set(key, { results, timestamp: Date.now() });
}

function dedupResults(results) {
    const seen = new Set();
    return results.filter((r) => {
        const normalizedUrl = r.url.replace(/\/+$/, '').toLowerCase();
        const key = `${normalizedUrl}|${r.title.toLowerCase().trim()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function formatResults(results) {
    if (results.length === 0)
        return '未找到相关结果';
    const titles = results.map((r) => r.title).join('、');
    const summary = `找到 ${results.length} 条结果，涉及：${titles}`;
    const items = results.map((r, i) => ({
        rank: i + 1,
        title: r.title,
        url: r.url,
        snippet: r.snippet.substring(0, 200),
        source: r.source || 'web',
    }));
    const lines = items.map((r) => `${r.rank}. ${r.title}\n   ${r.url}\n   ${r.snippet}`);
    return `【摘要】${summary}\n\n${lines.join('\n\n')}`;
}
/**
 * Tavily 搜索 — 专为 AI Agent 设计，返回结构化结果
 */
async function searchTavily(query, maxResults, searchDepth = 'basic') {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey)
        throw new Error('TAVILY_API_KEY 未配置');
    const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            api_key: apiKey,
            query,
            max_results: maxResults,
            search_depth: searchDepth,
            include_answer: true,
            include_raw_content: false,
        }),
        signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Tavily HTTP ${response.status}: ${body.substring(0, 100)}`);
    }
    const data = (await response.json());
    const results = (data.results || []).map((r) => ({
        title: r.title || '',
        url: r.url || '',
        snippet: (r.content || '').substring(0, 300),
        source: 'Tavily',
    }));
    // 如果 Tavily 提供了直接答案，附加到第一个结果
    if (data.answer && results.length > 0) {
        results[0].snippet = `[AI摘要] ${data.answer}\n\n${results[0].snippet}`;
    }
    return results;
}
/**
 * DuckDuckGo 搜索 — 使用 Instant Answer API，无需 API Key
 */
async function searchDuckDuckGo(query, maxResults) {
    const encoded = encodeURIComponent(query);
    const url = `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`;
    const response = await fetch(url, {
        signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
        throw new Error(`DuckDuckGo HTTP ${response.status}`);
    }
    const data = (await response.json());
    const results = [];
    // 如果有摘要结果，作为第一条
    if (data.Abstract && data.AbstractURL) {
        results.push({
            title: data.AbstractSource || 'DuckDuckGo',
            url: data.AbstractURL,
            snippet: (data.AbstractText || data.Abstract).substring(0, 300),
            source: 'DuckDuckGo',
        });
    }
    // 从 RelatedTopics 中提取结果
    if (data.RelatedTopics) {
        for (const topic of data.RelatedTopics) {
            if (results.length >= maxResults)
                break;
            if (!topic.FirstURL || !topic.Text)
                continue;
            results.push({
                title: topic.Text.substring(0, 80),
                url: topic.FirstURL,
                snippet: topic.Text.substring(0, 300),
                source: 'DuckDuckGo',
            });
        }
    }
    return results;
}
/**
 * SearXNG 搜索 — 使用自托管 SearXNG 实例，隐私优先
 */
async function searchSearXNG(query, maxResults) {
    const baseUrl = process.env.SEARXNG_BASE_URL || 'http://localhost:8888';
    const encoded = encodeURIComponent(query);
    const url = `${baseUrl}/search?q=${encoded}&format=json&categories=general`;
    const response = await fetch(url, {
        signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
        throw new Error(`SearXNG HTTP ${response.status}`);
    }
    const data = (await response.json());
    return (data.results || []).slice(0, maxResults).map((r) => ({
        title: r.title || '',
        url: r.url || '',
        snippet: (r.content || '').substring(0, 300),
        source: r.engine ? `SearXNG(${r.engine})` : 'SearXNG',
    }));
}
/**
 * Brave 搜索 — 使用 Brave Search API，高质量结果
 */
async function searchBrave(query, maxResults) {
    const apiKey = process.env.BRAVE_SEARCH_API_KEY;
    if (!apiKey)
        throw new Error('BRAVE_SEARCH_API_KEY 未配置');
    const encoded = encodeURIComponent(query);
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encoded}&count=${maxResults}`;
    const response = await fetch(url, {
        headers: {
            Accept: 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': apiKey,
        },
        signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Brave HTTP ${response.status}: ${body.substring(0, 100)}`);
    }
    const data = (await response.json());
    return (data.web?.results || []).map((r) => ({
        title: r.title || '',
        url: r.url || '',
        snippet: (r.description || '').substring(0, 300),
        source: 'Brave',
    }));
}
/**
 * Bing 搜索 — HTML 解析降级方案
 */
async function searchBing(query, maxResults) {
    const encoded = encodeURIComponent(query);
    const url = `https://www.bing.com/search?q=${encoded}&setlang=zh-Hans&count=${maxResults}`;
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'text/html',
            'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
        throw new Error(`Bing HTTP ${response.status}`);
    const html = await response.text();
    const results = [];
    const h2Regex = /<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/gi;
    let match;
    while ((match = h2Regex.exec(html)) !== null && results.length < maxResults) {
        const resultUrl = match[1];
        const title = match[2].replace(/<[^>]+>/g, '').trim();
        if (resultUrl.includes('bing.com') || resultUrl.includes('microsoft.com'))
            continue;
        const afterBlock = html.substring(match.index, match.index + 1500);
        const pMatch = afterBlock.match(/<p[^>]*>([\s\S]*?)<\/p>/);
        const snippet = pMatch
            ? pMatch[1]
                .replace(/<[^>]+>/g, '')
                .replace(/&ensp;|&#0183;|&amp;/g, ' ')
                .trim()
            : '';
        results.push({ title, url: resultUrl, snippet, source: 'Bing' });
    }
    return results;
}
/**
 * 按优先级依次尝试搜索提供商，直到成功返回结果
 * @param query - 搜索关键词
 * @param maxResults - 最大结果数
 * @param searchType - 搜索类型
 * @param providers - 按优先级排列的提供商列表
 * @returns 搜索结果数组
 */
async function searchWithFallback(query, maxResults, searchType, providers) {
    const errors = [];
    for (const provider of providers) {
        try {
            switch (provider) {
                case 'tavily': {
                    const depth = searchType === 'technical' ? 'advanced' : 'basic';
                    const results = await searchTavily(query, maxResults, depth);
                    if (results.length > 0)
                        return results;
                    errors.push(`tavily: 返回0条结果`);
                    break;
                }
                case 'duckduckgo': {
                    const results = await searchDuckDuckGo(query, maxResults);
                    if (results.length > 0)
                        return results;
                    errors.push(`duckduckgo: 返回0条结果`);
                    break;
                }
                case 'searxng': {
                    const results = await searchSearXNG(query, maxResults);
                    if (results.length > 0)
                        return results;
                    errors.push(`searxng: 返回0条结果`);
                    break;
                }
                case 'brave': {
                    const results = await searchBrave(query, maxResults);
                    if (results.length > 0)
                        return results;
                    errors.push(`brave: 返回0条结果`);
                    break;
                }
            }
        }
        catch (err) {
            const msg = `${provider}: ${err.message}`;
            errors.push(msg);
            Logger_1.Logger.warn(`${provider} 搜索失败，尝试下一个提供商: ${err.message}`, 'WebSearch');
        }
    }
    // 所有提供商都失败，最后降级到 Bing HTML 解析
    Logger_1.Logger.warn(`所有搜索提供商均失败(${errors.join('; ')})，降级到 Bing`, 'WebSearch');
    try {
        return await searchBing(query, maxResults);
    }
    catch (bingErr) {
        Logger_1.Logger.error('Bing 搜索也失败', bingErr, 'WebSearch');
        return [];
    }
}
function createWebSearchExecutor(deps) {
    return async (params, _context) => {
        const query = String(params.query || '');
        if (!query) {
            return {
                success: false,
                output: null,
                error: '搜索关键词不能为空',
                duration: 0,
                validated: false,
            };
        }
        const searchType = String(params.search_type || 'general');
        const maxResults = Number(params.max_results || 5);
        const searchProvider = String(params.search_provider || 'auto');
        const startTime = Date.now();
        try {
            const cacheKey = getCacheKey(query, maxResults, searchType);
            const cached = getCachedResult(cacheKey);
            if (cached) {
                Logger_1.Logger.info(`🔍 web_search 缓存命中: "${query}"`, 'WebSearch');
                return {
                    success: true,
                    output: formatResults(cached),
                    duration: Date.now() - startTime,
                    validated: false,
                    metadata: { cached: true, resultCount: cached.length },
                };
            }
            let results;
            if (deps.searchEngine) {
                results = await deps.searchEngine(query, {
                    searchType,
                    maxResults,
                    language: String(params.language || 'zh-CN'),
                });
            }
            else if (searchProvider === 'auto') {
                // auto 模式：中文查询优先 tavily → brave → bing，非中文 tavily → duckduckgo → searxng → brave → bing
                const hasChinese = /[\u4e00-\u9fff]/.test(query);
                if (hasChinese) {
                    results = await searchWithFallback(query, maxResults, searchType, [
                        'tavily',
                        'brave',
                        'duckduckgo',
                        'searxng',
                    ]);
                }
                else {
                    results = await searchWithFallback(query, maxResults, searchType, [
                        'tavily',
                        'duckduckgo',
                        'searxng',
                        'brave',
                    ]);
                }
            }
            else {
                // 指定提供商，失败则降级到后续提供商
                const providerOrder = [
                    'tavily',
                    'duckduckgo',
                    'searxng',
                    'brave',
                ];
                const specifiedIndex = providerOrder.indexOf(searchProvider);
                const fallbackProviders = specifiedIndex >= 0
                    ? providerOrder.slice(specifiedIndex + 1)
                    : ['duckduckgo', 'searxng', 'brave'];
                try {
                    switch (searchProvider) {
                        case 'tavily': {
                            const depth = searchType === 'technical' ? 'advanced' : 'basic';
                            results = await searchTavily(query, maxResults, depth);
                            break;
                        }
                        case 'duckduckgo':
                            results = await searchDuckDuckGo(query, maxResults);
                            break;
                        case 'searxng':
                            results = await searchSearXNG(query, maxResults);
                            break;
                        case 'brave':
                            results = await searchBrave(query, maxResults);
                            break;
                        default:
                            Logger_1.Logger.warn(`未知搜索提供商 "${searchProvider}"，使用 auto 模式`, 'WebSearch');
                            results = await searchWithFallback(query, maxResults, searchType, ['tavily', 'duckduckgo', 'searxng', 'brave']);
                    }
                }
                catch (err) {
                    Logger_1.Logger.warn(`指定提供商 ${searchProvider} 失败: ${err.message}，降级到后续提供商`, 'WebSearch');
                    results = await searchWithFallback(query, maxResults, searchType, fallbackProviders);
                }
            }
            results = dedupResults(results);
            if (results.length > 0) {
                setCachedResult(cacheKey, results);
            }
            const output = results.length > 0
                ? formatResults(results)
                : JSON.stringify({
                    error: true,
                    error_type: 'no_results',
                    message: `未找到"${query}"的相关结果`,
                    suggestion: '尝试更简短的关键词，或拆分为多个子问题分别搜索',
                    retryable: false,
                });
            Logger_1.Logger.info(`🔍 web_search: "${query}" → ${results.length} 结果 (${Date.now() - startTime}ms)`, 'WebSearch');
            return {
                success: true,
                output,
                duration: Date.now() - startTime,
                validated: false,
                metadata: { resultCount: results.length, cached: false },
            };
        }
        catch (err) {
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
