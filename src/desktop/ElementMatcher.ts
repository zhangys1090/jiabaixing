/**
 * ElementMatcher - 视觉+UIA 控件对齐算法
 *
 * 核心问题：VisionEngine 说"截图中有个保存按钮"，但不知道具体坐标。
 * UIA 知道"保存按钮"在 (x,y,w,h)，但不知道哪个是"保存按钮"。
 *
 * ElementMatcher 通过多维度匹配将两者对齐：
 * 1. 空间对齐：Vision 描述的相对位置 → UIA 控件的边界框
 * 2. 语义对齐：Vision 描述的控件名称 → UIA 控件的 Name 属性
 * 3. 类型对齐：Vision 描述的"按钮" → UIA 控件的 ControlType
 * 4. 上下文对齐：Vision 描述的窗口/区域 → UIA 控件的父子关系
 */

import { Logger } from '../utils/Logger';
import { UIElement, UIAControlType } from './DesktopUIInspector';

/** 视觉检测到的元素（来自 VisionEngine 或 OCR） */
export interface VisualElement {
  /** 元素描述（如"保存按钮"、"文件菜单"） */
  description: string;
  /** 元素类型（button, input, menu, text 等） */
  type: string;
  /** 在截图中的相对位置 (0-1) */
  relativeBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** 在截图中的绝对像素位置 */
  pixelBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** 置信度 */
  confidence: number;
  /** OCR 识别到的文本 */
  text?: string;
  /** 所在窗口/区域的描述 */
  context?: string;
}

/** 匹配结果 */
export interface MatchResult {
  /** 匹配到的 UIA 控件 */
  uiElement: UIElement;
  /** 对应的视觉元素 */
  visualElement: VisualElement;
  /** 综合匹配分数 (0-1) */
  score: number;
  /** 匹配维度 */
  matchedBy: Array<'spatial' | 'semantic' | 'type' | 'context' | 'text'>;
  /** 各维度分数详情 */
  scoreDetails: {
    spatial: number;
    semantic: number;
    type: number;
    context: number;
    text: number;
  };
}

/** 匹配配置 */
export interface MatcherConfig {
  /** 空间匹配权重 */
  spatialWeight?: number;
  /** 语义匹配权重 */
  semanticWeight?: number;
  /** 类型匹配权重 */
  typeWeight?: number;
  /** 上下文匹配权重 */
  contextWeight?: number;
  /** 文本匹配权重 */
  textWeight?: number;
  /** 最小匹配阈值 */
  minThreshold?: number;
  /** 屏幕宽度（用于像素转换） */
  screenWidth?: number;
  /** 屏幕高度（用于像素转换） */
  screenHeight?: number;
}

/** 视觉控件类型 → UIA 控件类型映射 */
const VISUAL_TO_UIA_TYPE_MAP: Record<string, number[]> = {
  button: [UIAControlType.Button, UIAControlType.SplitButton],
  input: [UIAControlType.Edit, UIAControlType.ComboBox],
  textbox: [UIAControlType.Edit],
  menu: [UIAControlType.Menu, UIAControlType.MenuBar, UIAControlType.MenuItem],
  checkbox: [UIAControlType.CheckBox],
  radiobutton: [UIAControlType.RadioButton],
  link: [UIAControlType.Hyperlink],
  list: [UIAControlType.List, UIAControlType.ListItem],
  tree: [UIAControlType.Tree, UIAControlType.TreeItem],
  table: [UIAControlType.DataGrid, UIAControlType.Table],
  tab: [UIAControlType.Tab, UIAControlType.TabItem],
  slider: [UIAControlType.Slider],
  progress: [UIAControlType.ProgressBar],
  image: [UIAControlType.Image],
  text: [UIAControlType.Text, UIAControlType.Document],
  window: [UIAControlType.Window],
  toolbar: [UIAControlType.ToolBar],
  dropdown: [UIAControlType.ComboBox],
  dialog: [UIAControlType.Window, UIAControlType.Pane],
};

export class ElementMatcher {
  private config: Required<MatcherConfig>;

  constructor(config?: MatcherConfig) {
    this.config = {
      spatialWeight: config?.spatialWeight ?? 0.3,
      semanticWeight: config?.semanticWeight ?? 0.3,
      typeWeight: config?.typeWeight ?? 0.2,
      contextWeight: config?.contextWeight ?? 0.1,
      textWeight: config?.textWeight ?? 0.1,
      minThreshold: config?.minThreshold ?? 0.4,
      screenWidth: config?.screenWidth ?? 1920,
      screenHeight: config?.screenHeight ?? 1080,
    };
  }

