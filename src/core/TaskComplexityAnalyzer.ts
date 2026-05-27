/**
 * 任务复杂度分析模块
 * 分析任务的复杂度，提供任务拆解建议
 */

export interface TaskComplexityResult {
  complexity: 'simple' | 'medium' | 'complex' | 'very_complex';
  estimatedSteps: number;
  estimatedTime: number; // 分钟
  requiresTools: string[];
  riskFactors: string[];
  recommendations: string[];
  dependencies: string[];
  parallelizable: boolean;
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
      hasSequential
    );

    return {
      complexity: this.determineComplexityLevel(estimatedSteps, keywords),
      estimatedSteps,
      estimatedTime: this.estimateTime(estimatedSteps),
      requiresTools: this.identifyRequiredTools(keywords),
      riskFactors: this.identifyRiskFactors(task, keywords),
      recommendations: this.generateRecommendations(keywords, estimatedSteps),
      dependencies: this.identifyDependencies(task, keywords),
      parallelizable: hasParallelism && !hasSequential,
    };
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
    hasSequential: boolean
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

    // 检查是否有依赖关系
    for (const task of existingTasks) {
      // 如果当前任务提到之前任务的内容，可能存在依赖
      if (currentPart.includes(task.description.substring(0, 10))) {
        dependencies.push(task.id);
      }
    }

    // 如果没有找到依赖，默认依赖前一个任务
    if (dependencies.length === 0 && existingTasks.length > 0) {
      dependencies.push(existingTasks[existingTasks.length - 1].id);
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
}

export default TaskComplexityAnalyzer;
