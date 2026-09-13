"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const EvolutionPlanner_1 = require("../EvolutionPlanner");
const types_1 = require("../types");
describe('EvolutionPlanner', () => {
    test('generate evolution plan with mock LLM', async () => {
        const mockLLM = {
            chat: async () => JSON.stringify({
                type: types_1.EvolutionType.CODE_FIX,
                priority: types_1.EvolutionPriority.HIGH,
                title: 'Fix a test bug',
                description: 'Repair failing test',
                actions: [],
                estimatedRisk: 'LOW',
                validationSteps: ['Run tests'],
            }),
        };
        const planner = new EvolutionPlanner_1.EvolutionPlanner(mockLLM);
        const cause = {
            type: 'FAILURE',
            description: 'Test failure detected',
            context: {
                failureInfo: 'Error in test suite',
            },
            timestamp: Date.now(),
        };
        const plan = await planner.generateEvolutionPlan(cause);
        expect(plan.id).toBeTruthy();
        expect(plan.type).toBe(types_1.EvolutionType.CODE_FIX);
        expect(plan.priority).toBe(types_1.EvolutionPriority.HIGH);
        expect(plan.cause).toEqual(cause);
    });
});