  /**
   * 将视觉元素列表与 UIA 控件列表进行匹配
   *
   * @param visualElements 视觉检测到的元素
   * @param uiElements UIA 遍历到的控件
   * @returns 匹配结果列表
   */
  public match(
    visualElements: VisualElement[],
    uiElements: UIElement[]
  ): MatchResult[] {
    if (visualElements.length === 0 || uiElements.length === 0) {
      return [];
    }

    const results: MatchResult[] = [];
    const matchedUIIndices = new Set<number>();

    // 对每个视觉元素，找到最佳匹配的 UIA 控件
    for (const visual of visualElements) {
      let bestMatch: MatchResult | null = null;
      let bestScore = -1;

      for (let i = 0; i < uiElements.length; i++) {
        if (matchedUIIndices.has(i)) continue;

        const ui = uiElements[i];
        const score = this.calculateMatchScore(visual, ui);

        if (
          score.total > bestScore &&
          score.total >= this.config.minThreshold
        ) {
          bestScore = score.total;
          bestMatch = {
            uiElement: ui,
            visualElement: visual,
            score: score.total,
            matchedBy: score.matchedBy,
            scoreDetails: score.details,
          };
        }
      }

      if (bestMatch) {
        // 找到最佳匹配后，标记该 UIA 控件已被匹配
        const matchedIndex = uiElements.findIndex(
          (ui) => ui === bestMatch!.uiElement
        );
        if (matchedIndex >= 0) matchedUIIndices.add(matchedIndex);
        results.push(bestMatch);
      }
    }

    // 按匹配分数降序排序
    results.sort((a, b) => b.score - a.score);

    Logger.info(
      `🔗 ElementMatcher: ${visualElements.length} 个视觉元素 → ${results.length} 个匹配`,
      'ElementMatcher'
    );

    return results;
  }

  /**
   * 根据自然语言描述查找并匹配控件
   * 例如："点击保存按钮" → 找到 UIA 控件并返回坐标
   */
  public findAndMatch(
    description: string,
    uiElements: UIElement[],
    visualElements?: VisualElement[]
  ): MatchResult | null {
    // 1. 从描述中提取控件名称和类型
    const parsed = this.parseDescription(description);

    // 2. 在 UIA 控件中查找候选
    const candidates = uiElements.filter((ui) => {
      // 名称匹配
      const nameMatch =
        parsed.name &&
        (ui.name.toLowerCase().includes(parsed.name.toLowerCase()) ||
          parsed.name.toLowerCase().includes(ui.name.toLowerCase()));

      // 类型匹配
      const typeMatch =
        parsed.type && this.matchType(parsed.type, ui.controlType);

      // 如果提供了视觉元素，也做空间匹配
      let visualMatch = true;
      if (visualElements && parsed.context) {
        visualMatch = visualElements.some((v) =>
          v.context?.toLowerCase().includes(parsed.context!.toLowerCase())
        );
      }

      return (nameMatch || typeMatch) && visualMatch;
    });

    if (candidates.length === 0) {
      Logger.warn(
        `⚠️ ElementMatcher: 未找到匹配 "${description}" 的控件`,
        'ElementMatcher'
      );
      return null;
    }

    // 3. 如果有视觉元素，进行精确匹配
    if (visualElements && visualElements.length > 0) {
      const matches = this.match(visualElements, candidates);
      if (matches.length > 0) {
        return matches[0];
      }
    }

    // 4. 否则返回最佳 UIA 候选（按名称相似度）
    const bestCandidate = candidates.reduce((best, current) => {
      const currentScore = this.calculateNameSimilarity(
        parsed.name || '',
        current.name
      );
      const bestScore = this.calculateNameSimilarity(
        parsed.name || '',
        best.name
      );
      return currentScore > bestScore ? current : best;
    });

    return {
      uiElement: bestCandidate,
      visualElement: {
        description,
        type: parsed.type || 'unknown',
        relativeBounds: { x: 0, y: 0, width: 0, height: 0 },
        pixelBounds: {
          x: bestCandidate.center.x,
          y: bestCandidate.center.y,
          width: bestCandidate.boundingRect.width,
          height: bestCandidate.boundingRect.height,
        },
        confidence: 0.5,
      },
      score: 0.5,
      matchedBy: ['semantic'],
      scoreDetails: {
        spatial: 0,
        semantic: 0.5,
        type: 0,
        context: 0,
        text: 0,
      },
    };
  }

