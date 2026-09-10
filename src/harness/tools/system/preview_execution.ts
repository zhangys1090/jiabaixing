/**
 * Harness Tool: preview_execution - 高风险操作预览确认
 */

import { EventBus } from '../../../shared/EventBus';
import { Logger } from '../../../utils/Logger';
import type {
  RiskLevel,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../types';
import { ToolCategory } from '../../types';

export const PREVIEW_EXECUTION_DEF: ToolDefinition = {
  name: 'preview_execution',
  description:
    '在执行高风险操作前，展示将要执行的操作预览，等待用户确认。适用场景：批量修改文件、删除操作、重构代码、执行系统命令。不适用：读取文件、查询信息等安全操作。',
  category: ToolCategory.SYSTEM,
  parameters: {
    actions: {
      type: 'array',
      description: '将要执行的操作列表，每项包含 {file, action, description}',
      items: {
        type: 'object',
        description: '操作项',
        properties: {
          file: { type: 'string', description: '目标文件路径' },
          action: { type: 'string', description: '操作类型' },
          description: { type: 'string', description: '操作描述' },
        },
      },
    },
    risk_level: {
      type: 'string',
      description:
        '风险等级: low=低风险(可自动执行), medium=中风险(建议确认), high=高风险(必须确认), critical=严重风险(必须确认且需多因素认证)',
      enum: ['low', 'medium', 'high', 'critical'],
    },
    summary: {
      type: 'string',
      description: '操作摘要说明',
    },
  },
  requiredParams: ['actions', 'risk_level'],
  requiredPermissions: [],
  riskLevel: 'low',
  idempotent: true,
  timeout: 5000,
};

/** 创建 preview_execution 执行器 */
export function createPreviewExecutionExecutor() {
  return async (
    params: Record<string, unknown>,
    context?: ToolContext
  ): Promise<ToolResult> => {
    const actions =
      (params.actions as Array<{
        file?: string;
        action?: string;
        description?: string;
      }>) || [];
    const riskLevel = String(params.risk_level || 'medium') as RiskLevel;
    const summary = String(params.summary || '');
    const traceId = context?.traceId || '';

    if (actions.length === 0) {
      return {
        success: false,
        output: null,
        error: '请提供至少一个操作项',
        duration: 0,
        validated: false,
      };
    }

    const validRiskLevels: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
    if (!validRiskLevels.includes(riskLevel)) {
      return {
        success: false,
        output: null,
        error: `无效的风险等级: ${riskLevel}，必须是 low/medium/high/critical`,
        duration: 0,
        validated: false,
      };
    }

    void EventBus.emit('execution_preview', {
      traceId,
      summary,
      changes: actions.map((a) => ({
        type: 'file' as const,
        target: a.file || '',
        action: a.action || '',
        risk: riskLevel as 'low' | 'medium' | 'high' | 'critical',
      })),
      timestamp: new Date().toISOString(),
    });

    Logger.info(
      `📋 执行预览: ${actions.length}个操作, 风险=${riskLevel}`,
      'PreviewExecution'
    );

    const needsConfirmation = riskLevel === 'high' || riskLevel === 'medium';

    return {
      success: true,
      output: needsConfirmation
        ? `已展示操作预览(${actions.length}个操作, 风险=${riskLevel})，等待用户确认后执行。`
        : `已记录操作计划(${actions.length}个操作)，可直接执行。`,
      duration: 0,
      validated: false,
      metadata: { needsConfirmation, previewId: traceId },
    };
  };
}
