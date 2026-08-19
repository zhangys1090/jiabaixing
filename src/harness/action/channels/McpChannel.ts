/**
 * McpChannel —— MCP 工具通道适配器
 *
 * 经 PythonAgentBridge.callMcpTool(...) 调用远端 MCP 服务器工具，归一为
 * ActionChannel 契约。兼容 mcp_{server}_{tool} 与 {server}/{tool} 两种命名。
 */

import { getActivePythonBridge } from '../../../ide/bridgeRegistry';
import type { ActionChannel, ActionRequest, ActionResult } from '../types';
import { Logger } from '../../../utils/Logger';

export class McpChannel implements ActionChannel {
  readonly kind = 'mcp' as const;

  async dispatch(request: ActionRequest): Promise<ActionResult> {
    const start = Date.now();
    const tool = request.tool;

    if (!tool) {
      return {
        channel: 'mcp',
        success: false,
        output: null,
        error: 'McpChannel 需要 request.tool (MCP 工具名)',
        durationMs: Date.now() - start,
      };
    }

    const bridge = getActivePythonBridge();
    if (!bridge) {
      return {
        channel: 'mcp',
        success: false,
        output: null,
        error: 'MCP 后端未连接',
        durationMs: Date.now() - start,
      };
    }

    try {
      const { server, name } = this.parseTool(tool);
      const result = await bridge.callMcpTool(
        server,
        name,
        request.params ?? {}
      );
      const output =
        typeof result === 'string' ? result : JSON.stringify(result);

      return {
        channel: 'mcp',
        success: true,
        output,
        durationMs: Date.now() - start,
        raw: result,
      };
    } catch (err) {
      Logger.error(
        `McpChannel 调用失败: ${tool}`,
        err as Error,
        'McpChannel'
      );
      return {
        channel: 'mcp',
        success: false,
        output: null,
        error: `MCP工具调用失败 [${tool}]: ${(err as Error).message}`,
        durationMs: Date.now() - start,
      };
    }
  }

  private parseTool(tool: string): { server: string; name: string } {
    if (tool.startsWith('mcp_')) {
      const rest = tool.slice(4);
      const idx = rest.indexOf('_');
      if (idx > 0) {
        return { server: rest.slice(0, idx), name: rest.slice(idx + 1) };
      }
    }
    const slash = tool.indexOf('/');
    if (slash > 0) {
      return { server: tool.slice(0, slash), name: tool.slice(slash + 1) };
    }
    return { server: tool, name: tool };
  }
}
