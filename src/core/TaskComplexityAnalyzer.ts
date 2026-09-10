/**
 * 任务复杂度分析模块
 * 分析任务的复杂度，提供任务拆解建议
 */

/** LLM 依赖接口 — 用于复杂度分析 */
export interface ComplexityLLMDeps {
  chat: (prompt: string) => Promise<string>;
}

/** 单维度复杂度评估 */
export interface DimensionalComplexity {
  level: 'low' | 'medium' | 'high';
  score: number;
}

/** 多维度复杂度评估 */
export interface MultiDimensionalComplexity {
  timeComplexity: DimensionalComplexity;
  dependencyComplexity: DimensionalComplexity;
  toolComplexity: DimensionalComplexity;
}

/** 混淆矩阵条目 */
export interface ConfusionMatrixEntry {
  [actual: string]: number;
}

/** 混淆矩阵 */
export interface ConfusionMatrix {
  [predicted: string]: ConfusionMatrixEntry;
}

/** 预测准确率统计 */
export interface PredictionAccuracy {
  total: number;
  correct: number;
  rate: number;
}

/** 置信度校准条目 */
export interface ConfidenceCalibrationEntry {
  total: number;
  correct: number;
  accuracy: number;
}

/** 置信度校准数据 */
export type ConfidenceCalibration = Record<string, ConfidenceCalibrationEntry>;

export interface TaskComplexityResult {
  complexity: 'simple' | 'medium' | 'complex' | 'very_complex';
  estimatedSteps: number;
  estimatedTime: number; // 分钟
  requiresTools: string[];
  riskFactors: string[];
  recommendations: string[];
  dependencies: string[];
  parallelizable: boolean;
  /** 校准后的预估轮次 */
  calibratedEstimatedRounds?: number;
  /** 多维度复杂度评估 */
  multiDimensional?: MultiDimensionalComplexity;
  /** 领域标签 */
  domainTag?: 'data' | 'doc' | 'pm' | null;
  /** LLM 置信度 */
  llmConfidence?: number;
  /** LLM 辅助判断的复杂度结果 — 仅在 LLM 成功返回时设置 */
  llmAssistedComplexity?: {
    complexity: 'simple' | 'medium' | 'complex' | 'very_complex';
    confidence: number;
    estimatedSteps: number;
  };
  /** 并行度详情 — 评估任务可并行化的程度 */
  parallelismDetail?: {
    level: 'none' | 'low' | 'medium' | 'high' | 'full';
    score: number;
    parallelizableSteps: number;
    sequentialSteps: number;
    suggestions: string[];
  };
  /** 并行度评分 (0-1) */
  parallelismScore?: number;
}

export interface TaskDecomposition {
  mainTask: string;
  subTasks: SubTask[];
  totalEstimatedTime: number;
  parallelGroups: string[][];
  criticalPath: string[];
}

export interface SubTask {
  id: string;
  description: string;
  estimatedTime: number;
  dependencies: string[];
  tools: string[];
  complexity: TaskComplexityResult['complexity'];
  canParallel: boolean;
}

export class TaskComplexityAnalyzer {
  private complexityKeywords = {
    high: [
      '分析',
      '设计',
      '开发',
      '实现',
      '优化',
      '重构',
      '集成',
      '部署',
      '测试',
      '架构',
      '规划',
    ],
    medium: [
      '查询',
      '计算',
      '转换',
      '整理',
      '统计',
      '生成',
      '创建',
      '修改',
      '更新',
      '配置',
      '安装',
    ],
    conditional: [
      '如果',
      '当',
      '条件',
      '判断',
      '检查',
      '验证',
      '根据',
      '取决于',
    ],
    parallel: ['同时', '并行', '分别', '各自', '一起', '同步', '批量'],
    sequential: ['然后', '接着', '之后', '首先', '最后', '逐步', '依次'],
  };

  /** 领域关键词 — 识别特定领域任务以增加步骤估算 */
  private domainKeywords: { [domain: string]: string[] } = {
    data: ['数据', '清洗', '特征', '建模', '挖掘', '可视化', 'ETL', '分析'],
    document: ['文档', '转换', 'OCR', '提取', '解析', 'PDF', 'Word', 'Excel'],
    project: ['里程碑', '甘特图', '依赖', '管理', '排期', '任务', '进度'],
    code: ['代码', '函数', '类', '模块', 'API', '接口', '调试', '编译'],
    devops: ['部署', '容器', 'Docker', 'K8s', 'CI/CD', '监控', '日志'],
  };

