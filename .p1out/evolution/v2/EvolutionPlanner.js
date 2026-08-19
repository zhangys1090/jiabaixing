"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EvolutionPlanner = void 0;
const Logger_1 = require("../../utils/Logger");
const types_1 = require("./types");
class EvolutionPlanner {
    constructor(llmClient) {
        this.llmClient = llmClient;
    }
    /**
     * 分析进化原因并生成完整计划
     */
    async generateEvolutionPlan(cause) {
        Logger_1.Logger.info(`📝 Generating evolution plan for: ${cause.type}`, 'EvolutionPlanner');
        const planId = `plan-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
        const systemPrompt = this.getSystemPrompt();
        const userPrompt = this.getUserPrompt(cause);
        try {
            const llmResponse = await this.llmClient.chat(systemPrompt, userPrompt);
            const plan = this.parseLLMResponse(planId, cause, llmResponse);
            Logger_1.Logger.info(`✅ Evolution plan generated: ${plan.title} (${plan.actions.length} actions)`, 'EvolutionPlanner');
            return plan;
        }
        catch (error) {
            Logger_1.Logger.error('❌ Failed to generate evolution plan', error, 'EvolutionPlanner');
            return {
                id: planId,
                type: types_1.EvolutionType.CODE_FIX,
                priority: types_1.EvolutionPriority.MEDIUM,
                cause,
                title: 'Default repair plan',
                description: 'Simple plan due to LLM failure',
                actions: [],
                estimatedRisk: 'LOW',
                validationSteps: ['Check if error resolved'],
                createdAt: Date.now(),
            };
        }
    }
    /**
     * System prompt
     */
    getSystemPrompt() {
        return `You are an advanced evolutionary programming assistant. Your job is to generate REAL CODE MODIFICATION plans to fix problems, optimize code, or improve the system.

RULES:
1. Analyze the problem thoroughly
2. Generate concrete, actionable evolution actions
3. Use the format below
4. Actions can be: MODIFY_FILE, CREATE_FILE, DELETE_FILE, UPDATE_PROMPT, UPDATE_CONFIG
5. Always provide ORIGINAL CONTENT (for rollback) and NEW CONTENT
6. Estimate risk (LOW/MEDIUM/HIGH)
7. Include validation steps

RESPONSE FORMAT (JSON ONLY):
{
  "type": "CODE_FIX|CODE_OPTIMIZATION|PROMPT_IMPROVEMENT|TOOL_ENHANCEMENT|ARCHITECTURE_CHANGE",
  "priority": "CRITICAL|HIGH|MEDIUM|LOW",
  "title": "Brief title",
  "description": "Detailed description",
  "actions": [
    {
      "type": "MODIFY_FILE|CREATE_FILE|DELETE_FILE|UPDATE_PROMPT|UPDATE_CONFIG",
      "target": {"filePath": "absolute/path/to/file.ts"},
      "content": "NEW FULL CONTENT of file",
      "originalContent": "ORIGINAL FULL CONTENT (for rollback)",
      "description": "What this action does"
    }
  ],
  "estimatedRisk": "LOW|MEDIUM|HIGH",
  "validationSteps": ["Step 1 to verify", "Step 2 to verify"]
}

IMPORTANT:
- Provide FULL file content, not just diffs
- Use absolute paths only
- Always include originalContent for rollback
- Be bold but safe - real changes!`;
    }
    /**
     * User prompt
     */
    getUserPrompt(cause) {
        let contextDetails = '';
        if (cause.context.failureInfo) {
            contextDetails += `\nFAILURE INFO:\n${cause.context.failureInfo}`;
        }
        if (cause.context.satisfactionScore !== undefined) {
            contextDetails += `\nSATISFACTION SCORE: ${cause.context.satisfactionScore}`;
        }
        if (cause.context.performanceMetric) {
            contextDetails += `\nPERFORMANCE ISSUE: ${cause.context.performanceMetric.name} = ${cause.context.performanceMetric.value}, threshold=${cause.context.performanceMetric.threshold}`;
        }
        return `EVOLUTION TRIGGER: ${cause.type}
DESCRIPTION: ${cause.description}
${contextDetails}

CURRENT DATE/TIME: ${new Date().toISOString()}

Analyze this issue and create a REAL evolution plan that MODIFIES CODE to fix/improve the system!`;
    }
    /**
     * 解析 LLM 响应
     */
    parseLLMResponse(planId, cause, llmResponse) {
        // 提取 JSON
        let jsonStr = llmResponse;
        const jsonStart = llmResponse.indexOf('{');
        const jsonEnd = llmResponse.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1) {
            jsonStr = llmResponse.substring(jsonStart, jsonEnd + 1);
        }
        try {
            const parsed = JSON.parse(jsonStr);
            return {
                id: planId,
                type: parsed.type || types_1.EvolutionType.CODE_FIX,
                priority: parsed.priority || types_1.EvolutionPriority.MEDIUM,
                cause,
                title: parsed.title || 'Evolution Plan',
                description: parsed.description || cause.description,
                actions: parsed.actions || [],
                estimatedRisk: parsed.estimatedRisk || 'MEDIUM',
                validationSteps: parsed.validationSteps || [],
                createdAt: Date.now(),
            };
        }
        catch {
            Logger_1.Logger.warn('Failed to parse LLM response as JSON, using fallback', 'EvolutionPlanner');
            return {
                id: planId,
                type: types_1.EvolutionType.CODE_FIX,
                priority: types_1.EvolutionPriority.MEDIUM,
                cause,
                title: 'Fallback Plan',
                description: 'Could not parse LLM response, using simple plan',
                actions: [],
                estimatedRisk: 'LOW',
                validationSteps: [],
                createdAt: Date.now(),
            };
        }
    }
}
exports.EvolutionPlanner = EvolutionPlanner;
exports.default = EvolutionPlanner;
