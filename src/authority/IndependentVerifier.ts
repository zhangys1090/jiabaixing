import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Goal, Decision, ActionExecutionResult } from './types';
import { Logger } from '../utils/Logger';

export interface IndependentVerification {
  verified: boolean;
  verificationMethod: string;
  verificationReason: string;
  observedState: Record<string, unknown>;
}

export interface IndependentVerifier {
  readonly verifierId: string;
  readonly domain: string;
  canVerify(goal: Goal, executionResult: ActionExecutionResult): boolean;
  verify(goal: Goal, decision: Decision | null, executionResult: ActionExecutionResult): Promise<IndependentVerification>;
}

function fsExists(filePath: string): boolean {
  try { return fs.existsSync(filePath); } catch { return false; }
}

function fsReadContent(filePath: string): string | null {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
}

function fsFileSize(filePath: string): number | null {
  try { return fs.statSync(filePath).size; } catch { return null; }
}

function fsHash(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch { return null; }
}

function fsDirMembers(dirPath: string): string[] | null {
  try { return fs.readdirSync(dirPath); } catch { return null; }
}

export class FilesystemVerifier implements IndependentVerifier {
  public readonly verifierId = 'filesystem_verifier';
  public readonly domain = 'filesystem';

  canVerify(goal: Goal, _executionResult: ActionExecutionResult): boolean {
    const tempDir = goal.metadata?.tempDir as string | undefined;
    if (!tempDir) return false;
    const taskId = goal.metadata?.taskId as string | undefined;
    if (!taskId) return false;
    return taskId.startsWith('T01') || taskId.startsWith('T02') || taskId.startsWith('T03') ||
           taskId.startsWith('T06') || taskId.startsWith('T09') || taskId.startsWith('T10');
  }

  async verify(goal: Goal, _decision: Decision | null, _executionResult: ActionExecutionResult): Promise<IndependentVerification> {
    const tempDir = goal.metadata?.tempDir as string;
    const taskId = goal.metadata?.taskId as string;

    try {
      switch (taskId) {
        case 'T01_file_create':
          return this.verifyT01(tempDir);
        case 'T02_file_modify':
          return this.verifyT02(tempDir);
        case 'T03_file_find_summarize':
          return this.verifyT03(tempDir);
        case 'T06_code_modify':
          return this.verifyT06(tempDir);
        case 'T09_env_change_replan':
          return this.verifyT09(tempDir);
        case 'T10_multi_step':
          return this.verifyT10(tempDir);
        default:
          return { verified: false, verificationMethod: 'filesystem_no_handler', verificationReason: `no handler for ${taskId}`, observedState: { verificationSource: 'independent_verifier' } };
      }
    } catch (err) {
      Logger.error(`[D8-1.1] FilesystemVerifier error for ${taskId}: ${(err as Error).message}`, err as Error, 'FilesystemVerifier');
      return { verified: false, verificationMethod: 'filesystem_error', verificationReason: (err as Error).message, observedState: { verificationSource: 'independent_verifier' } };
    }
  }

  private verifyT01(tempDir: string): IndependentVerification {
    const filePath = path.join(tempDir, 'hello.txt');
    if (!fsExists(filePath)) {
      return { verified: false, verificationMethod: 'fs_exists', verificationReason: `file not found: ${filePath}`, observedState: { exists: false, verificationSource: 'independent_verifier' } };
    }
    const content = fsReadContent(filePath);
    const fileSize = fsFileSize(filePath);
    const hash = fsHash(filePath);
    const match = content?.trim() === 'Hello D8';
    return {
      verified: match,
      verificationMethod: 'fs_read_content',
      verificationReason: match ? 'content matches "Hello D8"' : `content is "${content?.trim()}", expected "Hello D8"`,
      observedState: { exists: true, content: content?.trim(), contentMatch: match, fileSize, hash, verificationSource: 'independent_verifier' },
    };
  }

