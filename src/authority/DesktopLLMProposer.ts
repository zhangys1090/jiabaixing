import { Logger } from '../utils/Logger';
import { getPythonBridge } from '../server/bootstrap';
import {
  DecisionCandidate,
  DecisionContext,
  DecisionProposer,
  ProposedAction,
} from './types';

function generateCandidateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `C_llm_${ts}_${rand}`;
}

/**
 * D4-I2-2: DesktopLLMProposer — parseLLMAction() 不再直接决定执行。
 *
 * 之前：
 *   LLM → parseLLMAction() → authority.executeAction()（LLM 是隐式 FINAL）
 *
 * 现在：
 *   LLM → parseLLMAction() → DecisionCandidate → DecisionAuthority.decide() → FINAL → ActionAuthority
 *
 * DesktopLLMProposer 是 proposer，不是 authority。
 * 它只负责"提出候选动作"，不负责"选择最终动作"。
 */
export class DesktopLLMProposer implements DecisionProposer {
  public readonly proposerId = 'desktop_llm_proposer';

  constructor() {}

  private getMcpServer() {
    const { DesktopMCPServer } = require('../desktop/DesktopMCPServer');
    return DesktopMCPServer.getInstance();
  }

  private getVisionEngine() {
    const { DesktopVisionEngine } = require('../desktop/DesktopVisionEngine');
    return DesktopVisionEngine.getInstance();
  }

  public async propose(
    context: DecisionContext
  ): Promise<DecisionCandidate[]> {
    const candidates: DecisionCandidate[] = [];

    const taskInput = this.extractTaskInput(context);
    if (!taskInput) {
      return candidates;
    }

    try {
      const bridge = getPythonBridge();
      if (!bridge) {
        Logger.warn(
          'DesktopLLMProposer: Python Bridge not available, skipping',
          'DesktopLLMProposer'
        );
        return candidates;
      }

      const observation = await this.getVisionEngine().observe();
      const tools = this.getMcpServer().listTools();
      const toolsDescription = tools
        .map((t) => `- ${t.name}: ${t.description}`)
        .join('\n');

      const planPrompt = this.buildPlanningPrompt(
        taskInput,
        observation,
        toolsDescription
      );
      const systemPrompt = this.getSystemPrompt();

      const llmResponse = await bridge.llmChat(
        planPrompt,
        [],
        systemPrompt
      );

      const action = this.parseLLMAction(llmResponse);

      if (action && action.type !== 'done') {
        const proposedAction: ProposedAction = {
          type: 'desktop_action',
          payload: {
            actionType: action.type,
            params: action.params || {},
            description: action.description || action.type,
            reasoning: action.reasoning || '',
          },
        };

        const candidate: DecisionCandidate = {
          candidateId: generateCandidateId(),
          proposerId: this.proposerId,
          action: proposedAction,
          confidence: 0.7,
          reasoning: action.reasoning || `LLM proposes: ${action.type}`,
          estimatedGoalProgress: this.estimateProgress(context),
        };

        candidates.push(candidate);

        Logger.info(
          `DesktopLLMProposer: proposed "${action.type}" as candidate ${candidate.candidateId}`,
          'DesktopLLMProposer'
        );
      }
    } catch (e) {
      Logger.warn(
        `DesktopLLMProposer: LLM planning failed — ${(e as Error).message}`,
        'DesktopLLMProposer'
      );
    }

    return candidates;
  }

  private extractTaskInput(context: DecisionContext): string | null {
    const snapshot = context.snapshot;
    if (
      snapshot.context &&
      typeof snapshot.context === 'object' &&
      'taskDescription' in snapshot.context
    ) {
      return (snapshot.context as Record<string, unknown>)
        .taskDescription as string;
    }
    return null;
  }

  private parseLLMAction(response: string): {
    type: string;
    params?: Record<string, unknown>;
    description?: string;
    reasoning?: string;
  } | null {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch {
      // parse failure
    }
    return null;
  }

  private buildPlanningPrompt(
    task: string,
    observation: { screenWidth?: number; screenHeight?: number; activeWindow?: string; windowTitles?: string[] },
    toolsDesc: string
  ): string {
    return `你是一个桌面操作助手。你的任务是根据当前屏幕状态，决定下一步操作。

任务目标: ${task}

可用工具:
${toolsDesc}

坐标说明:
- 使用归一化坐标 [0-1000] × [0-1000]
- 屏幕左上角为 (0, 0)，右下角为 (1000, 1000)

当前屏幕信息:
- 分辨率: ${observation.screenWidth} × ${observation.screenHeight}
- 活动窗口: ${observation.activeWindow || '未知'}
- 窗口列表: ${observation.windowTitles?.join(', ') || '无'}

请分析当前屏幕状态，然后决定下一步操作。
只返回一个JSON对象，格式如下：
{
  "type": "工具名称",
  "params": { ...参数 },
  "description": "动作描述",
  "reasoning": "为什么选择这个动作"
}

如果认为任务已经完成，返回：
{"type": "done", "description": "任务完成描述"}`;
  }

  private getSystemPrompt(): string {
    return `你是一个专业的桌面操作助手，擅长通过鼠标和键盘操作电脑。

操作原则：
1. 每一步操作前都要仔细观察屏幕状态
2. 优先使用精确的UI元素操作，而不是盲目点击
3. 操作后验证结果是否符合预期
4. 遇到问题及时调整策略

坐标系统：
- 所有坐标使用归一化值，范围 [0, 1000]

请始终以安全、准确、高效的方式完成任务。`;
  }

  private estimateProgress(context: DecisionContext): number {
    try {
      const goalAuthority = require('./GoalAuthority').GoalAuthority.getInstance();
      const goal = goalAuthority.getGoal(context.goalId);
      const currentProgress = goal ? goal.progress : 0;
      return Math.min(1, currentProgress + 0.3);
    } catch {
      return 0.3;
    }
  }
}
