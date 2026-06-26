import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SelfModificationEngine } from '../SelfModificationEngine';
import { EvolutionPlan, EvolutionType, EvolutionPriority } from '../types';

describe('SelfModificationEngine', () => {
  let tempDir: string;
  let engine: SelfModificationEngine;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `evolution-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    engine = new SelfModificationEngine();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test('create file', async () => {
    const testFile = path.join(tempDir, 'new-file.txt');

    const plan: EvolutionPlan = {
      id: 'test-create',
      type: EvolutionType.CODE_OPTIMIZATION,
      priority: EvolutionPriority.MEDIUM,
      cause: {
        type: 'PROACTIVE_IMPROVEMENT',
        description: 'Test',
        context: {},
        timestamp: Date.now(),
      },
      title: 'Create test file',
      description: 'Test file creation',
      actions: [
        {
          type: 'CREATE_FILE',
          target: testFile,
          content: 'Hello, world!',
          description: 'Create test file',
        },
      ],
      estimatedRisk: 'LOW',
      validationSteps: [],
      createdAt: Date.now(),
    };

    const result = await engine.executePlan(plan, 'checkpoint-1');
    expect(result.success).toBe(true);
    expect(result.executedActions).toBe(1);
    expect(fs.readFileSync(testFile, 'utf-8')).toBe('Hello, world!');
  });

  test('modify file', async () => {
    const testFile = path.join(tempDir, 'modify-test.txt');
    fs.writeFileSync(testFile, 'Original', 'utf-8');

    const plan: EvolutionPlan = {
      id: 'test-modify',
      type: EvolutionType.CODE_FIX,
      priority: EvolutionPriority.HIGH,
      cause: {
        type: 'BUG_REPORT',
        description: 'Test',
        context: {},
        timestamp: Date.now(),
      },
      title: 'Modify test',
      description: 'Test file modification',
      actions: [
        {
          type: 'MODIFY_FILE',
          target: { filePath: testFile },
          originalContent: 'Original',
          content: 'Modified',
          description: 'Modify test file',
        },
      ],
      estimatedRisk: 'LOW',
      validationSteps: [],
      createdAt: Date.now(),
    };

    const result = await engine.executePlan(plan, 'checkpoint-2');
    expect(result.success).toBe(true);
    expect(fs.readFileSync(testFile, 'utf-8')).toBe('Modified');
  });
});