  private verifyT02(tempDir: string): IndependentVerification {
    const filePath = path.join(tempDir, 'hello.txt');
    if (!fsExists(filePath)) {
      return { verified: false, verificationMethod: 'fs_exists', verificationReason: `file not found: ${filePath}`, observedState: { exists: false, verificationSource: 'independent_verifier' } };
    }
    const content = fsReadContent(filePath);
    const fileSize = fsFileSize(filePath);
    const hash = fsHash(filePath);
    const hasOriginal = content?.includes('Original content') ?? false;
    const hasModified = content?.includes('modified') ?? false;
    const match = hasOriginal && hasModified;
    return {
      verified: match,
      verificationMethod: 'fs_read_content',
      verificationReason: match ? 'file contains original + modified' : `content: "${content}"`,
      observedState: { exists: true, content, hasOriginal, hasModified, fileSize, hash, verificationSource: 'independent_verifier' },
    };
  }

  private verifyT03(tempDir: string): IndependentVerification {
    const summaryPath = path.join(tempDir, 'summary.txt');
    const dirMembers = fsDirMembers(tempDir);
    if (!fsExists(summaryPath)) {
      return { verified: false, verificationMethod: 'fs_exists', verificationReason: 'summary.txt not found', observedState: { exists: false, dirMembers, verificationSource: 'independent_verifier' } };
    }
    const content = fsReadContent(summaryPath);
    const hasCount = content?.includes('3') ?? false;
    return {
      verified: hasCount,
      verificationMethod: 'fs_read_content',
      verificationReason: hasCount ? 'summary contains count 3' : `summary: "${content}"`,
      observedState: { exists: true, content, hasCount, dirMembers, verificationSource: 'independent_verifier' },
    };
  }

  private verifyT06(tempDir: string): IndependentVerification {
    const filePath = path.join(tempDir, 'calculator.js');
    if (!fsExists(filePath)) {
      return { verified: false, verificationMethod: 'fs_exists', verificationReason: 'calculator.js not found', observedState: { exists: false, verificationSource: 'independent_verifier' } };
    }
    const content = fsReadContent(filePath);
    const hasAdd = content?.includes('add') ?? false;
    const hasAddBody = content?.includes('a + b') ?? false;
    const match = hasAdd && hasAddBody;
    return {
      verified: match,
      verificationMethod: 'fs_read_content',
      verificationReason: match ? 'add function found' : `no add function: "${content?.slice(0, 200)}"`,
      observedState: { exists: true, hasAdd, hasAddBody, verificationSource: 'independent_verifier' },
    };
  }

  private verifyT09(tempDir: string): IndependentVerification {
    const dirPath = path.join(tempDir, 'result_dir');
    const filePath = path.join(tempDir, 'result_dir', 'result.txt');
    if (!fsExists(dirPath)) {
      return { verified: false, verificationMethod: 'fs_exists', verificationReason: 'result_dir not found', observedState: { dirExists: false, verificationSource: 'independent_verifier' } };
    }
    if (!fsExists(filePath)) {
      return { verified: false, verificationMethod: 'fs_exists', verificationReason: 'result_dir/result.txt not found', observedState: { dirExists: true, fileExists: false, verificationSource: 'independent_verifier' } };
    }
    const content = fsReadContent(filePath);
    const fileSize = fsFileSize(filePath);
    return {
      verified: true,
      verificationMethod: 'fs_exists_and_read',
      verificationReason: 'result_dir/result.txt exists with content',
      observedState: { dirExists: true, fileExists: true, content: content?.trim(), fileSize, verificationSource: 'independent_verifier' },
    };
  }

  private verifyT10(tempDir: string): IndependentVerification {
    const filePath = path.join(tempDir, 'data.json');
    if (!fsExists(filePath)) {
      return { verified: false, verificationMethod: 'fs_exists', verificationReason: 'data.json not found', observedState: { exists: false, verificationSource: 'independent_verifier' } };
    }
    const content = fsReadContent(filePath);
    const hash = fsHash(filePath);
    try {
      const parsed = JSON.parse(content!);
      const hasField = 'addedField' in parsed;
      return {
        verified: hasField,
        verificationMethod: 'fs_read_json',
        verificationReason: hasField ? 'data.json has addedField' : `missing addedField: ${JSON.stringify(parsed)}`,
        observedState: { exists: true, hasAddedField: hasField, keys: Object.keys(parsed), hash, verificationSource: 'independent_verifier' },
      };
    } catch {
      return { verified: false, verificationMethod: 'fs_read_json', verificationReason: 'data.json is not valid JSON', observedState: { exists: true, parseError: true, hash, verificationSource: 'independent_verifier' } };
    }
  }
}

