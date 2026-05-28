export interface IEvolutionEngine {
  start(): void;
  collectFeedback(
    input: string,
    response: string,
    result: {
      success: boolean;
      intent?: string;
      toolsUsed?: string[];
      error?: string;
    },
    scene?: string
  ): void;
  assessQuality(
    traceId: string,
    success: boolean,
    qualityScore: number,
    duration: number
  ): void;
  getStrategyOptimizer(): {
    getPromptExamples(): Array<{
      trigger: string;
      correction: string;
      example: string;
      frequency: number;
    }>;
  };
}

export interface ITRAEOptimizationIntegrator {
  initialize(): Promise<void>;
}