  private toolMappings: { [key: string]: string[] } = {
    开发: ['CodeGenerator', 'ProjectManager', 'CodeAnalyzer'],
    分析: ['DataAnalyzer', 'ReportGenerator', 'PatternRecognizer'],
    查询: ['DatabaseQuery', 'WebSearch', 'KnowledgeBase'],
    计算: ['Calculator', 'DataProcessor', 'MathSolver'],
    创建: ['FileCreator', 'TemplateEngine', 'ContentGenerator'],
    修改: ['CodeEditor', 'RefactoringTool', 'VersionControl'],
    部署: ['DeploymentManager', 'CI/CD Pipeline', 'ContainerManager'],
    测试: ['TestRunner', 'TestGenerator', 'CoverageAnalyzer'],
    设计: ['DesignTool', 'MockupGenerator', 'WireframeCreator'],
    优化: ['PerformanceAnalyzer', 'Optimizer', 'BenchmarkTool'],
  };

  /** 实际执行轮次历史 — key 为任务描述 */
  private actualRoundsHistory: Map<
    string,
    Array<{ estimated: number; actual: number }>
  > = new Map();
  /** 实际执行时长历史 — key 为任务描述 */
  private actualDurationHistory: Map<
    string,
    Array<{ estimated: number; actual: number }>
  > = new Map();
  /** 预测准确率记录 */
  private predictionRecords: Array<{
    task: string;
    predicted: string;
    actual: string;
  }> = [];
  /** 置信度校准数据 — key 为置信度桶（如 "0.9"） */
  private confidenceCalibrationMap: Map<
    string,
    { total: number; correct: number }
  > = new Map();
  /** LLM 依赖 */
  private llmDeps: ComplexityLLMDeps | null = null;

  private static readonly HISTORY_MAX_PER_TASK = 50;
  private static readonly PREDICTION_RECORDS_MAX = 500;
  private static readonly HISTORY_MAX_KEYS = 200;

  /**
   * 分析任务复杂度
   */
  analyzeComplexity(task: string): TaskComplexityResult {
    const keywords = this.extractKeywords(task);
    const hasConditions = this.checkConditionalPatterns(task);
    const hasParallelism = this.checkParallelPatterns(task);
    const hasSequential = this.checkSequentialPatterns(task);
    const estimatedSteps = this.estimateSteps(
      keywords,
      hasConditions,
      hasParallelism,
      hasSequential,
      task
    );

    const result: TaskComplexityResult = {
      complexity: this.determineComplexityLevel(estimatedSteps, keywords),
      estimatedSteps,
      estimatedTime: this.estimateTime(estimatedSteps),
      requiresTools: this.identifyRequiredTools(keywords),
      riskFactors: this.identifyRiskFactors(task, keywords),
      recommendations: this.generateRecommendations(keywords, estimatedSteps),
      dependencies: this.identifyDependencies(task, keywords),
      parallelizable: hasParallelism && !hasSequential,
    };

    // 校准预估轮次
    const calibrated = this.getCalibratedRounds(task);
    if (calibrated !== undefined) {
      result.calibratedEstimatedRounds = calibrated;
    }

    // 多维度复杂度评估
    result.multiDimensional = this.assessMultiDimensionalComplexity(
      task,
      keywords,
      estimatedSteps
    );

    // 领域标签
    result.domainTag = this.detectDomainTag(task);

    // 并行度详情
    result.parallelismDetail = this.assessParallelism(
      task,
      hasParallelism,
      hasSequential
    );
    result.parallelismScore = result.parallelismDetail.score;

    return result;
  }