export class TestVerifier implements IndependentVerifier {
  public readonly verifierId = 'test_verifier';
  public readonly domain = 'test';

  canVerify(goal: Goal, _executionResult: ActionExecutionResult): boolean {
    const taskId = goal.metadata?.taskId as string | undefined;
    return taskId === 'T07_run_test' || taskId === 'T08_test_fail_fix';
  }

  async verify(goal: Goal, _decision: Decision | null, _executionResult: ActionExecutionResult): Promise<IndependentVerification> {
    const tempDir = goal.metadata?.tempDir as string;
    const taskId = goal.metadata?.taskId as string;

    try {
      if (taskId === 'T07_run_test') {
        return this.verifyT07(tempDir);
      }
      if (taskId === 'T08_test_fail_fix') {
        return this.verifyT08(tempDir);
      }
      return { verified: false, verificationMethod: 'test_no_handler', verificationReason: `no handler for ${taskId}`, observedState: { verificationSource: 'independent_verifier' } };
    } catch (err) {
      Logger.error(`[D8-1.1] TestVerifier error for ${taskId}: ${(err as Error).message}`, err as Error, 'TestVerifier');
      return { verified: false, verificationMethod: 'test_error', verificationReason: (err as Error).message, observedState: { verificationSource: 'independent_verifier' } };
    }
  }

  private verifyT07(tempDir: string): IndependentVerification {
    try {
      const { execSync } = require('child_process');
      const output = execSync('node test.js', { cwd: tempDir, encoding: 'utf-8', timeout: 10000 });
      const passed = output.includes('All tests passed');
      return {
        verified: passed,
        verificationMethod: 'independent_test_run',
        verificationReason: passed ? 'tests pass independently' : `test output: ${output.trim()}`,
        observedState: { exitCode: 0, passed, output: output.trim(), testCount: 2, failed: passed ? 0 : 1, verificationSource: 'independent_verifier' },
      };
    } catch (err: any) {
      return {
        verified: false,
        verificationMethod: 'independent_test_run',
        verificationReason: `test failed: ${err.message}`,
        observedState: { exitCode: err.status ?? 1, passed: false, failed: 1, verificationSource: 'independent_verifier' },
      };
    }
  }

  private verifyT08(tempDir: string): IndependentVerification {
    try {
      const { execSync } = require('child_process');
      const output = execSync('node math_test.js', { cwd: tempDir, encoding: 'utf-8', timeout: 10000 });
      const passed = output.includes('Test passed');
      return {
        verified: passed,
        verificationMethod: 'independent_test_run',
        verificationReason: passed ? 'math_test passes after fix' : `test output: ${output.trim()}`,
        observedState: { exitCode: 0, passed, output: output.trim(), testCount: 1, failed: passed ? 0 : 1, verificationSource: 'independent_verifier' },
      };
    } catch (err: any) {
      return {
        verified: false,
        verificationMethod: 'independent_test_run',
        verificationReason: `test still fails: ${err.message}`,
        observedState: { exitCode: err.status ?? 1, passed: false, failed: 1, verificationSource: 'independent_verifier' },
      };
    }
  }
}

export class CodeVerifier implements IndependentVerifier {
  public readonly verifierId = 'code_verifier';
  public readonly domain = 'code';

  canVerify(goal: Goal, _executionResult: ActionExecutionResult): boolean {
    const taskId = goal.metadata?.taskId as string | undefined;
    if (taskId === 'T06_code_modify') return true;
    const domain = goal.metadata?.domain as string | undefined;
    return domain === 'code';
  }

  async verify(goal: Goal, _decision: Decision | null, _executionResult: ActionExecutionResult): Promise<IndependentVerification> {
    const tempDir = goal.metadata?.tempDir as string;
    const taskId = goal.metadata?.taskId as string;

    try {
      if (taskId === 'T06_code_modify') {
        return this.verifyT06(tempDir);
      }
      return { verified: false, verificationMethod: 'code_no_handler', verificationReason: `no handler for ${taskId}`, observedState: { verificationSource: 'independent_verifier' } };
    } catch (err) {
      Logger.error(`[D8-1.1] CodeVerifier error: ${(err as Error).message}`, err as Error, 'CodeVerifier');
      return { verified: false, verificationMethod: 'code_error', verificationReason: (err as Error).message, observedState: { verificationSource: 'independent_verifier' } };
    }
  }

