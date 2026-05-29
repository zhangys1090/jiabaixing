import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../utils/Logger';
import { EvolutionAction, EvolutionPlan, EvolutionResult } from './types';

export class SelfModificationEngine {
  constructor() {}

  /**
   * 执行进化计划
   */
  async executePlan(
    plan: EvolutionPlan,
    checkpointId: string
  ): Promise<EvolutionResult> {
    const startTime = Date.now();
    const result: EvolutionResult = {
      planId: plan.id,
      success: true,
      executedActions: 0,
      duration: 0
    };

    Logger.info(`🔧 Executing evolution plan: ${plan.id} (${plan.type})`, 'SelfModificationEngine');

    try {
      for (let i = 0; i < plan.actions.length; i++) {
        const action = plan.actions[i];
        
        Logger.info(`  Executing action ${i + 1}/${plan.actions.length}: ${action.description}`, 'SelfModificationEngine');
        
        const success = await this.executeAction(action);
        
        if (!success) {
          result.success = false;
          result.failedAt = i;
          result.error = `Action failed at ${i}: ${action.description}`;
          Logger.error(`❌ Action failed: ${action.description}`, new Error('Action failed'), 'SelfModificationEngine');
          break;
        }
        
        result.executedActions++;
      }
      
      result.duration = Date.now() - startTime;
      
      if (result.success) {
        Logger.info(`✅ Evolution plan executed successfully: ${plan.id}`, 'SelfModificationEngine');
      } else {
        Logger.info(`❌ Evolution plan failed: ${plan.id}`, 'SelfModificationEngine');
      }
      
    } catch (error) {
      result.success = false;
      result.error = (error as Error).message;
      result.duration = Date.now() - startTime;
      Logger.error('❌ Evolution plan execution error', error as Error, 'SelfModificationEngine');
    }

    return result;
  }

  /**
   * 执行单个动作
   */
  private async executeAction(action: EvolutionAction): Promise<boolean> {
    try {
      switch (action.type) {
        case 'MODIFY_FILE':
          return this.modifyFile(action);
        case 'CREATE_FILE':
          return this.createFile(action);
        case 'DELETE_FILE':
          return this.deleteFile(action);
        case 'UPDATE_PROMPT':
          return this.updatePrompt(action);
        case 'UPDATE_CONFIG':
          return this.updateConfig(action);
        default:
          Logger.warn(`Unknown action type: ${action.type}`, 'SelfModificationEngine');
          return false;
      }
    } catch (error) {
      Logger.error(`Action execution failed`, error as Error, 'SelfModificationEngine');
      return false;
    }
  }

  /**
   * 修改文件
   */
  private modifyFile(action: EvolutionAction): boolean {
    const target = action.target as any;
    const filePath = target.filePath || target;
    
    if (!fs.existsSync(filePath)) {
      Logger.error(`File not found for modification: ${filePath}`, new Error('File not found'), 'SelfModificationEngine');
      return false;
    }

    // 保存原内容（如果没提供）
    if (!action.originalContent) {
      action.originalContent = fs.readFileSync(filePath, 'utf-8');
    }

    fs.writeFileSync(filePath, action.content, 'utf-8');
    Logger.debug(`File modified: ${filePath}`, 'SelfModificationEngine');
    return true;
  }

  /**
   * 创建文件
   */
  private createFile(action: EvolutionAction): boolean {
    const filePath = typeof action.target === 'string' ? action.target : (action.target as any).filePath;
    
    // 确保目录存在
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, action.content, 'utf-8');
    Logger.debug(`File created: ${filePath}`, 'SelfModificationEngine');
    return true;
  }

  /**
   * 删除文件
   */
  private deleteFile(action: EvolutionAction): boolean {
    const filePath = typeof action.target === 'string' ? action.target : (action.target as any).filePath;
    
    if (fs.existsSync(filePath)) {
      // 保存原内容（如果没提供）
      if (!action.originalContent) {
        action.originalContent = fs.readFileSync(filePath, 'utf-8');
      }
      
      fs.unlinkSync(filePath);
      Logger.debug(`File deleted: ${filePath}`, 'SelfModificationEngine');
    }
    return true;
  }

  /**
   * 更新 prompt
   */
  private updatePrompt(action: EvolutionAction): boolean {
    const promptPath = typeof action.target === 'string' ? action.target : (action.target as any).filePath;
    
    if (!promptPath) {
      Logger.error('No prompt path specified', new Error('No prompt path'), 'SelfModificationEngine');
      return false;
    }

    const dir = path.dirname(promptPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(promptPath, action.content, 'utf-8');
    Logger.debug(`Prompt updated: ${promptPath}`, 'SelfModificationEngine');
    return true;
  }

  /**
   * 更新配置
   */
  private updateConfig(action: EvolutionAction): boolean {
    return this.modifyFile(action);
  }
}

export default SelfModificationEngine;
