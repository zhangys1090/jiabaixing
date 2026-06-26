/**
 * DesktopAgent — 桌面 Agent
 *
 * 专业化于桌面自动化、截图、窗口操作。
 * 持有 DESKTOP 工具分类下的所有工具。
 */

import { ToolCategory } from '../types';
import { BaseAgent } from './BaseAgent';

export class DesktopAgent extends BaseAgent {
  constructor() {
    super({
      id: 'desktop-agent',
      name: 'Desktop Agent',
      description: '专业化桌面 Agent，负责桌面截图和自动化操作',
      capabilities: ['desktop_screenshot', 'desktop_automation'],
      toolCategories: [ToolCategory.DESKTOP],
    });
  }
}
