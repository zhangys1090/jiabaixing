import { EvolutionPlanner } from '../EvolutionPlanner';
import { EvolutionCause, EvolutionType, EvolutionPriority } from '../types';

describe('EvolutionPlanner', () => {
  test('generate evolution plan with mock LLM', async () => {
    const mockLLM = {
      chat: async () =>
        JSON.stringify({
          type: EvolutionType.CODE_FIX,
          priority: EvolutionPriority.HIGH,
          title: 'Fix a test bug',
          description: 'Repair failing test',
          actions: [],
          estimatedRisk: 'LOW',
          validationSteps: ['Run tests'],
        }),
    };

    const planner = new EvolutionPlanner(mockLLM);

    const cause: EvolutionCause = {
      type: 'FAILURE',
      description: 'Test failure detected',
      context: {
        failureInfo: 'Error in test suite',
      },
      timestamp: Date.now(),
    };

    const plan = await planner.generateEvolutionPlan(cause);

    expect(plan.id).toBeTruthy();
    expect(plan.type).toBe(EvolutionType.CODE_FIX);
    expect(plan.priority).toBe(EvolutionPriority.HIGH);
    expect(plan.cause).toEqual(cause);
  });
});
