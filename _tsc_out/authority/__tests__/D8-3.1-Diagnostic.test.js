"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const RealTaskHarness_1 = require("../../harness/realTask/RealTaskHarness");
const RealTasks_1 = require("../../harness/realTask/RealTasks");
const TIMEOUT = 120000;
const TASKS = [RealTasks_1.G1_MulInsteadOfAdd, RealTasks_1.G2_OffByOne, RealTasks_1.G3_UnknownPathMissing, RealTasks_1.G4_NestedDirMissing, RealTasks_1.G5_ConfigError, RealTasks_1.G6_TwoStageError];
describe('D8-3.1 Full Diagnostic', () => {
    for (const mode of ['generic_plus_edr', 'generic_only', 'edr_only']) {
        test(`All 6 tasks mode=${mode}`, async () => {
            const harness = new RealTaskHarness_1.RealTaskHarness();
            harness.setRecoveryProposerMode(mode);
            process.stderr.write(`\n=== DIAGNOSTIC: mode=${mode} ===\n`);
            const results = [];
            for (const task of TASKS) {
                const r = await harness.runTask(task);
                results.push(r);
                process.stderr.write(`  ${r.taskId}: declared=${r.declaredCompleted} verified=${r.externallyVerified} status=${r.evidenceChain?.finalStatus} time=${r.totalTimeMs}ms error=${r.error || 'none'}\n`);
            }
            const verified = results.filter(r => r.externallyVerified).length;
            const declared = results.filter(r => r.declaredCompleted).length;
            process.stderr.write(`\n  SUMMARY: declared=${declared} verified=${verified}/6 rate=${(verified / 6).toFixed(2)}\n`);
            expect(results.length).toBe(6);
        }, TIMEOUT * 6);
    }
});
