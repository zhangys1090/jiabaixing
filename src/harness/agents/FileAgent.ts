/**
 * FileAgent — 文件 Agent
 *
 * 专业化于文件读写、搜索、编辑。
 * 持有 FILE 工具分类下的所有工具。
 */

import { ToolCategory } from '../types';
import { BaseAgent } from './BaseAgent';

export class FileAgent extends BaseAgent {
  constructor() {
    super({
      id: 'file-agent',
      name: 'File Agent',
      description: '专业化文件 Agent，负责文件读写、搜索和编辑',
      capabilities: ['file_read', 'file_search', 'file_edit', 'file_list'],
      toolCategories: [ToolCategory.FILE],
    });
  }
}