  /**
   * 深度拆解任务
   */
  decomposeTask(task: string): TaskDecomposition {
    const complexity = this.analyzeComplexity(task);
    const subTasks: SubTask[] = [];

    // 根据复杂度生成子任务
    if (complexity.complexity === 'simple') {
      // 简单任务不需要拆解
      subTasks.push(this.createSubTask(task, 1, [], complexity.complexity));
    } else {
      // 复杂任务需要拆解
      const taskParts = this.extractTaskParts(task);
      let taskId = 1;

      for (const part of taskParts) {
        const partComplexity = this.analyzeComplexity(part);
        const dependencies = this.calculateDependencies(subTasks, part, taskId);

        subTasks.push({
          id: `task_${taskId}`,
          description: part,
          estimatedTime: partComplexity.estimatedTime,
          dependencies,
          tools: partComplexity.requiresTools,
          complexity: partComplexity.complexity,
          canParallel: partComplexity.parallelizable,
        });

        taskId++;
      }
    }

    // 计算并行组
    const parallelGroups = this.calculateParallelGroups(subTasks);

    // 计算关键路径
    const criticalPath = this.calculateCriticalPath(subTasks);

    return {
      mainTask: task,
      subTasks,
      totalEstimatedTime: subTasks.reduce(
        (sum, st) => sum + st.estimatedTime,
        0
      ),
      parallelGroups,
      criticalPath,
    };
  }

  private extractKeywords(task: string): string[] {
    const allKeywords = Object.values(this.complexityKeywords).flat();
    const words = task.toLowerCase().split(/[\s,.!?，。！？、；：]/);

    return words.filter((word) =>
      allKeywords.some(
        (kw) =>
          word.includes(kw.toLowerCase()) || kw.toLowerCase().includes(word)
      )
    );
  }

  private checkConditionalPatterns(task: string): boolean {
    return this.complexityKeywords.conditional.some((kw) => task.includes(kw));
  }

  private checkParallelPatterns(task: string): boolean {
    return this.complexityKeywords.parallel.some((kw) => task.includes(kw));
  }

  private checkSequentialPatterns(task: string): boolean {
    return this.complexityKeywords.sequential.some((kw) => task.includes(kw));
  }

  private estimateSteps(
    keywords: string[],
    hasConditions: boolean,
    hasParallelism: boolean,
    hasSequential: boolean,
    task?: string
  ): number {
    let baseSteps = 1;

    // 高复杂度关键词
    baseSteps +=
      keywords.filter((kw) =>
        this.complexityKeywords.high.some((hk) => kw.includes(hk.toLowerCase()))
      ).length * 3;

    // 中等复杂度关键词
    baseSteps +=
      keywords.filter((kw) =>
        this.complexityKeywords.medium.some((mk) =>
          kw.includes(mk.toLowerCase())
        )
      ).length * 2;

    // 领域关键词识别 — 直接检查任务文本中的领域关键词
    if (task) {
      for (const domainKeywords of Object.values(this.domainKeywords)) {
        const matchedCount = domainKeywords.filter((dk) =>
          task.includes(dk)
        ).length;
        baseSteps += matchedCount;
      }
    }

    // 条件判断增加步骤
    if (hasConditions) baseSteps += 2;

    // 并行处理减少步骤
    if (hasParallelism) baseSteps = Math.max(1, baseSteps * 0.8);

    // 顺序执行增加步骤
    if (hasSequential) baseSteps += 1;

    return Math.max(1, Math.round(baseSteps));
  }

  private determineComplexityLevel(
    steps: number,
    keywords: string[]
  ): TaskComplexityResult['complexity'] {
    const highKeywordCount = keywords.filter((kw) =>
      this.complexityKeywords.high.some((hk) => kw.includes(hk.toLowerCase()))
    ).length;

    if (steps >= 10 || highKeywordCount >= 3) return 'very_complex';
    if (steps >= 6 || highKeywordCount >= 2) return 'complex';
    if (steps >= 3) return 'medium';
    return 'simple';
  }

  private estimateTime(steps: number): number {
    const timePerStep = 5;
    return steps * timePerStep;
  }

  private identifyRequiredTools(keywords: string[]): string[] {
    const tools: string[] = [];

    for (const keyword of keywords) {
      for (const [key, value] of Object.entries(this.toolMappings)) {
        if (
          keyword.includes(key.toLowerCase()) &&
          !tools.some((t) => value.includes(t))
        ) {
          tools.push(...value);
        }
      }
    }

    return tools.length > 0 ? [...new Set(tools)] : ['GeneralTool'];
  }

