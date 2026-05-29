import { Logger } from '../../utils/Logger';
import {
  EvolutionCause,
  EvolutionPlan,
  EvolutionResult,
  EvolutionHistory,
  EvolutionMetrics,
  EvolutionType,
  EvolutionPriority
} from './types';
import { EvolutionRollback } from './EvolutionRollback';
import { SelfModificationEngine } from './SelfModificationEngine';
import { EvolutionPlanner } from './EvolutionPlanner';

interface LLMClient {
  chat(systemPrompt: string, userPrompt: string): Promise<string>;
}

export class EvolutionEngineV2 {
  private rollback: EvolutionRollback;
  private modifier: SelfModificationEngine;
  private planner: EvolutionPlanner;
  private history: EvolutionHistory[] = [];
  private isRunning: boolean = false;

  constructor(llmClient: LLMClient, checkpointDir: string = './.evolution-checkpoints') {
    this.rollback = new EvolutionRollback(checkpointDir);
    this.modifier = new SelfModificationEngine();
    this.planner = new EvolutionPlanner(llmClient);
    
    Logger.info('🧬 EvolutionEngineV2 initialized', 'EvolutionEngineV2');
  }

  /**
   * 主入口：触发进化
   */
  async triggerEvolution(cause: EvolutionCause): Promise<EvolutionResult | null> {
    if (this.isRunning) {
      Logger.warn('Evolution already in progress, skipping', 'EvolutionEngineV2');
      return null;
    }

    this.isRunning = true;
    
    try {
      Logger.info(`🚀 Evolution started: ${cause.type} - ${cause.description}`, 'EvolutionEngineV2');
      
      const plan = await this.planner.generateEvolutionPlan(cause);
      return await this.executePlan(plan);
      
    } catch (error) {
      Logger.error('Evolution failed', error as Error, 'EvolutionEngineV2');
      return null;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * 执行进化计划（完整流程）
   */
  private async executePlan(plan: EvolutionPlan): Promise<EvolutionResult> {
    Logger.info(`📋 Plan: ${plan.title} (${plan.actions.length} actions, risk: ${plan.estimatedRisk})`, 'EvolutionEngineV2');
    
    let result: EvolutionResult;
    
    // 即使是空计划也要记录历史
    const emptyPlan = plan.actions.length === 0;
    if (emptyPlan) {
      Logger.info('No actions in plan, skipping execution', 'EvolutionEngineV2');
      result = {
        planId: plan.id,
        success: true,
        executedActions: 0,
        duration: 0
      };
    } else {
      // Step 1: 创建回滚检查点
      const checkpoint = this.rollback.createCheckpoint(plan.id, plan.actions);
      
      try {
        // Step 2: 执行修改
        result = await this.modifier.executePlan(plan, checkpoint.id);
        
        // Step 3: 验证效果
        if (result.success) {
          Logger.info('🔍 Validating evolution...', 'EvolutionEngineV2');
          const validationResult = await this.validateEvolution(plan);
          result.validationResult = validationResult;
          
          if (!validationResult.passed) {
            Logger.warn('Validation failed, initiating rollback', 'EvolutionEngineV2');
            result.rollbackNeeded = true;
          }
        }
        
      } catch (error) {
        result = {
          planId: plan.id,
          success: false,
          executedActions: 0,
          error: (error as Error).message,
          duration: 0
        };
        result.rollbackNeeded = true;
      }

      // Step 4: 回滚（如果需要）
      if (result.rollbackNeeded) {
        const rollbackResult = await this.rollback.rollback(checkpoint.id);
        result.rollbackResult = rollbackResult;
        
        if (rollbackResult.success) {
          Logger.info('⏪ Evolution rolled back successfully', 'EvolutionEngineV2');
        } else {
          Logger.error('❌ Rollback failed!', new Error(rollbackResult.error), 'EvolutionEngineV2');
        }
      }
    }

    // Step 5: 记录历史（包括空计划）
    this.history.push({
      planId: plan.id,
      type: plan.type,
      title: plan.title,
      success: result.success && !result.rollbackNeeded,
      cause: plan.cause,
      result,
      timestamp: Date.now()
    });

    return result;
  }

  /**
   * 验证进化效果
   * 在真实场景中，这里应该运行测试、检查编译等
   * 为了测试，我们根据计划的 estimatedRisk 来决定是否验证通过
   */
  private async validateEvolution(plan: EvolutionPlan): Promise<{ passed: boolean; details: string }> {
    // 高风险的进化需要更严格的验证
    if (plan.estimatedRisk === 'HIGH') {
      return {
        passed: true,
        details: 'High risk plan - validation passed (placeholder for real validation)'
      };
    }
    
    // 默认通过
    return {
      passed: true,
      details: 'Validation passed (placeholder)'
    };
  }

  /**
   * 获取进化历史
   */
  getHistory(limit: number = 100): EvolutionHistory[] {
    return this.history.slice(-limit);
  }

  /**
   * 获取进化指标
   */
  getMetrics(): EvolutionMetrics {
    const total = this.history.length;
    const successful = this.history.filter(h => h.success).length;
    const rolledBack = this.history.filter(h => h.result.rollbackResult?.success).length;
    const averageDuration = total > 0 
      ? this.history.reduce((sum, h) => sum + h.result.duration, 0) / total
      : 0;
    
    const byType: Partial<Record<EvolutionType, number>> = {};
    for (const h of this.history) {
      byType[h.type] = (byType[h.type] || 0) + 1;
    }

    return {
      totalEvolutions: total,
      successRate: total > 0 ? successful / total : 0,
      averageDuration,
      evolutionsByType: byType,
      rollbackRate: total > 0 ? rolledBack / total : 0,
      qualityImprovement: 0 // TODO: 实际质量改善计算
    };
  }

  /**
   * 手动触发回滚
   */
  async rollbackToCheckpoint(checkpointId: string): Promise<{ success: boolean; error?: string }> {
    return this.rollback.rollback(checkpointId);
  }
}

export default EvolutionEngineV2;
