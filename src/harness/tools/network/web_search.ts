import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';

export const WEB_SEARCH_DEF: ToolDefinition = {
  name: 'web_search',
  description:
    '实时网络搜索工具。支持通用、技术和新闻搜索。适用场景：查询最新信息、技术文档、新闻动态。不适用：本地文件搜索。',
  category: ToolCategory.NETWORK,
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
  },
  requiredParams: ['query'],
  requiredPermissions: [Permission.NETWORK_ACCESS],
  riskLevel: 'low',
  idempotent: true,
  timeout: 15000,
};

export interface WebSearchDeps {
  searchEngine?: (
    query: string,
    options: { searchType: string; maxResults: number; language: string }
  ) => Promise<
    Array<{ title: string; url: string; snippet: string; source?: string }>
  >;
  httpClient?: { get(url: string): Promise<string> };
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
}

function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const linkRegex = /<a rel="nofollow" href="([^"]+)">([\s\S]*?)<\/a>/g;
  const snippetRegex = /<td class="result-snippet">([\s\S]*?)<\/td>/g;

  const links: Array<{ url: string; title: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html)) !== null) {
    links.push({
      url: match[1],
      title: match[2].replace(/<[^>]+>/g, '').trim(),
    });
  }

  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push(match[1].replace(/<[^>]+>/g, '').trim());
  }

  const count = Math.min(links.length, snippets.length);
  for (let i = 0; i < count; i++) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      snippet: snippets[i],
      source: 'DuckDuckGo',
    });
  }
  return results;
}

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return '未找到相关结果';
  const lines = results.map(
    (r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
  );
  const sources = [
    ...new Set(results.filter((r) => r.source).map((r) => r.source!)),
  ];
  const attribution =
    sources.length > 0 ? `\n\n来源: ${sources.join(', ')}` : '';
  return lines.join('\n\n') + attribution;
}

export function createWebSearchExecutor(deps: WebSearchDeps) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
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
    const language = String(params.language || 'zh-CN');

    try {
      let results: SearchResult[];

      if (deps.searchEngine) {
        results = await deps.searchEngine(query, {
          searchType,
          maxResults,
          language,
        });
      } else if (deps.httpClient) {
        const encoded = encodeURIComponent(query);
        const url = `https://lite.duckduckgo.com/lite?q=${encoded}`;
        const html = await deps.httpClient.get(url);
        results = parseDuckDuckGoHtml(html).slice(0, maxResults);
      } else {
        return {
          success: false,
          output: null,
          error: '搜索服务不可用',
          duration: 0,
          validated: false,
        };
      }

      return {
        success: true,
        output: formatResults(results.slice(0, maxResults)),
        duration: 0,
        validated: false,
      };
    } catch (err) {
      return {
        success: false,
        output: null,
        error: `搜索失败: ${(err as Error).message}`,
        duration: 0,
        validated: false,
      };
    }
  };
}
