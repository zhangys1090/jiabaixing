"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TreeOfThoughtEngine = void 0;
const Logger_1 = require("../utils/Logger");
class TreeOfThoughtEngine {
    constructor(llm) {
        this.llm = llm;
        this.pruningThreshold = 0.3;
        this.maxTotalNodes = 50;
        this.nodeCount = 0;
    }
    async reason(problem, options) {
        const maxDepth = options?.maxDepth ?? 3;
        const branchCount = options?.branchCount ?? 3;
        const evaluationTopK = options?.evaluationTopK ?? 2;
        this.pruningThreshold = options?.pruningThreshold ?? 0.3;
        this.maxTotalNodes = options?.maxTotalNodes ?? 50;
        this.nodeCount = 0;
        Logger_1.Logger.info(`🌳 ToT 推理启动: depth=${maxDepth}, branches=${branchCount}, prune=${this.pruningThreshold}`, 'TreeOfThought');
        const root = {
            id: 'root',
            thought: problem,
            score: 0,
            children: [],
            depth: 0,
        };
        this.nodeCount = 1;
        await this.expandToTNode(root, maxDepth, branchCount, evaluationTopK);
        const bestPath = this.findBestToTPath(root);
        const allNodes = this.flattenToTTree(root);
        const evaluations = allNodes
            .filter((n) => n.score > 0)
            .map((n) => ({ path: n.id, score: n.score, reasoning: n.thought }));
        const answer = bestPath.length > 0
            ? bestPath[bestPath.length - 1].thought
            : '无法通过多路径推理得出结论';
        const prunedCount = this.maxTotalNodes > 0 ? Math.max(0, allNodes.length - this.nodeCount) : 0;
        Logger_1.Logger.info(`🌳 ToT 推理完成: ${allNodes.length} 节点, 最佳路径深度=${bestPath.length}, 剪枝=${prunedCount}`, 'TreeOfThought');
        return { answer, reasoningPaths: allNodes, bestPath, evaluations };
    }
    async expandToTNode(node, maxDepth, branchCount, topK) {
        if (node.depth >= maxDepth)
            return;
        if (this.nodeCount >= this.maxTotalNodes) {
            Logger_1.Logger.info(`🌳 ToT 达到节点上限(${this.maxTotalNodes})，停止扩展`, 'TreeOfThought');
            return;
        }
        if (node.score > 0 && node.score < this.pruningThreshold) {
            Logger_1.Logger.info(`🌳 ToT 剪枝: 节点${node.id}评分${node.score.toFixed(2)}<阈值${this.pruningThreshold}`, 'TreeOfThought');
            return;
        }
        try {
            const prompt = this.buildExpansionPrompt(node, branchCount);
            const response = await this.llm.chat(prompt);
            const thoughts = this.parseThoughts(response || '', branchCount);
            const candidates = [];
            for (const thought of thoughts) {
                const evalPrompt = this.buildEvaluationPrompt(node.thought, thought);
                const evalResponse = await this.llm.chat(evalPrompt);
                const score = this.parseScore(evalResponse || '');
                candidates.push({ thought, score });
            }
            candidates.sort((a, b) => b.score - a.score);
            const topCandidates = candidates.slice(0, topK);
            for (let i = 0; i < topCandidates.length; i++) {
                if (this.nodeCount >= this.maxTotalNodes)
                    break;
                const { thought, score } = topCandidates[i];
                const child = {
                    id: `${node.id}_${i}`,
                    thought,
                    score,
                    children: [],
                    depth: node.depth + 1,
                    parentId: node.id,
                };
                node.children.push(child);
                this.nodeCount++;
                await this.expandToTNode(child, maxDepth, branchCount, topK);
            }
        }
        catch (error) {
            Logger_1.Logger.warn(`⚠️ ToT 扩展失败 (depth=${node.depth}): ${error.message}`, 'TreeOfThought');
        }
    }
    buildExpansionPrompt(node, branchCount) {
        const pathContext = this.getPathContext(node);
        return `你是一个推理专家。请针对以下问题，生成 ${branchCount} 个不同的推理方向。

问题: ${node.thought}

${pathContext ? `已有推理路径:\n${pathContext}\n` : ''}

请按以下格式输出，每个方向占一行:
THOUGHT_1: [推理方向1]
THOUGHT_2: [推理方向2]
THOUGHT_3: [推理方向3]`;
    }
    buildEvaluationPrompt(context, thought) {
        return `评估以下推理步骤的质量，给出0-10的分数。

上下文: ${context}
推理步骤: ${thought}

请只输出一个0-10之间的数字分数，不要输出其他内容。`;
    }
    parseThoughts(response, count) {
        const thoughts = [];
        const regex = /THOUGHT_\d+:\s*(.+)/g;
        let match;
        while ((match = regex.exec(response)) !== null) {
            thoughts.push(match[1].trim());
        }
        if (thoughts.length === 0) {
            const lines = response.split('\n').filter((l) => l.trim().length > 10);
            return lines.slice(0, count);
        }
        return thoughts.slice(0, count);
    }
    parseScore(response) {
        const match = response.match(/(\d+(?:\.\d+)?)/);
        if (match) {
            const score = parseFloat(match[1]);
            return Math.min(10, Math.max(0, score)) / 10;
        }
        return 0.5;
    }
    getPathContext(node) {
        const parts = [];
        let current = node;
        while (current && current.id !== 'root') {
            parts.unshift(current.thought);
            if (current.parentId) {
                current = this.findNodeById(node, current.parentId);
            }
            else {
                break;
            }
        }
        return parts.join(' → ');
    }
    findNodeById(root, id) {
        if (root.id === id)
            return root;
        for (const child of root.children) {
            const found = this.findNodeById(child, id);
            if (found)
                return found;
        }
        return undefined;
    }
    findBestToTPath(root) {
        const allPaths = [];
        this.collectPaths(root, [], allPaths);
        if (allPaths.length === 0)
            return [];
        allPaths.sort((a, b) => {
            const scoreA = a.reduce((s, n) => s + n.score, 0) / Math.max(1, a.length);
            const scoreB = b.reduce((s, n) => s + n.score, 0) / Math.max(1, b.length);
            return scoreB - scoreA;
        });
        return allPaths[0];
    }
    collectPaths(node, current, result) {
        const path = [...current, node];
        if (node.children.length === 0) {
            result.push(path);
            return;
        }
        for (const child of node.children) {
            this.collectPaths(child, path, result);
        }
    }
    flattenToTTree(node) {
        const result = [node];
        for (const child of node.children) {
            result.push(...this.flattenToTTree(child));
        }
        return result;
    }
}
exports.TreeOfThoughtEngine = TreeOfThoughtEngine;
