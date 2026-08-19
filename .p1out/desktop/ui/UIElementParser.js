"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UIElementParser = void 0;
const Logger_1 = require("../../utils/Logger");
const types_1 = require("./types");
class UIElementParser {
    constructor() { }
    static getInstance() {
        if (!UIElementParser.instance) {
            UIElementParser.instance = new UIElementParser();
        }
        return UIElementParser.instance;
    }
    parseElements(jsonOutput) {
        const trimmed = jsonOutput.trim();
        if (!trimmed)
            return [];
        try {
            const data = JSON.parse(trimmed);
            const elements = Array.isArray(data) ? data : [data];
            return elements.map((e) => ({
                name: String(e.name || e._name || ''),
                automationId: String(e.automationId || e._automationId || ''),
                controlType: Number(e.controlType || 0),
                controlTypeName: types_1.CONTROL_TYPE_NAMES[Number(e.controlType || 0)] || 'Unknown',
                className: String(e.className || e._className || ''),
                processName: String(e.processName || e._processName || ''),
                windowTitle: String(e.windowTitle || e._windowTitle || ''),
                boundingRect: {
                    x: Number(e.x || 0),
                    y: Number(e.y || 0),
                    width: Number(e.width || 0),
                    height: Number(e.height || 0),
                },
                center: {
                    x: Math.floor(Number(e.x || 0) + Number(e.width || 0) / 2),
                    y: Math.floor(Number(e.y || 0) + Number(e.height || 0) / 2),
                },
                isClickable: Boolean(e.isClickable ?? e._isClickable ?? false),
                isEditable: Boolean(e.isEditable ?? e._isEditable ?? false),
                isVisible: Boolean(e.isVisible ?? e._isVisible ?? false),
                isEnabled: Boolean(e.isEnabled ?? e._isEnabled ?? false),
                hasKeyboardFocus: Boolean(e.hasKeyboardFocus ?? e._hasKeyboardFocus ?? false),
                helpText: String(e.helpText || e._helpText || ''),
                depth: Number(e.depth || e._depth || 0),
                path: String(e.path || e._path || ''),
                childCount: Number(e.childCount || e._childCount || 0),
            }));
        }
        catch (error) {
            Logger_1.Logger.warn(`⚠️ UIA JSON解析失败: ${error.message}`, 'UIElementParser');
            return [];
        }
    }
    parseTreeNodes(jsonOutput) {
        const trimmed = jsonOutput.trim();
        if (!trimmed)
            return [];
        try {
            const data = JSON.parse(trimmed);
            const elements = Array.isArray(data) ? data : [data];
            return elements.map((node) => this.buildNode(node));
        }
        catch (error) {
            Logger_1.Logger.warn(`⚠️ 控件树解析失败: ${error.message}`, 'UIElementParser');
            return [];
        }
    }
    findElement(description, allElements) {
        if (allElements.length === 0) {
            return {
                success: false,
                elements: [],
                matchedBy: 'name',
                query: description,
                error: '未能获取任何UI控件',
            };
        }
        const lowerDesc = description.toLowerCase().trim();
        const exactNameMatch = allElements.filter((e) => e.name && e.name.toLowerCase() === lowerDesc);
        if (exactNameMatch.length > 0) {
            return {
                success: true,
                elements: exactNameMatch,
                matchedBy: 'name',
                query: description,
            };
        }
        const containsNameMatch = allElements.filter((e) => e.name && e.name.toLowerCase().includes(lowerDesc));
        if (containsNameMatch.length > 0) {
            return {
                success: true,
                elements: containsNameMatch,
                matchedBy: 'name',
                query: description,
            };
        }
        const typeKeywords = {
            按钮: [types_1.UIAControlType.Button, types_1.UIAControlType.SplitButton],
            输入框: [types_1.UIAControlType.Edit],
            文本框: [types_1.UIAControlType.Edit],
            下拉框: [types_1.UIAControlType.ComboBox],
            复选框: [types_1.UIAControlType.CheckBox],
            单选框: [types_1.UIAControlType.RadioButton],
            链接: [types_1.UIAControlType.Hyperlink],
            菜单: [types_1.UIAControlType.Menu, types_1.UIAControlType.MenuItem],
            标签: [types_1.UIAControlType.Text],
            列表: [types_1.UIAControlType.List, types_1.UIAControlType.ListItem],
            树: [types_1.UIAControlType.Tree, types_1.UIAControlType.TreeItem],
            表格: [types_1.UIAControlType.DataGrid, types_1.UIAControlType.Table],
            进度条: [types_1.UIAControlType.ProgressBar],
            滑块: [types_1.UIAControlType.Slider],
            窗口: [types_1.UIAControlType.Window],
            工具栏: [types_1.UIAControlType.ToolBar],
        };
        for (const [keyword, types] of Object.entries(typeKeywords)) {
            if (lowerDesc.includes(keyword)) {
                const namePart = lowerDesc.replace(keyword, '').trim();
                const typeMatches = allElements.filter((e) => {
                    const typeMatch = types.includes(e.controlType);
                    if (!namePart)
                        return typeMatch;
                    return typeMatch && e.name && e.name.toLowerCase().includes(namePart);
                });
                if (typeMatches.length > 0) {
                    return {
                        success: true,
                        elements: typeMatches,
                        matchedBy: 'controlType',
                        query: description,
                    };
                }
            }
        }
        const idMatch = allElements.filter((e) => e.automationId && e.automationId.toLowerCase().includes(lowerDesc));
        if (idMatch.length > 0) {
            return {
                success: true,
                elements: idMatch,
                matchedBy: 'automationId',
                query: description,
            };
        }
        const partialMatch = allElements.filter((e) => {
            const searchable = `${e.name} ${e.automationId} ${e.className} ${e.windowTitle}`.toLowerCase();
            return searchable.includes(lowerDesc);
        });
        if (partialMatch.length > 0) {
            return {
                success: true,
                elements: partialMatch,
                matchedBy: 'partial',
                query: description,
            };
        }
        return {
            success: false,
            elements: [],
            matchedBy: 'name',
            query: description,
            error: `未找到匹配 "${description}" 的控件`,
        };
    }
    generateElementReport(elements) {
        if (elements.length === 0) {
            return '未能检测到任何UI控件。';
        }
        const byWindow = new Map();
        for (const e of elements) {
            const key = e.windowTitle || e.processName || '未知窗口';
            if (!byWindow.has(key))
                byWindow.set(key, []);
            byWindow.get(key).push(e);
        }
        let report = `检测到 ${elements.length} 个可交互控件，分布在 ${byWindow.size} 个窗口中：\n\n`;
        for (const [windowTitle, windowElems] of byWindow) {
            report += `【${windowTitle}】\n`;
            const byType = new Map();
            for (const e of windowElems) {
                const typeName = e.controlTypeName || 'Unknown';
                if (!byType.has(typeName))
                    byType.set(typeName, []);
                byType.get(typeName).push(e);
            }
            for (const [typeName, typeElems] of byType) {
                const names = typeElems
                    .filter((e) => e.name)
                    .map((e) => `"${e.name}"`)
                    .join(', ');
                if (names) {
                    report += `  ${typeName}: ${names}\n`;
                }
            }
            report += '\n';
        }
        return report;
    }
    buildNode(node) {
        const element = this.parseElements(JSON.stringify([node]))[0];
        const children = Array.isArray(node.children)
            ? node.children.map((c) => this.buildNode(c))
            : [];
        return {
            ...element,
            children,
        };
    }
}
exports.UIElementParser = UIElementParser;
UIElementParser.instance = null;
