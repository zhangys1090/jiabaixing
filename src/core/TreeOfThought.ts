import type { LLMProvider } from '../models/LLMProvider';
import { Logger } from '../utils/Logger';

export interface ToTNode {
  id: string;
  thought: string;
  score: number;
  children: ToTNode[];
  depth: number;
  parentId?: string;
}

export interface ToTResult {
  answer: string;
  reasoningPaths: ToTNode[];
  bestPath: ToTNode[];
  evaluations: Array<{ path: string; score: number; reasoning: string }>;
}

export interface ToTOptions {
  maxDepth?: number;
  branchCount?: number;
  evaluationTopK?: number;
}

export class TreeOfThoughtEngine {
  private llm: LLMProvider;

  constructor(llm: LLMProvider) {
    this.llm = llm;
  }

  async reason(problem: string, options?: ToTOptions): Promise<ToTResult> {
    const maxDepth = options?.maxDepth ?? 3;
    const branchCount = options?.branchCount ?? 3;
    const evaluationTopK = options?.evaluationTopK ?? 2;

    Logger.info(
      `🌳 ToT 推理启动: depth=${maxDepth}, branches=${branchCount}`,
      'TreeOfThought'
    );

    const root: ToTNode = {
      id: 'root',
      thought: problem,
      score: 0,
      children: [],
      depth: 0,
    };

    await this.expandToTNode(root, maxDepth, branchCount, evaluationTopK);

    const bestPath = this.findBestToTPath(root);
    const allNodes = this.flattenToTTree(root);
    const evaluations = allNodes
      .filter((n) => n.score > 0)
      .map((n) => ({ path: n.id, score: n.score, reasoning: n.thought }));

    const answer =
      bestPath.length > 0
        ? bestPath[bestPath.length - 1].thought
        : '无法通过多路径推理得出结论';

    Logger.info(
      `🌳 ToT 推理完成: ${allNodes.length} 节点, 最佳路径深度=${bestPath.length}`,
      'TreeOfThought'
    );

    return { answer, reasoningPaths: allNodes, bestPath, evaluations };
  }

  private async expandToTNode(
    node: ToTNode,
    maxDepth: number,
    branchCount: number,
    topK: number
  ): Promise<void> {
    if (node.depth >= maxDepth) return;

    try {
      const prompt = this.buildExpansionPrompt(node, branchCount);
      const response = await this.llm.chat(prompt);
      const thoughts = this.parseThoughts(response || '', branchCount);

      const candidates: Array<{ thought: string; score: number }> = [];
      for (const thought of thoughts) {
        const evalPrompt = this.buildEvaluationPrompt(node.thought, thought);
        const evalResponse = await this.llm.chat(evalPrompt);
        const score = this.parseScore(evalResponse || '');
        candidates.push({ thought, score });
      }

      candidates.sort((a, b) => b.score - a.score);
      const topCandidates = candidates.slice(0, topK);

      for (let i = 0; i < topCandidates.length; i++) {
        const { thought, score } = topCandidates[i];
        const child: ToTNode = {
          id: `${node.id}_${i}`,
          thought,
          score,
          children: [],
          depth: node.depth + 1,
          parentId: node.id,
        };
        node.children.push(child);
        await this.expandToTNode(child, maxDepth, branchCount, topK);
      }
    } catch (error) {
      Logger.warn(
        `⚠️ ToT 扩展失败 (depth=${node.depth}): ${(error as Error).message}`,
        'TreeOfThought'
      );
    }
  }

  private buildExpansionPrompt(node: ToTNode, branchCount: number): string {
    const pathContext = this.getPathContext(node);
    return `你是一个推理专家。请针对以下问题，生成 ${branchCount} 个不同的推理方向。

问题: ${node.thought}

${pathContext ? `已有推理路径:\n${pathContext}\n` : ''}

请按以下格式输出，每个方向占一行:
THOUGHT_1: [推理方向1]
THOUGHT_2: [推理方向2]
THOUGHT_3: [推理方向3]`;
  }

  private buildEvaluationPrompt(context: string, thought: string): string {
    return `评估以下推理步骤的质量，给出0-10的分数。

上下文: ${context}
推理步骤: ${thought}

请只输出一个0-10之间的数字分数，不要输出其他内容。`;
  }

  private parseThoughts(response: string, count: number): string[] {
    const thoughts: string[] = [];
    const regex = /THOUGHT_\d+:\s*(.+)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(response)) !== null) {
      thoughts.push(match[1].trim());
    }
    if (thoughts.length === 0) {
      const lines = response.split('\n').filter((l) => l.trim().length > 10);
      return lines.slice(0, count);
    }
    return thoughts.slice(0, count);
  }

  private parseScore(response: string): number {
    const match = response.match(/(\d+(?:\.\d+)?)/);
    if (match) {
      const score = parseFloat(match[1]);
      return Math.min(10, Math.max(0, score)) / 10;
    }
    return 0.5;
  }

  private getPathContext(node: ToTNode): string {
    const parts: string[] = [];
    let current: ToTNode | undefined = node;
    while (current && current.id !== 'root') {
      parts.unshift(current.thought);
      if (current.parentId) {
        current = this.findNodeById(node, current.parentId);
      } else {
        break;
      }
    }
    return parts.join(' → ');
  }

  private findNodeById(root: ToTNode, id: string): ToTNode | undefined {
    if (root.id === id) return root;
    for (const child of root.children) {
      const found = this.findNodeById(child, id);
      if (found) return found;
    }
    return undefined;
  }

  private findBestToTPath(root: ToTNode): ToTNode[] {
    const allPaths: ToTNode[][] = [];
    this.collectPaths(root, [], allPaths);
    if (allPaths.length === 0) return [];

    allPaths.sort((a, b) => {
      const scoreA = a.reduce((s, n) => s + n.score, 0) / Math.max(1, a.length);
      const scoreB = b.reduce((s, n) => s + n.score, 0) / Math.max(1, b.length);
      return scoreB - scoreA;
    });

    return allPaths[0];
  }

  private collectPaths(
    node: ToTNode,
    current: ToTNode[],
    result: ToTNode[][]
  ): void {
    const path = [...current, node];
    if (node.children.length === 0) {
      result.push(path);
      return;
    }
    for (const child of node.children) {
      this.collectPaths(child, path, result);
    }
  }

  private flattenToTTree(node: ToTNode): ToTNode[] {
    const result: ToTNode[] = [node];
    for (const child of node.children) {
      result.push(...this.flattenToTTree(child));
    }
    return result;
  }
}