  private identifyRiskFactors(task: string, keywords: string[]): string[] {
    const risks: string[] = [];

    if (keywords.some((kw) => kw.includes('部署') || kw.includes('发布'))) {
      risks.push('可能影响现有系统稳定性');
    }
    if (keywords.some((kw) => kw.includes('删除') || kw.includes('修改'))) {
      risks.push('操作不可逆，需要确认');
    }
    if (task.length > 200) {
      risks.push('任务描述较长，可能包含多个子任务');
    }
    if (keywords.some((kw) => kw.includes('集成') || kw.includes('重构'))) {
      risks.push('涉及系统架构变更，风险较高');
    }

    // 领域特定风险评估
    const domainTag = this.detectDomainTag(task);
    if (domainTag === 'data') {
      risks.push('数据质量风险：可能存在脏数据或缺失值');
    } else if (domainTag === 'doc') {
      risks.push('文档格式风险：可能存在格式不一致或编码问题');
    } else if (domainTag === 'pm') {
      risks.push('项目进度风险：可能存在资源或时间约束');
    }

    return risks;
  }

  private generateRecommendations(keywords: string[], steps: number): string[] {
    const recommendations: string[] = [];

    if (steps > 8) {
      recommendations.push('建议拆分为多个子任务执行');
    }
    if (keywords.some((kw) => kw.includes('开发') || kw.includes('实现'))) {
      recommendations.push('建议先编写测试用例');
    }
    if (keywords.some((kw) => kw.includes('部署') || kw.includes('发布'))) {
      recommendations.push('建议在非高峰时段执行');
    }
    if (steps > 5) {
      recommendations.push('建议制定详细的执行计划');
    }
    if (keywords.some((kw) => kw.includes('分析') || kw.includes('设计'))) {
      recommendations.push('建议先进行需求调研');
    }

    return recommendations;
  }

  private identifyDependencies(task: string, _keywords: string[]): string[] {
    const dependencies: string[] = [];

    // 识别外部依赖
    if (task.includes('API') || task.includes('接口')) {
      dependencies.push('外部API可用性');
    }
    if (task.includes('数据库') || task.includes('数据')) {
      dependencies.push('数据库连接');
    }
    if (task.includes('文件') || task.includes('文档')) {
      dependencies.push('文件系统访问权限');
    }
    if (task.includes('网络') || task.includes('服务器')) {
      dependencies.push('网络连接稳定性');
    }

    return dependencies;
  }

  private createSubTask(
    description: string,
    id: number,
    dependencies: string[],
    complexity: TaskComplexityResult['complexity']
  ): SubTask {
    const complexityResult = this.analyzeComplexity(description);

    return {
      id: `task_${id}`,
      description,
      estimatedTime: complexityResult.estimatedTime,
      dependencies,
      tools: complexityResult.requiresTools,
      complexity,
      canParallel: false,
    };
  }

  private extractTaskParts(task: string): string[] {
    // 使用标点符号和连接词分割任务
    const separators =
      /[，。；！？,;!?]|然后|接着|之后|首先|最后|同时|并且|以及/;
    const parts = task
      .split(separators)
      .filter((part) => part.trim().length > 0);

    if (parts.length === 1) {
      // 如果无法分割，尝试根据动词分割
      return this.splitByVerbs(task);
    }

    return parts.map((part) => part.trim());
  }

  private splitByVerbs(task: string): string[] {
    const verbs = [
      '分析',
      '设计',
      '开发',
      '实现',
      '测试',
      '部署',
      '优化',
      '配置',
      '安装',
    ];
    const parts: string[] = [];
    let currentPart = '';

    const words = task.split(/[\s,.!?，。！？、]/);

    for (const word of words) {
      if (verbs.some((v) => word.includes(v)) && currentPart.length > 0) {
        parts.push(currentPart.trim());
        currentPart = word;
      } else {
        currentPart += word;
      }
    }

    if (currentPart.length > 0) {
      parts.push(currentPart.trim());
    }

    return parts.length > 0 ? parts : [task];
  }

  private calculateDependencies(
    existingTasks: SubTask[],
    currentPart: string,
    _currentId: number
  ): string[] {
    const dependencies: string[] = [];

    for (const task of existingTasks) {
      if (currentPart.includes(task.description.substring(0, 10))) {
        dependencies.push(task.id);
      }
    }

    return dependencies;
  }

