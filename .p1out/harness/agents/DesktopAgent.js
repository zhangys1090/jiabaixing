"use strict";
/**
 * DesktopAgent — 桌面 Agent
 *
 * 专业化于桌面自动化、截图、窗口操作。
 * 持有 DESKTOP 工具分类下的所有工具。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DesktopAgent = void 0;
const types_1 = require("../types");
const BaseAgent_1 = require("./BaseAgent");
class DesktopAgent extends BaseAgent_1.BaseAgent {
    constructor() {
        super({
            id: 'desktop-agent',
            name: 'Desktop Agent',
            description: '专业化桌面 Agent，负责桌面截图和自动化操作',
            capabilities: ['desktop_screenshot', 'desktop_automation'],
            toolCategories: [types_1.ToolCategory.DESKTOP],
        });
    }
}
exports.DesktopAgent = DesktopAgent;
