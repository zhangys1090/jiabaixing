"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const types_1 = require("../types");
describe('Evolution Types', () => {
    test('EvolutionType values', () => {
        expect(Object.values(types_1.EvolutionType)).toEqual([
            'CODE_FIX',
            'CODE_OPTIMIZATION',
            'PROMPT_IMPROVEMENT',
            'TOOL_ENHANCEMENT',
            'ARCHITECTURE_CHANGE',
        ]);
    });
    test('EvolutionPlan structure', () => {
        const plan = {
            id: 'test-1',
            type: types_1.EvolutionType.CODE_FIX,
            priority: types_1.EvolutionPriority.CRITICAL,
            cause: {
                type: 'FAILURE',
                description: 'Test failure',
                context: {},
                timestamp: Date.now(),
            },
            title: 'Test fix',
            description: 'Fix a test',
            actions: [],
            estimatedRisk: 'LOW',
            validationSteps: [],
            createdAt: Date.now(),
        };
        expect(plan.id).toBe('test-1');
        expect(plan.priority).toBe(types_1.EvolutionPriority.CRITICAL);
    });
});
