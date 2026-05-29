/**
 * V1 StrategyOptimizer — REMOVED. Stubs for type compatibility only.
 */

export interface ToneAdjustment {
  targetScene: string;
  temperatureDelta: number;
  formalityDelta: number;
  verbosityDelta: number;
  emojiFrequencyDelta?: number;
  proactiveDelta?: number;
}

export interface SkillWeightAdjustment {
  skillName: string;
  weightDelta: number;
  reason: string;
}

export interface PromptExample {
  trigger: string;
  correction: string;
  example: string;
  frequency: number;
}

export interface OptimizationLog {
  id: string;
  timestamp: Date;
  reason: string;
  toneAdjustments: ToneAdjustment[];
  skillAdjustments: SkillWeightAdjustment[];
  promptExamples: PromptExample[];
  success: boolean;
  description: string;
}
