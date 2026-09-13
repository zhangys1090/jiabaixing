"use strict";
/**
 * FileAgent — 文件 Agent
 *
 * 专业化于文件读写、搜索、编辑。
 * 持有 FILE 工具分类下的所有工具。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileAgent = void 0;
const types_1 = require("../types");
const BaseAgent_1 = require("./BaseAgent");
class FileAgent extends BaseAgent_1.BaseAgent {
    constructor() {
        super({
            id: 'file-agent',
            name: 'File Agent',
            description: '专业化文件 Agent，负责文件读写、搜索和编辑',
            capabilities: ['file_read', 'file_search', 'file_edit', 'file_list'],
            toolCategories: [types_1.ToolCategory.FILE],
        });
    }
}
exports.FileAgent = FileAgent;
