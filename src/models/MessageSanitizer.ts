/**
 * MessageSanitizer — 统一消息净化器
 *
 * 收敛散落在 4 处的净化逻辑为单一入口：
 *   1. sanitizeMessagesForAPI — 消息级净化（原 ChatProvider/LLMProvider 重复实现）
 *   2. sanitizeText — PII 脱敏（委托 SensitiveDetector，复用不重写）
 *   3. repairToolCallArguments — JSON 参数修复（原 Executor 私有方法）
 *
 * 设计原则：
 *   - 不重复造轮子：sanitizeText 委托给已有 SensitiveDetector
 *   - 单一职责：本类只做"净化"，不做拦截/决策
 *   - 可组合：三类净化可独立调用，也可链式组合
 */

import { sanitizeText as redactSensitiveText } from '../harness/security/SensitiveDetector';
import { Logger } from '../utils/Logger';

/** 净化前的原始消息结构（宽松类型，兼容各调用方） */
export interface RawMessage {
  role: string;
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

/** 净化后的 API 规范消息结构 */
export type SanitizedMessage = Record<string, unknown>;

export class MessageSanitizer {
  /**
   * 清理 messages 数组，确保符合 OpenAI API 规范
   *
   * 处理规则：
   *   - 合并多条 system 消息为一条（用 \n\n 连接）
   *   - 跳过空 content 的 system 消息
   *   - 跳过空 content 且无 tool_calls 的 assistant 消息
   *   - 保留有 tool_calls 的 assistant 消息（content 填空串）
   *   - 跳过前无 assistant+tool_calls 的孤立 tool 消息
   *   - 为无 content 的 user 消息填充空字符串
   *
   * @param messages - 原始消息数组
   * @returns 符合 OpenAI API 规范的消息数组
   */
  sanitizeMessagesForAPI(messages: RawMessage[]): SanitizedMessage[] {
    const systemParts: string[] = [];
    const nonSystemMessages: SanitizedMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        if (msg.content) {
          systemParts.push(msg.content);
        }
        continue;
      }

      const sanitized: SanitizedMessage = { role: msg.role };

      if (msg.role === 'assistant') {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          sanitized.tool_calls = msg.tool_calls;
          sanitized.content = msg.content || '';
        } else if (msg.content) {
          sanitized.content = msg.content;
        } else {
          continue;
        }
      } else if (msg.role === 'tool') {
        const lastNonTool = [...nonSystemMessages]
          .reverse()
          .find((m) => m.role !== 'tool');
        if (lastNonTool?.role !== 'assistant' || !lastNonTool?.tool_calls) {
          Logger.warn(
            `⚠️ tool 消息前无 assistant+tool_calls，跳过（tool_call_id=${msg.tool_call_id?.substring(0, 20)}）`,
            'MessageSanitizer'
          );
          continue;
        }
        sanitized.tool_call_id = msg.tool_call_id || '';
        sanitized.content = msg.content || '';
        if (msg.name) {
          sanitized.name = msg.name;
        }
      } else {
        sanitized.content = msg.content || '';
      }