  private calculateParallelGroups(subTasks: SubTask[]): string[][] {
    const groups: string[][] = [];
    const processed = new Set<string>();

    for (const task of subTasks) {
      if (processed.has(task.id)) continue;

      // 找到可以并行执行的任务组
      const parallelGroup = subTasks
        .filter(
          (t) =>
            t.canParallel &&
            !processed.has(t.id) &&
            this.canExecuteInParallel(t, task, subTasks)
        )
        .map((t) => t.id);

      if (parallelGroup.length > 1) {
        groups.push(parallelGroup);
        parallelGroup.forEach((id) => processed.add(id));
      }
    }

    return groups;
  }

  private canExecuteInParallel(
    task1: SubTask,
    task2: SubTask,
    _allTasks: SubTask[]
  ): boolean {
    // 检查两个任务是否有依赖关系
    const hasDependency =
      task1.dependencies.includes(task2.id) ||
      task2.dependencies.includes(task1.id);

    // 检查是否有共同的依赖
    const commonDependencies = task1.dependencies.filter((dep) =>
      task2.dependencies.includes(dep)
    );

    return !hasDependency && commonDependencies.length === 0;
  }

  private calculateCriticalPath(subTasks: SubTask[]): string[] {
    // 简化的关键路径计算
    // 实际应用中应使用更复杂的算法（如CPM）
    const path: string[] = [];
    const visited = new Set<string>();

    // 找到没有依赖的任务作为起点
    const startTasks = subTasks.filter((t) => t.dependencies.length === 0);

    for (const startTask of startTasks) {
      this.dfsCriticalPath(startTask, subTasks, path, visited);
    }

    return path;
  }

  private dfsCriticalPath(
    currentTask: SubTask,
    allTasks: SubTask[],
    path: string[],
    visited: Set<string>
  ): void {
    if (visited.has(currentTask.id)) return;

    visited.add(currentTask.id);
    path.push(currentTask.id);

    // 找到依赖于当前任务的所有任务
    const dependentTasks = allTasks.filter((t) =>
      t.dependencies.includes(currentTask.id)
    );

    // 选择耗时最长的依赖任务继续
    const nextTask = dependentTasks.sort(
      (a, b) => b.estimatedTime - a.estimatedTime
    )[0];

    if (nextTask) {
      this.dfsCriticalPath(nextTask, allTasks, path, visited);
    }
  }

  // ============ 🔶-2: 复杂度分析增强 ============

  /**
   * 记录实际执行轮次并校准预估
   */
  recordActualRounds(task: string, estimated: number, actual: number): void {
    if (!this.actualRoundsHistory.has(task)) {
      this.actualRoundsHistory.set(task, []);
    }
    const arr = this.actualRoundsHistory.get(task)!;
    arr.push({ estimated, actual });
    if (arr.length > TaskComplexityAnalyzer.HISTORY_MAX_PER_TASK) {
      arr.splice(0, arr.length - TaskComplexityAnalyzer.HISTORY_MAX_PER_TASK);
    }
    this._trimHistoryKeys(this.actualRoundsHistory);
  }

  recordActualDuration(task: string, estimated: number, actual: number): void {
    if (!this.actualDurationHistory.has(task)) {
      this.actualDurationHistory.set(task, []);
    }
    const arr = this.actualDurationHistory.get(task)!;
    arr.push({ estimated, actual });
    if (arr.length > TaskComplexityAnalyzer.HISTORY_MAX_PER_TASK) {
      arr.splice(0, arr.length - TaskComplexityAnalyzer.HISTORY_MAX_PER_TASK);
    }
    this._trimHistoryKeys(this.actualDurationHistory);
  }

  private _trimHistoryKeys(
    map: Map<string, Array<{ estimated: number; actual: number }>>
  ): void {
    if (map.size <= TaskComplexityAnalyzer.HISTORY_MAX_KEYS) return;
    const keys = Array.from(map.keys());
    const toRemove = keys.slice(
      0,
      map.size - TaskComplexityAnalyzer.HISTORY_MAX_KEYS
    );
    for (const k of toRemove) {
      map.delete(k);
    }
  }

  /**
   * 基于历史数据校准预估时间
   */
  calibrateTimeWithHistory(
    task: string,
    estimatedTime: number
  ): number | undefined {
    const history = this.actualDurationHistory.get(task);
    if (!history || history.length < 3) return undefined;
    const avgActual =
      history.reduce((sum, r) => sum + r.actual, 0) / history.length;
    const avgEstimated =
      history.reduce((sum, r) => sum + r.estimated, 0) / history.length;
    if (avgEstimated === 0) return estimatedTime;
    const ratio = avgActual / avgEstimated;
    return Math.round(estimatedTime * ratio);
  }

