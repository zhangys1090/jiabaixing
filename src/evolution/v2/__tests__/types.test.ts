import { EvolutionType, EvolutionPriority, EvolutionCause, EvolutionPlan, EvolutionAction } from '../types';

describe('Evolution Types', () => {
  test('EvolutionType values', () => {
    expect(Object.values(EvolutionType)).toEqual([
      'CODE_FIX', 'CODE_OPTIMIZATION', 'PROMPT_IMPROVEMENT',
      'TOOL_ENHANCEMENT', 'ARCHITECTURE_CHANGE'
    ]);
  });

  test('EvolutionPlan structure', () => {
    const plan: EvolutionPlan = {
      id: 'test-1',
      type: EvolutionType.CODE_FIX,
      priority: EvolutionPriority.CRITICAL,
      cause: {
        type: 'FAILURE',
        description: 'Test failure',
        context: {},
        timestamp: Date.now()
      },
      title: 'Test fix',
      description: 'Fix a test',
      actions: [],
      estimatedRisk: 'LOW',
      validationSteps: [],
      createdAt: Date.now()
    };
    expect(plan.id).toBe('test-1');
    expect(plan.priority).toBe(EvolutionPriority.CRITICAL);
  });
});