  private verifyT06(tempDir: string): IndependentVerification {
    const filePath = path.join(tempDir, 'calculator.js');
    if (!fsExists(filePath)) {
      return { verified: false, verificationMethod: 'code_file_exists', verificationReason: 'calculator.js not found', observedState: { exists: false, verificationSource: 'independent_verifier' } };
    }
    const content = fsReadContent(filePath);
    const hasAdd = content?.includes('add') ?? false;
    const hasAddBody = content?.includes('a + b') ?? false;
    const match = hasAdd && hasAddBody;

    let testResult: { passed: boolean; output: string } | null = null;
    try {
      const { execSync } = require('child_process');
      const testContent = `
const assert = require('assert');
${content}
assert.strictEqual(typeof add, 'function', 'add is a function');
assert.strictEqual(add(2, 3), 5, 'add(2,3) === 5');
console.log('Code verification test passed');
`;
      const testPath = path.join(tempDir, '__code_verify_test__.js');
      fs.writeFileSync(testPath, testContent, 'utf-8');
      const output = execSync('node __code_verify_test__.js', { cwd: tempDir, encoding: 'utf-8', timeout: 10000 });
      testResult = { passed: output.includes('Code verification test passed'), output: output.trim() };
      try { fs.unlinkSync(testPath); } catch {}
    } catch (err: any) {
      testResult = { passed: false, output: err.message };
      const testPath = path.join(tempDir, '__code_verify_test__.js');
      try { fs.unlinkSync(testPath); } catch {}
    }

    const fullyVerified = match && (testResult?.passed ?? false);
    return {
      verified: fullyVerified,
      verificationMethod: 'code_read_and_test',
      verificationReason: fullyVerified
        ? 'add function found and independently tested'
        : match
          ? `add function found but test failed: ${testResult?.output}`
          : 'add function not found in file',
      observedState: { exists: true, hasAdd, hasAddBody, testPassed: testResult?.passed ?? false, verificationSource: 'independent_verifier' },
    };
  }
}

export class NovelTaskVerifier implements IndependentVerifier {
  public readonly verifierId = 'novel_task_verifier';
  public readonly domain = 'novel';

  private static readonly NOVEL_TASK_IDS = [
    'N1_config_typo', 'N2_data_transform', 'N3_unknown_dir_restore',
    'N4_test_setup_fix', 'N5_cross_file_dep', 'N6_multi_step_pipeline',
    'N7_env_disturb_file_move', 'N8_recursive_schema',
  ];

  canVerify(goal: Goal, _executionResult: ActionExecutionResult): boolean {
    const taskId = goal.metadata?.taskId as string | undefined;
    return !!taskId && NovelTaskVerifier.NOVEL_TASK_IDS.includes(taskId);
  }

  async verify(goal: Goal, _decision: Decision | null, _executionResult: ActionExecutionResult): Promise<IndependentVerification> {
    const tempDir = goal.metadata?.tempDir as string;
    const taskId = goal.metadata?.taskId as string;

    if (!tempDir || !taskId) {
      return { verified: false, verificationMethod: 'novel_no_metadata', verificationReason: 'missing tempDir or taskId', observedState: { verificationSource: 'independent_verifier' } };
    }

    try {
      return this.verifyByTestFile(tempDir, taskId);
    } catch (err) {
      Logger.error(`[D8-1.1] NovelTaskVerifier error for ${taskId}: ${(err as Error).message}`, err as Error, 'NovelTaskVerifier');
      return { verified: false, verificationMethod: 'novel_error', verificationReason: (err as Error).message, observedState: { verificationSource: 'independent_verifier' } };
    }
  }

