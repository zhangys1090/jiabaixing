"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.urlSafetyChecker = exports.UrlSafetyChecker = void 0;
const URL_SAFETY_RULES = [
    {
        pattern: /^javascript\s*:/i,
        category: 'JavaScript协议',
        risk: 'critical',
        reason: 'javascript: 协议可执行任意脚本',
    },
    {
        pattern: /^data\s*:/i,
        category: 'Data URI',
        risk: 'critical',
        reason: 'data: URI 可注入HTML内容',
    },
    {
        pattern: /(?:\d{1,3}\.){3}\d{1,3}/i,
        category: 'IP直连',
        risk: 'medium',
        reason: '直接访问IP地址可能存在中间人攻击风险',
    },
    {
        pattern: /[a-z0-9\-]+\.(tk|ml|ga|cf|gq|pw|top|xyz|click|link|download|win)(?:\/|$)/i,
        category: '高风险TLD',
        risk: 'high',
        reason: '该顶级域名常被用于钓鱼或恶意软件分发',
    },
    {
        pattern: /(?:bit\.ly|tinyurl\.com|t\.co|ow\.ly|is\.gd|goo\.gl|shorturl\.at)/i,
        category: '短链接',
        risk: 'medium',
        reason: '短链接隐藏真实目标地址，无法预判安全性',
    },
    {
        pattern: /(?:https?:\/\/)[^/]*\b(?:login|signin|sign-in|auth|account|secure|banking|payment)\b/i,
        category: '敏感页面',
        risk: 'low',
        reason: '涉及认证或支付的敏感页面',
    },
    {
        pattern: /(?:https?:\/\/)[^/]*\b(?:upload|download|attachment)\b/i,
        category: '操作接口',
        risk: 'medium',
        reason: '涉及文件上传下载的接口',
    },
];
const ALLOWED_SCHEMES = ['http:', 'https:', 'ftp:', 'ftps:'];
class UrlSafetyChecker {
    constructor() {
        this.customRules = [];
        this.allowlist = new Set();
        this.blocklist = new Set();
    }
    static getInstance() {
        if (!UrlSafetyChecker.instance) {
            UrlSafetyChecker.instance = new UrlSafetyChecker();
        }
        return UrlSafetyChecker.instance;
    }
    addCustomRule(rule) {
        this.customRules.push(rule);
    }
    addToAllowlist(url) {
        this.allowlist.add(this.normalizeUrl(url));
    }
    addBlocklistPattern(pattern) {
        this.blocklist.add(pattern);
    }
    check(url) {
        if (!url || typeof url !== 'string') {
            return {
                safe: false,
                riskLevel: 'critical',
                category: '无效输入',
                reason: 'URL为空或非字符串',
                url: url || '',
            };
        }
        const normalizedUrl = this.normalizeUrl(url);
        if (this.isAllowlisted(normalizedUrl)) {
            return {
                safe: true,
                riskLevel: 'safe',
                category: '白名单',
                reason: 'URL在允许列表中',
                url,
            };
        }
        for (const blockPattern of this.blocklist) {
            const regex = new RegExp(blockPattern, 'i');
            if (regex.test(normalizedUrl)) {
                return {
                    safe: false,
                    riskLevel: 'critical',
                    category: '黑名单',
                    reason: 'URL匹配黑名单规则',
                    url,
                };
            }
        }
        const allRules = [...URL_SAFETY_RULES, ...this.customRules];
        let worstResult = null;
        for (const rule of allRules) {
            if (rule.pattern.test(url)) {
                const result = {
                    safe: false,
                    riskLevel: rule.risk,
                    category: rule.category,
                    reason: rule.reason,
                    url,
                };
                if (!worstResult ||
                    this.isWorseRisk(result.riskLevel, worstResult.riskLevel)) {
                    worstResult = result;
                }
            }
        }
        if (worstResult) {
            return worstResult;
        }
        try {
            const parsed = new URL(url);
            if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
                return {
                    safe: false,
                    riskLevel: 'critical',
                    category: '非法协议',
                    reason: `不允许的协议: ${parsed.protocol}`,
                    url,
                };
            }
            if (parsed.username || parsed.password) {
                return {
                    safe: false,
                    riskLevel: 'high',
                    category: '凭证暴露',
                    reason: 'URL中包含明文凭证',
                    url,
                };
            }
        }
        catch {
            return {
                safe: false,
                riskLevel: 'high',
                category: 'URL解析失败',
                reason: 'URL格式不合法',
                url,
            };
        }
        return {
            safe: true,
            riskLevel: 'safe',
            category: '正常',
            reason: 'URL未检测到明显风险',
            url,
        };
    }
    checkBatch(urls) {
        return urls.map((url) => this.check(url));
    }
    extractUrls(text) {
        const urlPattern = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
        const matches = text.match(urlPattern) || [];
        return [...new Set(matches)];
    }
    scanTextForUnsafeUrls(text) {
        const urls = this.extractUrls(text);
        const unsafeResults = urls
            .map((url) => this.check(url))
            .filter((result) => !result.safe);
        return {
            totalUrls: urls.length,
            unsafeResults,
        };
    }
    normalizeUrl(url) {
        try {
            const parsed = new URL(url.trim());
            return parsed.origin;
        }
        catch {
            return url.trim().toLowerCase();
        }
    }
    isAllowlisted(normalizedUrl) {
        for (const allowed of this.allowlist) {
            if (normalizedUrl === allowed || normalizedUrl.startsWith(allowed)) {
                return true;
            }
        }
        return false;
    }
    isWorseRisk(current, previous) {
        const riskOrder = { safe: 0, low: 1, medium: 2, high: 3, critical: 4 };
        return (riskOrder[current] || 0) > (riskOrder[previous] || 0);
    }
}
exports.UrlSafetyChecker = UrlSafetyChecker;
UrlSafetyChecker.instance = null;
exports.urlSafetyChecker = UrlSafetyChecker.getInstance();
