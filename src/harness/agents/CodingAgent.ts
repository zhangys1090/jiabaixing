/**
 * CodingAgent — 代码 Agent
 *
 * 专业化于代码生成、分析、审查、修复。
 * 持有 CODE 工具分类下的所有工具。
 */

import { ToolCategory } from '../types';
import { BaseAgent } from './BaseAgent';

export class CodingAgent extends BaseAgent {
  constructor() {
    super({
      id: 'coding-agent',
      name: 'Coding Agent',
      description: '专业化代码 Agent，负责代码生成、分析、审查和修复',
      capabilities: ['coding', 'code_review', 'refactoring', 'debugging'],
      toolCategories: [ToolCategory.CODE],
    });
  }
}
