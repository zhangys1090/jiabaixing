import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EvolutionRollback } from '../EvolutionRollback';
import { EvolutionAction } from '../types';

describe('EvolutionRollback', () => {
  let tempDir: string;
  let rollback: EvolutionRollback;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `evolution-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    rollback = new EvolutionRollback(path.join(tempDir, 'checkpoints'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test('create checkpoint and rollback', async () => {
    const testFile = path.join(tempDir, 'test.txt');
    fs.writeFileSync(testFile, 'Original content', 'utf-8');

    const actions: EvolutionAction[] = [
      {
        type: 'MODIFY_FILE',
        target: { filePath: testFile },
        content: 'Modified content',
        originalContent: 'Original content',
        description: 'Test modify',
      },
    ];

    const checkpoint = rollback.createCheckpoint('test-plan', actions);
    expect(checkpoint.id).toBeTruthy();
    expect(checkpoint.snapshot[testFile]).toBe('Original content');

    fs.writeFileSync(testFile, 'Modified content', 'utf-8');

    const rollbackResult = await rollback.rollback(checkpoint.id);
    expect(rollbackResult.success).toBe(true);
    expect(fs.readFileSync(testFile, 'utf-8')).toBe('Original content');
  });
});
