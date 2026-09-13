import { RealTaskHarness } from '../../harness/realTask/RealTaskHarness';
import {
  G1_MulInsteadOfAdd, G2_OffByOne, G3_UnknownPathMissing,
  G4_NestedDirMissing, G5_ConfigError, G6_TwoStageError,
} from '../../harness/realTask/RealTasks';
import type { RealTask, RealTaskResult } from '../../harness/realTask/RealTaskTypes';

const TIMEOUT = 120000;
const TASKS: RealTask[] = [G1_MulInsteadOfAdd, G2_OffByOne, G3_UnknownPathMissing, G4_NestedDirMissing, G5_ConfigError, G6_TwoStageError];

describe('D8-3.1 Full Diagnostic', () => {
  for (const mode of ['generic_plus_edr', 'generic_only', 'edr_only'] as const) {
    test(`All 6 tasks mode=${mode}`, async () => {
      const harness = new RealTaskHarness();
      harness.setRecoveryProposerMode(mode);

      process.stderr.write(`\n=== DIAGNOSTIC: mode=${mode} ===\n`);

      const results: RealTaskResult[] = [];
      for (const task of TASKS) {
        const r = await harness.runTask(task);
        results.push(r);
        process.stderr.write(`  ${r.taskId}: declared=${r.declaredCompleted} verified=${r.externallyVerified} status=${r.evidenceChain?.finalStatus} time=${r.totalTimeMs}ms error=${r.error || 'none'}\n`);
      }

      const verified = results.filter(r => r.externallyVerified).length;
      const declared = results.filter(r => r.declaredCompleted).length;
      process.stderr.write(`\n  SUMMARY: declared=${declared} verified=${verified}/6 rate=${(verified/6).toFixed(2)}\n`);

      expect(results.length).toBe(6);
    }, TIMEOUT * 6);
  }
});
