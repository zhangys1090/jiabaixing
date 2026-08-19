/**
 * @deprecated Python 后端模式占位模型（AGENT_BACKEND=python）。
 *
 * 本类**不实现任何本地 LLM 客户端**（无 transport / 无 HTTP 连接 / 无 API Key 读取）。
 * 所有 generate / stream / chat 均经 `getActivePythonBridge()` 委派到 Python FastAPI
 * (:3112) 的 agent.llm（/v1/llm/* 端点）。它仅作为 `LLMProviderBridge` 在 python 模式
 * 下的 `this.model` 占位，满足 `Model` 接口契约，从而**避免在 python 模式实例化
 * OpenAICompatibleModel**（AGENTS.md §0.1 收口：TS 不得独立实现 LLM Provider）。
 *
 * AGENT_BACKEND=local 时不会使用此类；local 模式仍走 OpenAICompatibleModel 真实客户端。
 */

import { getActivePythonBridge } from '../ide/bridgeRegistry';
import { Logger } from '../utils/Logger';
import { Model, ModelInput, ModelOutput } from './ModelInterface';

export class PythonBackedModel implements Model {
  constructor(private readonly modelName: string) {}

  async initialize(): Promise<void> {
    // no-op: Python 后端拥有模型生命周期，TS 侧不建立连接
  }

  async generate(input: ModelInput): Promise<ModelOutput> {
    const bridge = getActivePythonBridge();
    if (!bridge) {
      throw new Error(
        'PythonAgentBridge 不可用，无法委派 LLM 调用（local 模式不应使用 PythonBackedModel）'
      );
    }
    try {
      if (input.tools && input.tools.length > 0) {
        const result = await bridge.llmChatWithTools(
          (input.messages as any) ?? [
            { role: 'user', content: input.prompt || input.text || '' },
          ],
          input.tools,
          input.maxTokens ?? 4096,
          ((input.toolChoice as 'none' | 'auto' | 'required') ?? 'auto')
        );
        return { text: result?.content ?? '', toolCalls: result?.toolCalls };
      }
      const text = await bridge.llmChat(
        input.prompt || input.text || '',
        [],
        input.systemPrompt
      );
      return { text };
    } catch (err) {
      Logger.error('🐍 PythonBackedModel 委派 LLM 失败', err as Error, 'PythonBackedModel');
      throw err;
    }
  }

  async *stream(input: ModelInput): AsyncGenerator<string> {
    const bridge = getActivePythonBridge();
    if (!bridge) {
      throw new Error('PythonAgentBridge 不可用，无法委派流式 LLM 调用');
    }
    // 占位壳：python 模式真实流式经专用 /v1/llm/stream-chat 端点；
    // 此处用非流式结果单次产出以满足 Model 契约（无 TS 本地客户端）。
    const text = await bridge.llmChat(
      input.prompt || input.text || '',
      [],
      input.systemPrompt
    );
    yield text;
  }

  async getModelInfo(): Promise<Record<string, unknown>> {
    const bridge = getActivePythonBridge();
    const name = bridge ? await bridge.llmGetModelName() : this.modelName;
    return { modelName: name, status: 'python-backend' };
  }

  async shutdown(): Promise<void> {
    // no-op
  }

  getName(): string {
    return this.modelName;
  }

  isCircuitOpen(): boolean {
    return false;
  }
}