  private verifyByTestFile(tempDir: string, taskId: string): IndependentVerification {
    const files = fs.readdirSync(tempDir);
    const testFile = files.find(f =>
      f.includes('test') || f.includes('spec') || f.includes('_test')
    );

    if (!testFile) {
      return {
        verified: false,
        verificationMethod: 'novel_no_test_file',
        verificationReason: `no test file found in ${tempDir}`,
        observedState: { files, verificationSource: 'independent_verifier' },
      };
    }

    try {
      const { execSync } = require('child_process');
      const output = execSync(`node ${testFile}`, {
        cwd: tempDir,
        encoding: 'utf-8',
        timeout: 15000,
      });
      const passed = /PASS|All tests passed|Test passed/.test(output);
      return {
        verified: passed,
        verificationMethod: 'novel_independent_test_run',
        verificationReason: passed
          ? `${testFile} passes independently — task ${taskId} verified from environment`
          : `test output does not contain PASS: ${output.trim().slice(0, 200)}`,
        observedState: {
          testFile,
          exitCode: 0,
          passed,
          output: output.trim().slice(0, 500),
          verificationSource: 'independent_verifier',
        },
      };
    } catch (err: any) {
      const stderr = err.stderr ? String(err.stderr).slice(0, 500) : '';
      const stdout = err.stdout ? String(err.stdout).slice(0, 500) : '';
      return {
        verified: false,
        verificationMethod: 'novel_independent_test_run',
        verificationReason: `test ${testFile} failed independently: ${err.message?.slice(0, 200)}`,
        observedState: {
          testFile,
          exitCode: err.status ?? 1,
          passed: false,
          stdout,
          stderr,
          verificationSource: 'independent_verifier',
        },
      };
    }
  }
}

export class DesktopVerifier implements IndependentVerifier {
  public readonly verifierId = 'desktop_verifier';
  public readonly domain = 'desktop';

  canVerify(goal: Goal, executionResult: ActionExecutionResult): boolean {
    return executionResult.actionType === 'desktop_action';
  }

  async verify(_goal: Goal, _decision: Decision | null, executionResult: ActionExecutionResult): Promise<IndependentVerification> {
    const rawResult = executionResult.rawResult as Record<string, unknown> | null;
    if (rawResult && typeof rawResult === 'object' && 'finalObservation' in rawResult && rawResult.finalObservation != null) {
      return {
        verified: true,
        verificationMethod: 'desktop_post_execution_observation',
        verificationReason: 'desktop action followed by independent environment observation',
        observedState: { desktopObservation: rawResult.finalObservation, observationSource: 'post_execution_env_read', verificationSource: 'independent_verifier' },
      };
    }
    return {
      verified: false,
      verificationMethod: 'desktop_no_observation',
      verificationReason: 'desktop action produced no independent observation',
      observedState: { verificationSource: 'independent_verifier' },
    };
  }
}

class VerifierRegistry {
  private readonly verifiers: IndependentVerifier[] = [];

  register(verifier: IndependentVerifier): void {
    this.verifiers.push(verifier);
  }

  findVerifier(goal: Goal, executionResult: ActionExecutionResult): IndependentVerifier | null {
    for (const v of this.verifiers) {
      if (v.canVerify(goal, executionResult)) return v;
    }
    return null;
  }

  findAllVerifiers(goal: Goal, executionResult: ActionExecutionResult): IndependentVerifier[] {
    return this.verifiers.filter(v => v.canVerify(goal, executionResult));
  }

  getVerifiers(): readonly IndependentVerifier[] {
    return this.verifiers;
  }
}

let registry: VerifierRegistry | null = null;

export function getVerifierRegistry(): VerifierRegistry {
  if (!registry) {
    registry = new VerifierRegistry();
    registry.register(new FilesystemVerifier());
    registry.register(new TestVerifier());
    registry.register(new CodeVerifier());
    registry.register(new NovelTaskVerifier());
    registry.register(new DesktopVerifier());
  }
  return registry;
}

export function resetVerifierRegistry(): void {
  registry = null;
}

export async function runIndependentVerification(
  goal: Goal,
  decision: Decision | null,
  executionResult: ActionExecutionResult
): Promise<IndependentVerification | null> {
  const reg = getVerifierRegistry();
  const verifier = reg.findVerifier(goal, executionResult);
  if (!verifier) {
    Logger.info(`[D8-1.1] No independent verifier found for goal ${goal.goalId} (taskId=${goal.metadata?.taskId})`, 'IndependentVerifier');
    return null;
  }
  Logger.info(`[D8-1.1] Running ${verifier.verifierId} for goal ${goal.goalId}`, 'IndependentVerifier');
  const result = await verifier.verify(goal, decision, executionResult);
  Logger.info(`[D8-1.1] ${verifier.verifierId} result: verified=${result.verified} reason="${result.verificationReason}"`, 'IndependentVerifier');
  return result;
}