  /**
   * 计算两个元素的匹配分数
   */
  private calculateMatchScore(
    visual: VisualElement,
    ui: UIElement
  ): {
    total: number;
    matchedBy: Array<'spatial' | 'semantic' | 'type' | 'context' | 'text'>;
    details: {
      spatial: number;
      semantic: number;
      type: number;
      context: number;
      text: number;
    };
  } {
    const matchedBy: Array<
      'spatial' | 'semantic' | 'type' | 'context' | 'text'
    > = [];

    // 空间匹配：比较像素坐标
    const spatialScore = this.calculateSpatialScore(visual, ui);
    if (spatialScore > 0.3) matchedBy.push('spatial');

    // 语义匹配：比较名称/描述
    const semanticScore = this.calculateSemanticScore(visual, ui);
    if (semanticScore > 0.3) matchedBy.push('semantic');

    // 类型匹配：比较控件类型
    const typeScore = this.calculateTypeScore(visual, ui);
    if (typeScore > 0.3) matchedBy.push('type');

    // 上下文匹配：比较所在窗口/区域
    const contextScore = this.calculateContextScore(visual, ui);
    if (contextScore > 0.3) matchedBy.push('context');

    // 文本匹配：OCR 文本与 UIA 名称
    const textScore = this.calculateTextScore(visual, ui);
    if (textScore > 0.3) matchedBy.push('text');

    const total =
      spatialScore * this.config.spatialWeight +
      semanticScore * this.config.semanticWeight +
      typeScore * this.config.typeWeight +
      contextScore * this.config.contextWeight +
      textScore * this.config.textWeight;

    return {
      total,
      matchedBy,
      details: {
        spatial: spatialScore,
        semantic: semanticScore,
        type: typeScore,
        context: contextScore,
        text: textScore,
      },
    };
  }

  /**
   * 空间匹配分数：比较边界框重叠度
   */
  private calculateSpatialScore(visual: VisualElement, ui: UIElement): number {
    const v = visual.pixelBounds;
    const u = ui.boundingRect;

    // 计算 IoU (Intersection over Union)
    const x1 = Math.max(v.x, u.x);
    const y1 = Math.max(v.y, u.y);
    const x2 = Math.min(v.x + v.width, u.x + u.width);
    const y2 = Math.min(v.y + v.height, u.y + u.height);

    if (x2 <= x1 || y2 <= y1) {
      // 无重叠，使用中心点距离
      const vCenterX = v.x + v.width / 2;
      const vCenterY = v.y + v.height / 2;
      const uCenterX = u.x + u.width / 2;
      const uCenterY = u.y + u.height / 2;
      const distance = Math.sqrt(
        Math.pow(vCenterX - uCenterX, 2) + Math.pow(vCenterY - uCenterY, 2)
      );
      const maxDistance = Math.sqrt(
        Math.pow(this.config.screenWidth, 2) +
          Math.pow(this.config.screenHeight, 2)
      );
      return Math.max(0, 1 - distance / (maxDistance * 0.2));
    }

    const intersection = (x2 - x1) * (y2 - y1);
    const vArea = v.width * v.height;
    const uArea = u.width * u.height;
    const union = vArea + uArea - intersection;

    return union > 0 ? intersection / union : 0;
  }

  /**
   * 语义匹配分数：比较名称相似度
   */
  private calculateSemanticScore(visual: VisualElement, ui: UIElement): number {
    const visualDesc = visual.description.toLowerCase();
    const uiName = ui.name.toLowerCase();

    // 精确匹配
    if (visualDesc === uiName) return 1.0;

    // 包含匹配
    if (visualDesc.includes(uiName) || uiName.includes(visualDesc)) {
      const ratio =
        Math.min(visualDesc.length, uiName.length) /
        Math.max(visualDesc.length, uiName.length);
      return 0.7 + ratio * 0.3;
    }

    // 计算编辑距离相似度
    return this.calculateNameSimilarity(visualDesc, uiName);
  }