      nonSystemMessages.push(sanitized);
    }

    const result: SanitizedMessage[] = [];
    if (systemParts.length > 0) {
      result.push({
        role: 'system',
        content: systemParts.join('\n\n'),
      });
    }
    result.push(...nonSystemMessages);

    return result;
  }

  /**
   * 文本 PII 脱敏
   *
   * 委托给 SensitiveDetector.sanitizeText，复用已有正则模式集，
   * 覆盖：API 密钥 / 令牌 / 银行卡 / 身份证 / 手机号 / 邮箱 / IP / 密码字段等。
   *
   * @param text - 原始文本
   * @returns 脱敏后的文本（敏感信息替换为 [xxx-已脱敏] 标记）
   */
  sanitizeText(text: string): string {
    return redactSensitiveText(text);
  }

  /**
   * 修复模型生成的错误 JSON 工具调用参数
   *
   * 常见错误模式：
   *   1. 未闭合的括号/大括号
   *   2. 尾随逗号
   *   3. 单引号代替双引号
   *   4. 未加引号的键名
   *   5. 字符串内未转义的控制字符
   *   6. 多余的尾随文本（如 ```json 代码块标记）
   *
   * @param raw - 原始参数字符串
   * @returns 修复后的参数对象，修复失败返回 null
   */
  repairToolCallArguments(raw: string): Record<string, unknown> | null {
    if (!raw || typeof raw !== 'string') {
      return null;
    }

    let repaired = raw.trim();

    // 步骤1: 剥离代码块标记（```json ... ``` 或 ``` ... ```）
    const codeBlockMatch = repaired.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    if (codeBlockMatch) {
      repaired = codeBlockMatch[1].trim();
    }

    // 步骤2: 提取首个 JSON 对象/数组（去除尾随文本）
    const jsonStart = repaired.search(/[[{]/);
    if (jsonStart === -1) {
      return null;
    }
    repaired = repaired.slice(jsonStart);

    // 步骤3: 单引号转双引号（仅键/值引号，避免破坏字符串内单引号）
    repaired = repaired.replace(/'([^']*)'/g, '"$1"');

    // 步骤4: 未加引号的键名修复 — 匹配 {key: 或 ,key: 形式
    repaired = repaired.replace(
      /([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)(\s*:)/g,
      '$1"$2"$3'
    );

    // 步骤5: 移除尾随逗号（}, ] 前的逗号）
    repaired = repaired.replace(/,(\s*[}\]])/g, '$1');

    // 步骤6: 转义字符串内未转义的控制字符（换行/制表符）
    repaired = repaired.replace(
      /"([^"\\]*)"/g,
      (_match, content: string) =>
        '"' +
        content.replace(/[\n\r\t]/g, (c) => {
          switch (c) {
            case '\n':
              return '\\n';
            case '\r':
              return '\\r';
            case '\t':
              return '\\t';
            default:
              return c;
          }
        }) +
        '"'
    );

    // 步骤7: 尝试解析
    try {
      return JSON.parse(repaired);
    } catch {
      // 步骤8: 移除尾随非 JSON 文本（保留首个完整 JSON 值）
      const trimmed = this.extractFirstJsonValue(repaired);
      if (trimmed) {
        try {
          return JSON.parse(trimmed);
        } catch {
          // 继续尝试平衡括号
        }
      }
      // 步骤9: 平衡括号 — 补全缺失的闭合括号
      let balanced = this.balanceBrackets(trimmed || repaired);
      // 补全闭合括号后可能产生新的尾随逗号（如 [1,2,3, → [1,2,3,]），需再次移除
      balanced = balanced.replace(/,(\s*[}\]])/g, '$1');
      try {
        return JSON.parse(balanced);
      } catch {
        Logger.warn(
          `⚠️ 工具调用参数 JSON 修复失败，原始: ${raw.slice(0, 200)}`,
          'MessageSanitizer'
        );
        return null;
      }
    }
  }

  /**
   * 提取字符串中首个完整的 JSON 值
   * 通过跟踪括号深度，找到首个平衡的 JSON 值的结束位置
   */
  private extractFirstJsonValue(str: string): string | null {
    let depth = 0;
    let inString = false;
    let escape = false;
    let startIndex = -1;

    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === '{' || ch === '[') {
        if (depth === 0) startIndex = i;
        depth++;
      } else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0 && startIndex !== -1) {
          return str.slice(startIndex, i + 1);
        }
      }
    }
    return null;
  }

  /**
   * 平衡 JSON 字符串中的括号/大括号
   * 补全缺失的闭合符号，移除多余的闭合符号
   */
  private balanceBrackets(str: string): string {
    let result = str;
    let openBraces = 0;
    let openBrackets = 0;
    let inString = false;
    let escape = false;

    for (let i = 0; i < result.length; i++) {
      const ch = result[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') openBraces++;
      else if (ch === '}') openBraces--;
      else if (ch === '[') openBrackets++;
      else if (ch === ']') openBrackets--;
    }

    while (openBrackets > 0) {
      result += ']';
      openBrackets--;
    }
    while (openBraces > 0) {
      result += '}';
      openBraces--;
    }
    return result;
  }

  // ==================== 静态便捷方法 ====================

  private static _instance: MessageSanitizer | null = null;

  /** 获取单例（避免重复创建） */
  static getInstance(): MessageSanitizer {
    if (!this._instance) {
      this._instance = new MessageSanitizer();
    }
    return this._instance;
  }

  /** 静态便捷入口：消息净化 */
  static sanitizeMessages(messages: RawMessage[]): SanitizedMessage[] {
    return MessageSanitizer.getInstance().sanitizeMessagesForAPI(messages);
  }

  /** 静态便捷入口：文本脱敏 */
  static sanitize(text: string): string {
    return MessageSanitizer.getInstance().sanitizeText(text);
  }

  /** 静态便捷入口：JSON 修复 */
  static repairJson(raw: string): Record<string, unknown> | null {
    return MessageSanitizer.getInstance().repairToolCallArguments(raw);
  }
}
