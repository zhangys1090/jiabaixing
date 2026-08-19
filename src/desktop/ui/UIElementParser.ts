import { Logger } from '../../utils/Logger';
import {
    CONTROL_TYPE_NAMES,
    ElementQueryResult,
    UIAControlType,
    UIElement,
    UIElementNode,
} from './types';

export class UIElementParser {
  private static instance: UIElementParser | null = null;

  private constructor() {}

  public static create(): UIElementParser {
    return new UIElementParser();
  }

  public static getInstance(): UIElementParser {
    if (!UIElementParser.instance) {
      UIElementParser.instance = UIElementParser.create();
    }
    return UIElementParser.instance;
  }

  public parseElements(jsonOutput: string): UIElement[] {
    const trimmed = jsonOutput.trim();
    if (!trimmed) return [];

    try {
      const data = JSON.parse(trimmed);
      const elements = Array.isArray(data) ? data : [data];
      return elements.map((e: Record<string, unknown>) => ({
        name: String(e._name || ''),
        automationId: String(e._automationId || ''),
        controlType: Number(e.controlType || 0),
        controlTypeName:
          CONTROL_TYPE_NAMES[Number(e.controlType || 0)] || 'Unknown',
        className: String(e._className || ''),
        processName: String(e._processName || ''),
        windowTitle: String(e._windowTitle || ''),
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
        isClickable: Boolean(e._isClickable),
        isEditable: Boolean(e._isEditable),
        isVisible: Boolean(e._isVisible),
        isEnabled: Boolean(e._isEnabled),
        hasKeyboardFocus: Boolean(e._hasKeyboardFocus),
        helpText: String(e._helpText || ''),
        depth: Number(e._depth || 0),
        path: String(e._path || ''),
        childCount: Number(e._childCount || 0),
      }));
    } catch (error) {
      Logger.warn(
        `⚠️ UIA JSON解析失败: ${(error as Error).message}`,
        'UIElementParser'
      );
      return [];
    }
  }

  public parseTreeNodes(jsonOutput: string): UIElementNode[] {
    const trimmed = jsonOutput.trim();
    if (!trimmed) return [];

    try {
      const data = JSON.parse(trimmed);
      const elements = Array.isArray(data) ? data : [data];
      return elements.map((node: Record<string, unknown>) =>
        this.buildNode(node)
      );
    } catch (error) {
      Logger.warn(
        `⚠️ 控件树解析失败: ${(error as Error).message}`,
        'UIElementParser'
      );
      return [];
    }
  }

  public findElement(
    description: string,
    allElements: UIElement[]
  ): ElementQueryResult {
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

    const exactNameMatch = allElements.filter(
      (e) => e.name && e.name.toLowerCase() === lowerDesc
    );
    if (exactNameMatch.length > 0) {
      return {
        success: true,
        elements: exactNameMatch,
        matchedBy: 'name',
        query: description,
      };
    }

    const containsNameMatch = allElements.filter(
      (e) => e.name && e.name.toLowerCase().includes(lowerDesc)
    );
    if (containsNameMatch.length > 0) {
      return {
        success: true,
        elements: containsNameMatch,
        matchedBy: 'name',
        query: description,
      };
    }

    const typeKeywords: Record<string, number[]> = {
      按钮: [UIAControlType.Button, UIAControlType.SplitButton],
      输入框: [UIAControlType.Edit],
      文本框: [UIAControlType.Edit],
      下拉框: [UIAControlType.ComboBox],
      复选框: [UIAControlType.CheckBox],
      单选框: [UIAControlType.RadioButton],
      链接: [UIAControlType.Hyperlink],
      菜单: [UIAControlType.Menu, UIAControlType.MenuItem],
      标签: [UIAControlType.Text],
      列表: [UIAControlType.List, UIAControlType.ListItem],
      树: [UIAControlType.Tree, UIAControlType.TreeItem],
      表格: [UIAControlType.DataGrid, UIAControlType.Table],
      进度条: [UIAControlType.ProgressBar],
      滑块: [UIAControlType.Slider],
      窗口: [UIAControlType.Window],
      工具栏: [UIAControlType.ToolBar],
    };

    for (const [keyword, types] of Object.entries(typeKeywords)) {
      if (lowerDesc.includes(keyword)) {
        const namePart = lowerDesc.replace(keyword, '').trim();
        const typeMatches = allElements.filter((e) => {
          const typeMatch = types.includes(e.controlType);
          if (!namePart) return typeMatch;
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

    const idMatch = allElements.filter(
      (e) => e.automationId && e.automationId.toLowerCase().includes(lowerDesc)
    );
    if (idMatch.length > 0) {
      return {
        success: true,
        elements: idMatch,
        matchedBy: 'automationId',
        query: description,
      };
    }

    const partialMatch = allElements.filter((e) => {
      const searchable =
        `${e.name} ${e.automationId} ${e.className} ${e.windowTitle}`.toLowerCase();
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

  public generateElementReport(elements: UIElement[]): string {
    if (elements.length === 0) {
      return '未能检测到任何UI控件。';
    }

    const byWindow = new Map<string, UIElement[]>();
    for (const e of elements) {
      const key = e.windowTitle || e.processName || '未知窗口';
      if (!byWindow.has(key)) byWindow.set(key, []);
      byWindow.get(key)!.push(e);
    }

    let report = `检测到 ${elements.length} 个可交互控件，分布在 ${byWindow.size} 个窗口中：\n\n`;

    for (const [windowTitle, windowElems] of byWindow) {
      report += `【${windowTitle}】\n`;

      const byType = new Map<string, UIElement[]>();
      for (const e of windowElems) {
        const typeName = e.controlTypeName || 'Unknown';
        if (!byType.has(typeName)) byType.set(typeName, []);
        byType.get(typeName)!.push(e);
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

  private buildNode(node: Record<string, unknown>): UIElementNode {
    const element = this.parseElements(JSON.stringify([node]))[0];
    const children = Array.isArray(node.children)
      ? (node.children as Record<string, unknown>[]).map((c) =>
          this.buildNode(c)
        )
      : [];

    return {
      ...element,
      children,
    };
  }
}
