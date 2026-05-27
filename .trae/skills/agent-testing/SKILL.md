---
name: ''
description: 'Test AI agent capabilities, verify autonomous behaviors, and validate intelligent decision-making. Invoke when testing agent features, autonomous actions, or intelligent workflows.'
---

# Agent Testing

This skill helps test AI agent capabilities and autonomous behaviors.

## When to Use

- Testing agent autonomous decision-making
- Verifying intelligent task execution
- Validating agent learning capabilities
- Testing agent memory and context
- Checking agent performance metrics
- Testing agent collaboration features

## Testing Process

### 1. Agent Capability Testing

```typescript
describe('Agent Capabilities', () => {
  it('should make autonomous decisions', async () => {
    const agent = new JiabaixingAgent();
    const task = {
      type: 'code_generation',
      description: 'Create a REST API endpoint',
      parameters: {},
    };

    const result = await agent.executeTask(task);

    expect(result.success).toBe(true);
    expect(result.decision).toBeDefined();
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('should learn from experience', async () => {
    const agent = new JiabaixingAgent();

    // Execute similar tasks multiple times
    for (let i = 0; i < 5; i++) {
      await agent.executeTask({
        type: 'file_operation',
        description: 'Create a new file',
        parameters: {},
      });
    }

    // Check if performance improved
    const performance = agent.getPerformanceMetrics();
    expect(performance.improvementRate).toBeGreaterThan(0);
  });
});
```

### 2. Memory and Context Testing

```typescript
describe('Agent Memory', () => {
  it('should remember previous interactions', async () => {
    const agent = new JiabaixingAgent();

    // First interaction
    await agent.processMessage('My name is John');

    // Second interaction
    const response = await agent.processMessage('What is my name?');

    expect(response.content).toContain('John');
  });

  it('should maintain context across sessions', async () => {
    const agent = new JiabaixingAgent();

    // Session 1
    await agent.processMessage('I am working on project X');

    // Save and restore session
    const sessionData = agent.exportSession();
    const newAgent = new JiabaixingAgent();
    await newAgent.importSession(sessionData);

    // Session 2
    const response = await newAgent.processMessage(
      'What project am I working on?'
    );

    expect(response.content).toContain('project X');
  });
});
```

### 3. Intelligent Decision Testing

```typescript
describe('Intelligent Decision Making', () => {
  it('should assess task complexity correctly', async () => {
    const agent = new JiabaixingAgent();

    const simpleTask = await agent.assessComplexity('Create a file');
    const complexTask = await agent.assessComplexity('Refactor entire system');

    expect(simpleTask.level).toBe('simple');
    expect(complexTask.level).toBe('complex');
  });

  it('should optimize multi-objective decisions', async () => {
    const agent = new JiabaixingAgent();

    const decision = await agent.optimizeDecision({
      objectives: [
        { id: 'speed', weight: 0.5, minimize: true },
        { id: 'quality', weight: 0.5, minimize: false },
      ],
      constraints: [],
      availableResources: [],
    });

    expect(decision).toBeDefined();
    expect(decision.confidence).toBeGreaterThan(0);
  });
});
```

### 4. Performance Testing

```typescript
describe('Agent Performance', () => {
  it('should respond within acceptable time', async () => {
    const agent = new JiabaixingAgent();
    const start = Date.now();

    await agent.processMessage('Hello');

    const duration = Date.now() - start;
    expect(duration).toBeLessThan(5000); // 5 seconds
  });

  it('should handle concurrent requests', async () => {
    const agent = new JiabaixingAgent();
    const requests = Array(10)
      .fill(null)
      .map(() => agent.processMessage('Test message'));

    const results = await Promise.all(requests);

    expect(results).toHaveLength(10);
    results.forEach((result) => {
      expect(result.success).toBe(true);
    });
  });
});
```

### 5. Integration Testing

```typescript
describe('Agent Integration', () => {
  it('should integrate with memory system', async () => {
    const agent = new JiabaixingAgent();
    const memoryEngine = agent.getMemoryEngine();

    await agent.processMessage('Remember this important information');
    const memories = await memoryEngine.retrieve('important information');

    expect(memories.length).toBeGreaterThan(0);
  });

  it('should integrate with skill system', async () => {
    const agent = new JiabaixingAgent();
    const skillRegistry = agent.getSkillRegistry();

    const availableSkills = skillRegistry.listSkills();
    expect(availableSkills.length).toBeGreaterThan(0);

    const result = await agent.useSkill('CodeGenerator', {
      description: 'Create a simple function',
    });

    expect(result.success).toBe(true);
  });
});
```

### 6. Evolution Testing

```typescript
describe('Agent Evolution', () => {
  it('should improve over time', async () => {
    const agent = new JiabaixingAgent();

    const initialPerformance = agent.getPerformanceMetrics();

    // Execute various tasks
    for (let i = 0; i < 20; i++) {
      await agent.executeTask({
        type: 'various',
        description: `Task ${i}`,
        parameters: {},
      });
    }

    const finalPerformance = agent.getPerformanceMetrics();
    expect(finalPerformance.overallScore).toBeGreaterThan(
      initialPerformance.overallScore
    );
  });

  it('should adapt to user preferences', async () => {
    const agent = new JiabaixingAgent();

    // Provide feedback
    await agent.provideFeedback({
      taskId: 'task-1',
      rating: 5,
      comment: 'Excellent work',
    });

    // Check if preferences are learned
    const preferences = agent.getUserPreferences();
    expect(preferences.preferredStyle).toBeDefined();
  });
});
```

## Tools to Use

- **Read**: Read agent implementation
- **SearchCodebase**: Find agent-related code
- **Grep**: Search for agent methods
- **RunCommand**: Run agent tests
- **Write**: Create agent test files

## Best Practices

- Test autonomous decision-making
- Verify learning capabilities
- Check memory persistence
- Measure performance metrics
- Test integration with other systems
- Validate evolution mechanisms
- Test edge cases
- Monitor resource usage