  /**
   * 获取校准后的预估轮次（私有）
   */
  private getCalibratedRounds(task: string): number | undefined {
    const history = this.actualRoundsHistory.get(task);
    if (!history || history.length < 3) return undefined;
    const avgActual =
      history.reduce((sum, r) => sum + r.actual, 0) / history.length;
    return Math.round(avgActual);
  }

  /**
   * 记录预测准确率
   */
  recordPredictionAccuracy(
    task: string,
    predicted: string,
    actual: string
  ): void {
    this.predictionRecords.push({ task, predicted, actual });
    if (
      this.predictionRecords.length >
      TaskComplexityAnalyzer.PREDICTION_RECORDS_MAX
    ) {
      this.predictionRecords.splice(
        0,
        this.predictionRecords.length -
          TaskComplexityAnalyzer.PREDICTION_RECORDS_MAX
      );
    }
  }

  /**
   * 获取预测准确率统计
   */
  getPredictionAccuracy(): PredictionAccuracy {
    const total = this.predictionRecords.length;
    if (total === 0) return { total: 0, correct: 0, rate: 0 };
    const correct = this.predictionRecords.filter(
      (r) => r.predicted === r.actual
    ).length;
    return { total, correct, rate: correct / total };
  }

  /**
   * 获取混淆矩阵
   */
  getConfusionMatrix(): ConfusionMatrix {
    const matrix: ConfusionMatrix = {};
    for (const record of this.predictionRecords) {
      if (!matrix[record.predicted]) {
        matrix[record.predicted] = {};
      }
      if (!matrix[record.predicted][record.actual]) {
        matrix[record.predicted][record.actual] = 0;
      }
      matrix[record.predicted][record.actual]++;
    }
    return matrix;
  }

  /**
   * 多维度复杂度评估（私有）
   */
  private assessMultiDimensionalComplexity(
    task: string,
    keywords: string[],
    estimatedSteps: number
  ): MultiDimensionalComplexity {
    const timeScore = Math.min(estimatedSteps / 5, 1);
    const depScore = this.checkSequentialPatterns(task)
      ? 0.8
      : this.checkConditionalPatterns(task)
        ? 0.5
        : 0.2;
    const toolScore = Math.min(keywords.length / 5, 1);

    return {
      timeComplexity: {
        level: timeScore >= 0.6 ? 'high' : timeScore >= 0.3 ? 'medium' : 'low',
        score: timeScore,
      },
      dependencyComplexity: {
        level: depScore >= 0.6 ? 'high' : depScore >= 0.3 ? 'medium' : 'low',
        score: depScore,
      },
      toolComplexity: {
        level: toolScore >= 0.6 ? 'high' : toolScore >= 0.3 ? 'medium' : 'low',
        score: toolScore,
      },
    };
  }

  /**
   * 检测领域标签（私有）
   */
  private detectDomainTag(task: string): 'data' | 'doc' | 'pm' | null {
    const dataKeywords = [
      '数据',
      'ETL',
      '清洗',
      '特征工程',
      '管道',
      '分析',
      '统计',
    ];
    const docKeywords = ['文档', 'OCR', '转换', 'PDF', 'Word', 'Excel'];
    const pmKeywords = ['里程碑', '甘特图', '规划', '项目', '任务', '进度'];

    if (dataKeywords.some((kw) => task.includes(kw))) return 'data';
    if (docKeywords.some((kw) => task.includes(kw))) return 'doc';
    if (pmKeywords.some((kw) => task.includes(kw))) return 'pm';
    return null;
  }