  /**
   * 类型匹配分数
   */
  private calculateTypeScore(visual: VisualElement, ui: UIElement): number {
    return this.matchType(visual.type, ui.controlType) ? 1.0 : 0.0;
  }

  /**
   * 上下文匹配分数
   */
  private calculateContextScore(visual: VisualElement, ui: UIElement): number {
    if (!visual.context) return 0;
    const context = visual.context.toLowerCase();
    const windowTitle = ui.windowTitle.toLowerCase();
    const processName = ui.processName.toLowerCase();

    if (windowTitle.includes(context) || context.includes(windowTitle))
      return 1.0;
    if (processName.includes(context) || context.includes(processName))
      return 0.7;

    return 0;
  }

  /**
   * 文本匹配分数：OCR 文本与 UIA 名称
   */
  private calculateTextScore(visual: VisualElement, ui: UIElement): number {
    if (!visual.text) return 0;
    const ocrText = visual.text.toLowerCase().trim();
    const uiName = ui.name.toLowerCase().trim();

    if (ocrText === uiName) return 1.0;
    if (ocrText.includes(uiName) || uiName.includes(ocrText)) return 0.8;

    return this.calculateNameSimilarity(ocrText, uiName);
  }

  /**
   * 检查视觉类型是否与 UIA 类型匹配
   */
  private matchType(visualType: string, uiaType: number): boolean {
    const normalizedType = visualType.toLowerCase().trim();
    const mappedTypes = VISUAL_TO_UIA_TYPE_MAP[normalizedType];
    if (!mappedTypes) return false;
    return mappedTypes.includes(uiaType);
  }

  /**
   * 解析自然语言描述
   * 例如："点击保存按钮" → { action: "click", name: "保存", type: "button" }
   */
  private parseDescription(description: string): {
    action?: string;
    name?: string;
    type?: string;
    context?: string;
  } {
    const lower = description.toLowerCase().trim();

    // 提取动作
    const actionPatterns = [
      '点击',
      '单击',
      '双击',
      '右键',
      '输入',
      '填写',
      '选择',
      '勾选',
      '取消勾选',
      '滚动',
      '拖拽',
      '打开',
      '关闭',
      '点击',
      'click',
      'type',
      'select',
      'check',
      'scroll',
      'drag',
      'open',
      'close',
    ];
    let action: string | undefined;
    for (const a of actionPatterns) {
      if (lower.includes(a.toLowerCase())) {
        action = a;
        break;
      }
    }

    // 提取控件类型
    const typePatterns: Record<string, string[]> = {
      button: ['按钮', 'button', 'btn'],
      input: ['输入框', '文本框', 'input', 'textbox'],
      menu: ['菜单', 'menu'],
      checkbox: ['复选框', 'checkbox'],
      radiobutton: ['单选框', 'radio'],
      link: ['链接', 'link'],
      list: ['列表', 'list'],
      table: ['表格', 'table'],
      dropdown: ['下拉框', '下拉', 'dropdown', 'combobox'],
      tab: ['标签页', 'tab'],
      slider: ['滑块', 'slider'],
      window: ['窗口', 'window'],
      dialog: ['对话框', 'dialog'],
      toolbar: ['工具栏', 'toolbar'],
    };

    let type: string | undefined;
    for (const [t, patterns] of Object.entries(typePatterns)) {
      for (const p of patterns) {
        if (lower.includes(p.toLowerCase())) {
          type = t;
          break;
        }
      }
      if (type) break;
    }

    // 提取名称（去掉动作和类型后的剩余部分）
    let name = description;
    if (action) name = name.replace(action, '');
    if (type) {
      for (const p of typePatterns[type] || []) {
        name = name.replace(new RegExp(p, 'gi'), '');
      }
    }
    name = name.replace(
      /[点击单击双击右键输入填写选择勾选滚动拖拽打开关闭]{2,}/g,
      ''
    );
    name = name.trim();

    return { action, name: name || undefined, type };
  }

  /**
   * 计算两个字符串的相似度（基于最长公共子序列）
   */
  private calculateNameSimilarity(a: string, b: string): number {
    if (!a || !b) return 0;
    if (a === b) return 1;

    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array(m + 1)
      .fill(0)
      .map(() => Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    const lcs = dp[m][n];
    return lcs / Math.max(m, n);
  }
}

export default ElementMatcher;
