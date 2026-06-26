/**
 * LSP 补全与悬停提供器
 *
 * 提供代码补全、悬停信息、定义跳转、引用查找等功能
 */

import { LspClientManager } from './LspClientManager';
import type { LspPosition } from './types';

export interface CompletionResult {
  uri: string;
  position: LspPosition;
  items: CompletionItem[];
}

export interface CompletionItem {
  label: string;
  kind?: string;
  detail?: string;
  documentation?: string;
  insertText?: string;
}

export interface HoverResult {
  uri: string;
  position: LspPosition;
  contents: Array<{
    language?: string;
    value: string;
  }>;
}

export interface DefinitionResult {
  uri: string;
  position: LspPosition;
  locations: Array<{
    uri: string;
    line: number;
    character: number;
  }>;
}

export interface ReferencesResult {
  uri: string;
  position: LspPosition;
  locations: Array<{
    uri: string;
    line: number;
    character: number;
  }>;
}

export interface SymbolResult {
  uri: string;
  symbols: Array<{
    name: string;
    kind: string;
    line: number;
    character: number;
    endLine: number;
    endCharacter: number;
    children?: Array<{
      name: string;
      kind: string;
      line: number;
      character: number;
    }>;
  }>;
}

const COMPLETION_KIND_MAP: Record<number, string> = {
  1: 'Text',
  2: 'Method',
  3: 'Function',
  5: 'Field',
  6: 'Variable',
  7: 'Class',
  8: 'Interface',
  9: 'Module',
  10: 'Property',
  13: 'Enum',
  14: 'Keyword',
  15: 'Snippet',
  17: 'File',
  19: 'Folder',
};

const SYMBOL_KIND_MAP: Record<number, string> = {
  1: 'File',
  2: 'Module',
  3: 'Namespace',
  4: 'Package',
  5: 'Class',
  6: 'Method',
  7: 'Property',
  8: 'Field',
  9: 'Constructor',
  10: 'Enum',
  11: 'Interface',
  12: 'Function',
  13: 'Variable',
  14: 'Constant',
};

export class LspCompletionProvider {
  private clientManager: LspClientManager;

  constructor(clientManager?: LspClientManager) {
    this.clientManager = clientManager ?? LspClientManager.getInstance();
  }

  async getCompletions(
    uri: string,
    position: LspPosition
  ): Promise<CompletionResult> {
    const items = await this.clientManager.getCompletion(uri, position);

    return {
      uri,
      position,
      items: items.map((item) => ({
        label: item.label,
        kind: item.kind ? COMPLETION_KIND_MAP[item.kind] : undefined,
        detail: item.detail,
        documentation: item.documentation,
        insertText: item.insertText,
      })),
    };
  }

  async getHover(
    uri: string,
    position: LspPosition
  ): Promise<HoverResult | null> {
    const hover = await this.clientManager.getHover(uri, position);
    if (!hover) return null;

    return {
      uri,
      position,
      contents: hover.contents,
    };
  }

  async getDefinition(
    uri: string,
    position: LspPosition
  ): Promise<DefinitionResult> {
    const locations = await this.clientManager.getDefinition(uri, position);

    return {
      uri,
      position,
      locations: locations.map((loc) => ({
        uri: loc.uri,
        line: loc.range.start.line + 1,
        character: loc.range.start.character + 1,
      })),
    };
  }

  async getReferences(
    uri: string,
    position: LspPosition
  ): Promise<ReferencesResult> {
    const locations = await this.clientManager.getReferences(uri, position);

    return {
      uri,
      position,
      locations: locations.map((loc) => ({
        uri: loc.uri,
        line: loc.range.start.line + 1,
        character: loc.range.start.character + 1,
      })),
    };
  }

  async getDocumentSymbols(uri: string): Promise<SymbolResult> {
    const symbols = await this.clientManager.getDocumentSymbols(uri);

    return {
      uri,
      symbols: symbols.map((s) => ({
        name: s.name,
        kind: SYMBOL_KIND_MAP[s.kind] ?? 'Unknown',
        line: s.range.start.line + 1,
        character: s.range.start.character + 1,
        endLine: s.range.end.line + 1,
        endCharacter: s.range.end.character + 1,
        children: s.children?.map((c) => ({
          name: c.name,
          kind: SYMBOL_KIND_MAP[c.kind] ?? 'Unknown',
          line: c.range.start.line + 1,
          character: c.range.start.character + 1,
        })),
      })),
    };
  }

  formatCompletions(result: CompletionResult): string {
    const lines: string[] = [];
    lines.push(
      `💡 补全建议 (${result.uri}:${result.position.line + 1}:${result.position.character + 1})`
    );

    for (const item of result.items) {
      const kind = item.kind ? `[${item.kind}]` : '';
      lines.push(`  ${item.label} ${kind}`);
      if (item.detail) lines.push(`    ${item.detail}`);
    }

    return lines.join('\n');
  }

  formatHover(result: HoverResult): string {
    const lines: string[] = [];
    lines.push(
      `📖 悬停信息 (${result.uri}:${result.position.line + 1}:${result.position.character + 1})`
    );

    for (const content of result.contents) {
      if (content.language) {
        lines.push(`\`\`\`${content.language}`);
        lines.push(content.value);
        lines.push('```');
      } else {
        lines.push(content.value);
      }
    }

    return lines.join('\n');
  }

  formatDefinition(result: DefinitionResult): string {
    const lines: string[] = [];
    lines.push(
      `📍 定义位置 (${result.uri}:${result.position.line + 1}:${result.position.character + 1})`
    );

    for (const loc of result.locations) {
      lines.push(`  → ${loc.uri}:${loc.line}:${loc.character}`);
    }

    return lines.join('\n');
  }

  formatReferences(result: ReferencesResult): string {
    const lines: string[] = [];
    lines.push(
      `🔗 引用 (${result.uri}:${result.position.line + 1}:${result.position.character + 1}) — 共 ${result.locations.length} 处`
    );

    for (const loc of result.locations) {
      lines.push(`  → ${loc.uri}:${loc.line}:${loc.character}`);
    }

    return lines.join('\n');
  }

  formatSymbols(result: SymbolResult): string {
    const lines: string[] = [];
    lines.push(`🗂️ 文档符号 (${result.uri})`);

    const formatSymbol = (
      symbol: SymbolResult['symbols'][0],
      indent = '  '
    ) => {
      lines.push(`${indent}[${symbol.kind}] ${symbol.name} (L${symbol.line})`);
      symbol.children?.forEach((c) => {
        lines.push(`${indent}  [${c.kind}] ${c.name} (L${c.line})`);
      });
    };

    result.symbols.forEach((s) => formatSymbol(s));
    return lines.join('\n');
  }
}
