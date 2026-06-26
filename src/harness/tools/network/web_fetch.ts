import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';
import { Logger } from '../../../utils/Logger';

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

function htmlToMarkdown(html: string): string {
  let md = html;
  md = md.replace(/<script[\s\S]*?<\/script>/gi, '');
  md = md.replace(/<style[\s\S]*?<\/style>/gi, '');
  md = md.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  md = md.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '# $1\n\n');
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '## $1\n\n');
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '### $1\n\n');
  md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '#### $1\n\n');
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');
  md = md.replace(/<br\s*\/?>/gi, '\n');
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  md = md.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
  md = md.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '```\n$1\n```\n');
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  md = md.replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, '[$1]');
  md = md.replace(/<[^>]+>/g, '');
  md = md.replace(/&amp;/g, '&');
  md = md.replace(/&lt;/g, '<');
  md = md.replace(/&gt;/g, '>');
  md = md.replace(/&quot;/g, '"');
  md = md.replace(/&#39;/g, "'");
  md = md.replace(/&nbsp;/g, ' ');
  md = md.replace(/\n{3,}/g, '\n\n');
  return md.trim();
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
      if (!url.match(/^https?:\/\//i)) {
        return fail(
          'URL必须以 http:// 或 https:// 开头',
          Date.now() - startTime
        );
      }

      let html: string;

      if (deps.httpClient) {
        html = await deps.httpClient.get(url);
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
