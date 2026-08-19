"use strict";
/**
 * 任务复杂度分析模块
 * 分析任务的复杂度，提供任务拆解建议
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskComplexityAnalyzer = void 0;
class TaskComplexityAnalyzer {
    constructor() {
        this.complexityKeywords = {
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
        this.domainKeywords = {
            data: ['数据', '清洗', '特征', '建模', '挖掘', '可视化', 'ETL', '分析'],
            document: ['文档', '转换', 'OCR', '提取', '解析', 'PDF', 'Word', 'Excel'],
            project: ['里程碑', '甘特图', '依赖', '管理', '排期', '任务', '进度'],
            code: ['代码', '函数', '类', '模块', 'API', '接口', '调试', '编译'],
            devops: ['部署', '容器', 'Docker', 'K8s', 'CI/CD', '监控', '日志'],
        };
        this.toolMappings = {
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
        this.actualRoundsHistory = new Map();
        /** 实际执行时长历史 — key 为任务描述 */
        this.actualDurationHistory = new Map();
        /** 预测准确率记录 */
        this.predictionRecords = [];
        /** 置信度校准数据 — key 为置信度桶（如 "0.9"） */
        this.confidenceCalibrationMap = new Map();
        /** LLM 依赖 */
        this.llmDeps = null;
    }
    /**
     * 分析任务复杂度
     */
    analyzeComplexity(task) {
        const keywords = this.extractKeywords(task);
        const hasConditions = this.checkConditionalPatterns(task);
        const hasParallelism = this.checkParallelPatterns(task);
        const hasSequential = this.checkSequentialPatterns(task);
        const estimatedSteps = this.estimateSteps(keywords, hasConditions, hasParallelism, hasSequential, task);
        const result = {
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
        result.multiDimensional = this.assessMultiDimensionalComplexity(task, keywords, estimatedSteps);
        // 领域标签
        result.domainTag = this.detectDomainTag(task);
        // 并行度详情
        result.parallelismDetail = this.assessParallelism(task, hasParallelism, hasSequential);
        result.parallelismScore = result.parallelismDetail.score;
        return result;
    }
    /**
     * 深度拆解任务
     */
    decomposeTask(task) {
        const complexity = this.analyzeComplexity(task);
        const subTasks = [];
        // 根据复杂度生成子任务
        if (complexity.complexity === 'simple') {
            // 简单任务不需要拆解
            subTasks.push(this.createSubTask(task, 1, [], complexity.complexity));
        }
        else {
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
            totalEstimatedTime: subTasks.reduce((sum, st) => sum + st.estimatedTime, 0),
            parallelGroups,
            criticalPath,
        };
    }
    extractKeywords(task) {
        const allKeywords = Object.values(this.complexityKeywords).flat();
        const words = task.toLowerCase().split(/[\s,.!?，。！？、；：]/);
        return words.filter((word) => allKeywords.some((kw) => word.includes(kw.toLowerCase()) || kw.toLowerCase().includes(word)));
    }
    checkConditionalPatterns(task) {
        return this.complexityKeywords.conditional.some((kw) => task.includes(kw));
    }
    checkParallelPatterns(task) {
        return this.complexityKeywords.parallel.some((kw) => task.includes(kw));
    }
    checkSequentialPatterns(task) {
        return this.complexityKeywords.sequential.some((kw) => task.includes(kw));
    }
    estimateSteps(keywords, hasConditions, hasParallelism, hasSequential, task) {
        let baseSteps = 1;
        // 高复杂度关键词
        baseSteps +=
            keywords.filter((kw) => this.complexityKeywords.high.some((hk) => kw.includes(hk.toLowerCase()))).length * 3;
        // 中等复杂度关键词
        baseSteps +=
            keywords.filter((kw) => this.complexityKeywords.medium.some((mk) => kw.includes(mk.toLowerCase()))).length * 2;
        // 领域关键词识别 — 直接检查任务文本中的领域关键词
        if (task) {
            for (const domainKeywords of Object.values(this.domainKeywords)) {
                const matchedCount = domainKeywords.filter((dk) => task.includes(dk)).length;
                baseSteps += matchedCount;
            }
        }
        // 条件判断增加步骤
        if (hasConditions)
            baseSteps += 2;
        // 并行处理减少步骤
        if (hasParallelism)
            baseSteps = Math.max(1, baseSteps * 0.8);
        // 顺序执行增加步骤
        if (hasSequential)
            baseSteps += 1;
        return Math.max(1, Math.round(baseSteps));
    }
    determineComplexityLevel(steps, keywords) {
        const highKeywordCount = keywords.filter((kw) => this.complexityKeywords.high.some((hk) => kw.includes(hk.toLowerCase()))).length;
        if (steps >= 10 || highKeywordCount >= 3)
            return 'very_complex';
        if (steps >= 6 || highKeywordCount >= 2)
            return 'complex';
        if (steps >= 3)
            return 'medium';
        return 'simple';
    }
    estimateTime(steps) {
        const timePerStep = 5;
        return steps * timePerStep;
    }
    identifyRequiredTools(keywords) {
        const tools = [];
        for (const keyword of keywords) {
            for (const [key, value] of Object.entries(this.toolMappings)) {
                if (keyword.includes(key.toLowerCase()) &&
                    !tools.some((t) => value.includes(t))) {
                    tools.push(...value);
                }
            }
        }
        return tools.length > 0 ? [...new Set(tools)] : ['GeneralTool'];
    }
    identifyRiskFactors(task, keywords) {
        const risks = [];
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
        }
        else if (domainTag === 'doc') {
            risks.push('文档格式风险：可能存在格式不一致或编码问题');
        }
        else if (domainTag === 'pm') {
            risks.push('项目进度风险：可能存在资源或时间约束');
        }
        return risks;
    }
    generateRecommendations(keywords, steps) {
        const recommendations = [];
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
    identifyDependencies(task, _keywords) {
        const dependencies = [];
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
    createSubTask(description, id, dependencies, complexity) {
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
    extractTaskParts(task) {
        // 使用标点符号和连接词分割任务
        const separators = /[，。；！？,;!?]|然后|接着|之后|首先|最后|同时|并且|以及/;
        const parts = task
            .split(separators)
            .filter((part) => part.trim().length > 0);
        if (parts.length === 1) {
            // 如果无法分割，尝试根据动词分割
            return this.splitByVerbs(task);
        }
        return parts.map((part) => part.trim());
    }
    splitByVerbs(task) {
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
        const parts = [];
        let currentPart = '';
        const words = task.split(/[\s,.!?，。！？、]/);
        for (const word of words) {
            if (verbs.some((v) => word.includes(v)) && currentPart.length > 0) {
                parts.push(currentPart.trim());
                currentPart = word;
            }
            else {
                currentPart += word;
            }
        }
        if (currentPart.length > 0) {
            parts.push(currentPart.trim());
        }
        return parts.length > 0 ? parts : [task];
    }
    calculateDependencies(existingTasks, currentPart, _currentId) {
        const dependencies = [];
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
    calculateParallelGroups(subTasks) {
        const groups = [];
        const processed = new Set();
        for (const task of subTasks) {
            if (processed.has(task.id))
                continue;
            // 找到可以并行执行的任务组
            const parallelGroup = subTasks
                .filter((t) => t.canParallel &&
                !processed.has(t.id) &&
                this.canExecuteInParallel(t, task, subTasks))
                .map((t) => t.id);
            if (parallelGroup.length > 1) {
                groups.push(parallelGroup);
                parallelGroup.forEach((id) => processed.add(id));
            }
        }
        return groups;
    }
    canExecuteInParallel(task1, task2, _allTasks) {
        // 检查两个任务是否有依赖关系
        const hasDependency = task1.dependencies.includes(task2.id) ||
            task2.dependencies.includes(task1.id);
        // 检查是否有共同的依赖
        const commonDependencies = task1.dependencies.filter((dep) => task2.dependencies.includes(dep));
        return !hasDependency && commonDependencies.length === 0;
    }
    calculateCriticalPath(subTasks) {
        // 简化的关键路径计算
        // 实际应用中应使用更复杂的算法（如CPM）
        const path = [];
        const visited = new Set();
        // 找到没有依赖的任务作为起点
        const startTasks = subTasks.filter((t) => t.dependencies.length === 0);
        for (const startTask of startTasks) {
            this.dfsCriticalPath(startTask, subTasks, path, visited);
        }
        return path;
    }
    dfsCriticalPath(currentTask, allTasks, path, visited) {
        if (visited.has(currentTask.id))
            return;
        visited.add(currentTask.id);
        path.push(currentTask.id);
        // 找到依赖于当前任务的所有任务
        const dependentTasks = allTasks.filter((t) => t.dependencies.includes(currentTask.id));
        // 选择耗时最长的依赖任务继续
        const nextTask = dependentTasks.sort((a, b) => b.estimatedTime - a.estimatedTime)[0];
        if (nextTask) {
            this.dfsCriticalPath(nextTask, allTasks, path, visited);
        }
    }
    // ============ 🔶-2: 复杂度分析增强 ============
    /**
     * 记录实际执行轮次并校准预估
     */
    recordActualRounds(task, estimated, actual) {
        if (!this.actualRoundsHistory.has(task)) {
            this.actualRoundsHistory.set(task, []);
        }
        this.actualRoundsHistory.get(task).push({ estimated, actual });
    }
    /**
     * 记录实际执行时长并校准预估
     */
    recordActualDuration(task, estimated, actual) {
        if (!this.actualDurationHistory.has(task)) {
            this.actualDurationHistory.set(task, []);
        }
        this.actualDurationHistory.get(task).push({ estimated, actual });
    }
    /**
     * 基于历史数据校准预估时间
     */
    calibrateTimeWithHistory(task, estimatedTime) {
        const history = this.actualDurationHistory.get(task);
        if (!history || history.length < 3)
            return undefined;
        const avgActual = history.reduce((sum, r) => sum + r.actual, 0) / history.length;
        const avgEstimated = history.reduce((sum, r) => sum + r.estimated, 0) / history.length;
        if (avgEstimated === 0)
            return estimatedTime;
        const ratio = avgActual / avgEstimated;
        return Math.round(estimatedTime * ratio);
    }
    /**
     * 获取校准后的预估轮次（私有）
     */
    getCalibratedRounds(task) {
        const exactHistory = this.actualRoundsHistory.get(task);
        if (exactHistory && exactHistory.length >= 3) {
            const avgActual = exactHistory.reduce((sum, r) => sum + r.actual, 0) / exactHistory.length;
            return Math.round(avgActual);
        }
        const fuzzyMatch = this.findFuzzyHistoryMatch(task);
        if (fuzzyMatch) {
            const ratio = fuzzyMatch.avgActual / fuzzyMatch.avgEstimated;
            Logger_1.Logger.info(`📊 模糊校准: 相似任务平均比率=${ratio.toFixed(2)}`, 'TaskComplexityAnalyzer');
            return undefined;
        }
        return undefined;
    }
    findFuzzyHistoryMatch(task) {
        const taskKeywords = this.extractKeywords(task);
        const taskSet = new Set(taskKeywords.high.concat(taskKeywords.medium));
        if (taskSet.size === 0)
            return null;
        let bestMatch = null;
        let bestScore = 0.5;
        for (const [histTask, records] of this.actualRoundsHistory) {
            if (records.length < 2)
                continue;
            const histKeywords = this.extractKeywords(histTask);
            const histSet = new Set(histKeywords.high.concat(histKeywords.medium));
            if (histSet.size === 0)
                continue;
            const intersection = new Set([...taskSet].filter((k) => histSet.has(k)));
            const union = new Set([...taskSet, ...histSet]);
            const jaccard = intersection.size / union.size;
            if (jaccard > bestScore) {
                bestScore = jaccard;
                bestMatch = {
                    task: histTask,
                    avgActual: records.reduce((s, r) => s + r.actual, 0) / records.length,
                    avgEstimated: records.reduce((s, r) => s + r.estimated, 0) / records.length,
                    similarity: jaccard,
                };
            }
        }
        return bestMatch;
    }
    /**
     * 记录预测准确率
     */
    recordPredictionAccuracy(task, predicted, actual) {
        this.predictionRecords.push({ task, predicted, actual });
    }
    /**
     * 获取预测准确率统计
     */
    getPredictionAccuracy() {
        const total = this.predictionRecords.length;
        if (total === 0)
            return { total: 0, correct: 0, rate: 0 };
        const correct = this.predictionRecords.filter((r) => r.predicted === r.actual).length;
        return { total, correct, rate: correct / total };
    }
    /**
     * 获取混淆矩阵
     */
    getConfusionMatrix() {
        const matrix = {};
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
    assessMultiDimensionalComplexity(task, keywords, estimatedSteps) {
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
    detectDomainTag(task) {
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
        if (dataKeywords.some((kw) => task.includes(kw)))
            return 'data';
        if (docKeywords.some((kw) => task.includes(kw)))
            return 'doc';
        if (pmKeywords.some((kw) => task.includes(kw)))
            return 'pm';
        return null;
    }
    /**
     * 评估任务的并行度详情
     */
    assessParallelism(task, hasParallelism, hasSequential) {
        const suggestions = [];
        const parallelMarkers = ['同时', '并行', '分别', '各自'];
        const sequentialMarkers = ['然后', '接着', '之后', '最后', '首先'];
        const parallelCount = parallelMarkers.filter((m) => task.includes(m)).length;
        const sequentialCount = sequentialMarkers.filter((m) => task.includes(m)).length;
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
        let level;
        let score;
        if (parallelCount >= 2 && !hasSequential) {
            level = 'full';
            score = 1.0;
            suggestions.push('任务高度可并行，建议拆分为独立子任务同时执行');
        }
        else if (parallelCount >= 1 && !hasSequential) {
            level = 'high';
            score = 0.8;
            suggestions.push('任务具备并行潜力，可拆分为并行子任务');
        }
        else if (hasParallelism && hasSequential) {
            level = 'medium';
            score = 0.5;
            suggestions.push('存在部分顺序依赖，建议混合并行+串行执行');
        }
        else {
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
    setLLMDeps(deps) {
        this.llmDeps = deps;
    }
    /**
     * 使用 LLM 辅助分析复杂度
     */
    async analyzeComplexityWithLLM(task) {
        const baseResult = this.analyzeComplexity(task);
        if (!this.llmDeps) {
            return baseResult;
        }
        try {
            const prompt = `分析以下任务的复杂度，返回JSON格式: {"complexity": "simple|medium|complex|very_complex", "confidence": 0-1, "estimatedSteps": number}\n任务: ${task}`;
            const response = await this.llmDeps.chat(prompt);
            const parsed = JSON.parse(response);
            const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;
            const complexity = parsed.complexity;
            const estimatedSteps = typeof parsed.estimatedSteps === 'number' ? parsed.estimatedSteps : 0;
            baseResult.llmConfidence = confidence;
            baseResult.llmAssistedComplexity = {
                complexity,
                confidence,
                estimatedSteps,
            };
            // 高置信度时覆盖基础复杂度
            if (confidence >= 0.7 && complexity) {
                baseResult.complexity = complexity;
                baseResult.estimatedSteps = estimatedSteps;
            }
        }
        catch {
            baseResult.llmConfidence = 0.5;
        }
        return baseResult;
    }
    /**
     * 记录置信度校准数据
     */
    recordConfidenceCalibration(confidence, correct) {
        const bucket = confidence.toFixed(1);
        if (!this.confidenceCalibrationMap.has(bucket)) {
            this.confidenceCalibrationMap.set(bucket, { total: 0, correct: 0 });
        }
        const entry = this.confidenceCalibrationMap.get(bucket);
        entry.total++;
        if (correct)
            entry.correct++;
    }
    /**
     * 获取置信度校准数据
     */
    getConfidenceCalibration() {
        const result = {};
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
exports.TaskComplexityAnalyzer = TaskComplexityAnalyzer;
exports.default = TaskComplexityAnalyzer;