  /**
   * 评估任务的并行度详情
   */
  private assessParallelism(
    task: string,
    hasParallelism: boolean,
    hasSequential: boolean
  ): {
    level: 'none' | 'low' | 'medium' | 'high' | 'full';
    score: number;
    parallelizableSteps: number;
    sequentialSteps: number;
    suggestions: string[];
  } {
    const suggestions: string[] = [];
    const parallelMarkers = ['同时', '并行', '分别', '各自'];
    const sequentialMarkers = ['然后', '接着', '之后', '最后', '首先'];

    const parallelCount = parallelMarkers.filter((m) =>
      task.includes(m)
    ).length;
    const sequentialCount = sequentialMarkers.filter((m) =>
      task.includes(m)
    ).length;

    const parallelizableSteps = hasParallelism
      ? Math.max(parallelCount, hasParallelism ? 2 : 0)
      : 0;
    const sequentialSteps = sequentialCount;

    if (hasSequential && !hasParallelism) {
      return {
        level: 'none',
        score: 0,
        parallelizableSteps: 0,
        sequentialSteps: Math.max(sequentialSteps, 1),
        suggestions: ['任务存在顺序依赖，无法并行化'],
      };
    }

    if (!hasParallelism) {
      return {
        level: 'none',
        score: 0,
        parallelizableSteps: 0,
        sequentialSteps,
        suggestions: [],
      };
    }

    let level: 'none' | 'low' | 'medium' | 'high' | 'full';
    let score: number;

    if (parallelCount >= 2 && !hasSequential) {
      level = 'full';
      score = 1.0;
      suggestions.push('任务高度可并行，建议拆分为独立子任务同时执行');
    } else if (parallelCount >= 1 && !hasSequential) {
      level = 'high';
      score = 0.8;
      suggestions.push('任务具备并行潜力，可拆分为并行子任务');
    } else if (hasParallelism && hasSequential) {
      level = 'medium';
      score = 0.5;
      suggestions.push('存在部分顺序依赖，建议混合并行+串行执行');
    } else {
      level = 'low';
      score = 0.3;
      suggestions.push('任务部分可并行化');
    }

    return {
      level,
      score,
      parallelizableSteps,
      sequentialSteps,
      suggestions,
    };
  }

  /**
   * 设置 LLM 依赖
   */
  setLLMDeps(deps: ComplexityLLMDeps): void {
    this.llmDeps = deps;
  }

  /**
   * 使用 LLM 辅助分析复杂度
   */
  async analyzeComplexityWithLLM(task: string): Promise<TaskComplexityResult> {
    const baseResult = this.analyzeComplexity(task);

    if (!this.llmDeps) {
      return baseResult;
    }

    try {
      const prompt = `分析以下任务的复杂度，返回JSON格式: {"complexity": "simple|medium|complex|very_complex", "confidence": 0-1, "estimatedSteps": number}\n任务: ${task}`;
      const response = await this.llmDeps.chat(prompt);
      const parsed = JSON.parse(response);

      const validComplexities = ['simple', 'medium', 'complex', 'very_complex'];
      const confidence =
        typeof parsed.confidence === 'number'
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5;
      const complexity = validComplexities.includes(parsed.complexity)
        ? parsed.complexity
        : baseResult.complexity;
      const estimatedSteps =
        typeof parsed.estimatedSteps === 'number' &&
        parsed.estimatedSteps >= 1 &&
        parsed.estimatedSteps <= 100
          ? Math.round(parsed.estimatedSteps)
          : baseResult.estimatedSteps;

      baseResult.llmConfidence = confidence;
      baseResult.llmAssistedComplexity = {
        complexity: complexity as TaskComplexityResult['complexity'],
        confidence,
        estimatedSteps,
      };

      if (confidence >= 0.7 && complexity) {
        baseResult.complexity =
          complexity as TaskComplexityResult['complexity'];
        baseResult.estimatedSteps = estimatedSteps;
      }
    } catch {
      baseResult.llmConfidence = 0.5;
    }

    return baseResult;
  }

  /**
   * 记录置信度校准数据
   */
  recordConfidenceCalibration(confidence: number, correct: boolean): void {
    const bucket = confidence.toFixed(1);
    if (!this.confidenceCalibrationMap.has(bucket)) {
      this.confidenceCalibrationMap.set(bucket, { total: 0, correct: 0 });
    }
    const entry = this.confidenceCalibrationMap.get(bucket)!;
    entry.total++;
    if (correct) entry.correct++;
  }

  /**
   * 获取置信度校准数据
   */
  getConfidenceCalibration(): ConfidenceCalibration {
    const result: ConfidenceCalibration = {};
    for (const [bucket, entry] of this.confidenceCalibrationMap) {
      result[bucket] = {
        total: entry.total,
        correct: entry.correct,
        accuracy: entry.total > 0 ? entry.correct / entry.total : 0,
      };
    }
    return result;
  }
}

export default TaskComplexityAnalyzer;
