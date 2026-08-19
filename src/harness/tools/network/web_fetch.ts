import { Logger } from '../../../utils/Logger';
import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';

export const WEB_FETCH_DEF: ToolDefinition = {
  name: 'web_fetch',
  description:
    '抓取指定URL的网页内容，转为可读文本。USE WHEN: 需要读取某个网页的完整内容、获取API响应、抓取文章正文。DO NOT USE WHEN: 需要搜索信息（先用web_search找到URL再用此工具）、需要交互的网页（用desktop工具）。返回截断后的文本，默认最多10000字符。',
  category: ToolCategory.NETWORK,
  parameters: {
    url: {
      type: 'string',
      description: '目标网页URL',
    },
    format: {
      type: 'string',
      description: '输出格式',
      enum: ['text', 'markdown', 'html'],
      default: 'markdown',
    },
    max_length: {
      type: 'number',
      description: '最大返回字符数',
      default: 10000,
    },
  },
  requiredParams: ['url'],
  requiredPermissions: [Permission.NETWORK_ACCESS],
  riskLevel: 'low',
  idempotent: true,
  timeout: 30000,
};

export interface WebFetchDeps {
  httpClient?: { get(url: string): Promise<string> };
}

export function htmlToMarkdown(html: string): string {
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
  md = md.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  md = md.replace(/\n{3,}/g, '\n\n');
  return md.trim();
}

function convertTableToMarkdown(tableContent: string): string {
  const rows: string[][] = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(tableContent)) !== null) {
    const cells: string[] = [];
    const cellRegex = /<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      cells.push(cellMatch[1].replace(/<[^>]+>/g, '').trim());
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return '';
  const maxCols = Math.max(...rows.map((r) => r.length));
  const normalized = rows.map((r) => {
    while (r.length < maxCols) r.push('');
    return r;
  });
  const lines: string[] = [];
  if (normalized.length > 0) {
    lines.push('| ' + normalized[0].join(' | ') + ' |');
    lines.push('| ' + normalized[0].map(() => '---').join(' | ') + ' |');
    for (let i = 1; i < normalized.length; i++) {
      lines.push('| ' + normalized[i].join(' | ') + ' |');
    }
  }
  return lines.join('\n') + '\n\n';
}

function ok(
  output: string,
  duration: number,
  metadata?: Record<string, unknown>
): ToolResult {
  return { success: true, output, duration, validated: false, metadata };
}

function fail(
  error: string,
  duration: number,
  output: string = ''
): ToolResult {
  return { success: false, output, error, duration, validated: false };
}

/**
 * P0 SSRF 防护: 判断 URL 是否安全（非本地/内网/链路本地/云元数据目标）。
 * 仅做静态主机名与字面量检查；DNS 重绑定时需上层结合解析校验，此处不覆盖。
 * 覆盖的绕过变体: localhost 关键字、.local/.internal 后缀、IPv4 私网/回环/链路本地
 * 字面量、IPv6 回环/链路本地/唯一本地、以及十进制/十六进制/八进制整数编码 IP。
 */
const WEB_FETCH_TIMEOUT_MS = Number(process.env.WEB_FETCH_TIMEOUT_MS) || 25000;
const WEB_FETCH_MAX_BUFFER_CHARS =
  Number(process.env.WEB_FETCH_MAX_BUFFER_CHARS) || 16 * 1024 * 1024; // 16MB 硬上限, 防内存 DoS

/** 竞速超时封装: 防止注入的 httpClient 或底层请求无限挂起。 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}超时(>${ms}ms)`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

export function isSafeUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== 'http:' && scheme !== 'https:') return false;

  // 还原主机名: 去方括号、转小写、解码百分号、去尾点
  const host = parsed.hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/%[0-9a-f]{2}/gi, (m) =>
      String.fromCharCode(parseInt(m.slice(1), 16))
    )
    .replace(/\.+$/, '');

  if (!host) return false;

  // 主机名关键字黑名单（localhost / mDNS / 内网后缀）
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.intranet')
  ) {
    return false;
  }

  // 数字编码主机名（十进制 / 十六进制 / 八进制 IP 编码）
  const numeric = normalizeNumericHost(host);
  if (numeric !== null) return isSafeIPv4(numeric);

  // IPv6 字面量
  if (host.includes(':')) {
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isSafeIPv4(mapped[1]); // IPv4-mapped IPv6
    if (
      host === '::1' || // 回环
      host === '::' || // 未指定
      host.startsWith('fe80:') || // 链路本地
      host.startsWith('fc') || // 唯一本地 fc00::/7
      host.startsWith('fd')
    ) {
      return false;
    }
    return true; // 其他 IPv6 放行（静态无法判定用途）
  }

  // IPv4 字面量
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return isSafeIPv4(host);
  }

  // 混合进制点分 IPv4(如 0x7f.0.0.1 / 0177.0.0.1) —— 归一化后再做安全段判定,
  // 堵住"仅首段编码"的 SSRF 混合编码绕过(原 normalizeNumericHost 只处理整主机编码)。
  const mixed = parseMixedBaseIpv4(host);
  if (mixed !== null) return isSafeIPv4(mixed);

  // 普通域名放行（交由网络/解析层进一步防护）
  return true;
}

/** 将纯数字主机名归一化为点分 IPv4；无法归一化返回 null */
function normalizeNumericHost(host: string): string | null {
  if (/^\d+$/.test(host)) {
    const n = Number(host);
    if (n >= 0 && n <= 0xffffffff) return ipFromLong(n);
  }
  if (/^0x[0-9a-f]+$/i.test(host)) {
    const n = parseInt(host.slice(2), 16);
    if (!Number.isNaN(n) && n >= 0 && n <= 0xffffffff) return ipFromLong(n);
  }
  if (/^0[0-7]+$/.test(host)) {
    const n = parseInt(host.slice(1), 8);
    if (!Number.isNaN(n) && n >= 0 && n <= 0xffffffff) return ipFromLong(n);
  }
  return null;
}

