/**
 * 人格规则引擎 — 人格定义与场景语气
 * v3.3: 安全过滤已移除，LLM 自行判断安全边界
 * 职责：人格定义、场景语气参数、system prompt 构建
 */

import { PersonaCore, ToneParams } from './PersonaCore';

export interface Rule {
  id: string;
  type: 'mandatory' | 'style' | 'emotion';
  content: string;
  priority: number;
  createdAt: Date;
  updatedAt: Date;
  enabled: boolean;
}

export interface ToneAdjustmentResult {
  adjustedContent: string;
  toneParams: ToneParams;
  appliedAdjustments: string[];
}

export type PersonaScene =
  | 'development'
  | 'daily'
  | 'comfort'
  | 'work'
  | 'greeting'
  | 'briefing'
  | 'idle'
  | 'leisure'
  | 'meeting'
  | 'driving';

export class PersonaRules {
  private personaCore: PersonaCore;
  private dynamicRules: Rule[] = [];
  private ruleVersion = 1;

  constructor(personaCore?: PersonaCore) {
    this.personaCore = personaCore || new PersonaCore();
  }

  /**
   * @deprecated v3.3: 语气调整已移除，直接返回原始内容。
   * 保留此方法以保持向后兼容，新代码应直接使用 PersonaCore.getToneForScene()
   */
  public adjustTone(
    content: string,
    _scene: string = 'daily'
  ): ToneAdjustmentResult {
    return {
      adjustedContent: content,
      toneParams: this.personaCore.getToneForScene(_scene),
      appliedAdjustments: [],
    };
  }

  /**
   * 生成 LLM system prompt（供 DialogueGenerator 使用）
   * v3.3: 人格定义在 system prompt 中，LLM 自行判断安全边界
   * v5.1: 注入启用的动态规则
   */
  public buildSystemPrompt(scene: string = 'daily'): string {
    const personaSummary = this.personaCore.buildPersonaSummary();
    const sceneInstruction = this.personaCore.buildSceneToneInstruction(scene);

    // 注入启用的动态规则（按优先级排序）
    const enabledRules = this.dynamicRules
      .filter((r) => r.enabled)
      .sort((a, b) => b.priority - a.priority);

    let rulesSection = '';
    if (enabledRules.length > 0) {
      const ruleLines = enabledRules.map((r) => {
        const prefix = r.type === 'mandatory' ? '【必须】' : r.type === 'emotion' ? '【情感】' : '【风格】';
        return `${prefix} ${r.content}`;
      });
      rulesSection = `\n\n【行为规则】\n${ruleLines.join('\n')}`;
    }

    return `${personaSummary}

${sceneInstruction}${rulesSection}`;
  }

  /**
   * 判断当前场景是否适合主动发起交互
   */
  public canProactivelyInteract(scene: string): boolean {
    const tone = this.personaCore.getToneForScene(scene);
    return tone.proactive;
  }

  /**
   * 获取场景语气参数
   */
  public getToneParams(scene: string): ToneParams {
    return this.personaCore.getToneForScene(scene);
  }

  // ═══════════════════════════ 动态规则管理 ═══════════════════════════

  public addRule(rule: Omit<Rule, 'id' | 'createdAt' | 'updatedAt'>): Rule {
    const newRule: Rule = {
      ...rule,
      id: `rule_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.dynamicRules.push(newRule);
    this.ruleVersion++;
    return newRule;
  }

  public updateRule(
    id: string,
    updates: Partial<Omit<Rule, 'id' | 'createdAt' | 'updatedAt'>>
  ): Rule | null {
    const idx = this.dynamicRules.findIndex((r) => r.id === id);
    if (idx === -1) return null;
    this.dynamicRules[idx] = {
      ...this.dynamicRules[idx],
      ...updates,
      updatedAt: new Date(),
    };
    this.ruleVersion++;
    return this.dynamicRules[idx];
  }

  public deleteRule(id: string): boolean {
    const before = this.dynamicRules.length;
    this.dynamicRules = this.dynamicRules.filter((r) => r.id !== id);
    if (this.dynamicRules.length < before) {
      this.ruleVersion++;
      return true;
    }
    return false;
  }

  public getDynamicRules(): Rule[] {
    return [...this.dynamicRules].sort((a, b) => b.priority - a.priority);
  }

  public toggleRule(id: string, enabled: boolean): boolean {
    const rule = this.dynamicRules.find((r) => r.id === id);
    if (!rule) return false;
    rule.enabled = enabled;
    rule.updatedAt = new Date();
    this.ruleVersion++;
    return true;
  }

  public getRuleVersion(): number {
    return this.ruleVersion;
  }

  /** 获取人设信息（只读） */
  public getPersonaInfo() {
    return this.personaCore.getProfile();
  }

  /** 获取 PersonaCore 实例 */
  public getPersonaCore(): PersonaCore {
    return this.personaCore;
  }
}