function ipFromLong(n: number): string {
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

/**
 * 兼容 inet_aton 的逐段混合进制 IPv4 解析(每段可为十进制/十六进制/八进制)。
 * 例: 0x7f.0.0.1 → 127.0.0.1; 0177.0.0.1 → 127.0.0.1。
 * 非纯数字点分形式(含字母域名)返回 null, 交由上层按域名处理。
 */
function parseMixedBaseIpv4(host: string): string | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    if (!p) return null;
    let n: number;
    if (/^\d+$/.test(p)) n = Number(p);
    else if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p.slice(1), 8);
    else return null;
    if (!Number.isFinite(n) || n < 0 || n > 255) return null;
    octets.push(n);
  }
  return octets.join('.');
}

/** IPv4 私网/回环/链路本地/未指定 地址段判定 */
function isSafeIPv4(ip: string): boolean {
  const parts = ip.split('.').map((s) => parseInt(s, 10));
  if (
    parts.length !== 4 ||
    parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)
  ) {
    return false;
  }
  const [a, b] = parts;
  if (a === 0) return false; // 0.0.0.0/8 未指定
  if (a === 127) return false; // 127.0.0.0/8 回环
  if (a === 10) return false; // 10.0.0.0/8 私有
  if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12 私有
  if (a === 192 && b === 168) return false; // 192.168.0.0/16 私有
  if (a === 169 && b === 254) return false; // 169.254.0.0/16 链路本地(含元数据)
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10 CGNAT
  return true;
}

export function createWebFetchExecutor(deps: WebFetchDeps = {}) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const url = params.url as string;
    const format = (params.format as string) || 'markdown';
    const maxLength = (params.max_length as number) || 10000;

    try {
      if (!url || typeof url !== 'string') {
        return fail('URL不能为空', Date.now() - startTime);
      }
      if (!/^https?:\/\//i.test(url)) {
        return fail(
          'URL必须以 http:// 或 https:// 开头',
          Date.now() - startTime
        );
      }
      // P0 SSRF 防护: 拒绝本地/内网/链路本地/云元数据地址
      if (!isSafeUrl(url)) {
        Logger.warning(
          `🚫 web_fetch SSRF 拦截: ${url}`,
          'WebFetch'
        );
        return fail(
          '拒绝访问本地/内网/链路本地/云元数据地址（SSRF 防护）',
          Date.now() - startTime
        );
      }

      let html: string;

      if (deps.httpClient) {
        // 注入的 httpClient 为不透明实现, 无法保证其自管超时与尺寸限制;
        // 此处加竞速超时(避免永久挂起)与事后缓冲截断(降低内存 DoS 面)。
        html = await withTimeout(
          deps.httpClient.get(url),
          WEB_FETCH_TIMEOUT_MS,
          'httpClient 请求'
        );
      } else {
        const response = await fetch(url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            Accept: 'text/html,application/xhtml+xml',
          },
          signal: AbortSignal.timeout(25000),
        });

        if (!response.ok) {
          return fail(
            `HTTP ${response.status}: ${response.statusText}`,
            Date.now() - startTime
          );
        }

        html = await response.text();
      }

      // 内存 DoS 护栏: 事后截断超长响应(自管 fetch 与注入 httpClient 两路径均适用)
      if (html && html.length > WEB_FETCH_MAX_BUFFER_CHARS) {
        Logger.warning(
          `⚠️ web_fetch 响应超长(${html.length}字符), 截断至 ${WEB_FETCH_MAX_BUFFER_CHARS}`,
          'WebFetch'
        );
        html = html.slice(0, WEB_FETCH_MAX_BUFFER_CHARS);
      }

      let content: string;
      switch (format) {
        case 'html':
          content = html;
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

      Logger.info(
        `🌐 web_fetch 成功: ${url} (${content.length}字符)`,
        'WebFetch'
      );

      return ok(content, Date.now() - startTime, {
        url,
        format,
        contentLength: content.length,
      });
    } catch (error) {
      Logger.error('❌ web_fetch 失败', error as Error, 'WebFetch');
      return fail(
        `网页抓取失败: ${(error as Error).message}`,
        Date.now() - startTime
      );
    }
  };
}
