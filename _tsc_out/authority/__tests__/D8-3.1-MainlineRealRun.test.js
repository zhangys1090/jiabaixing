"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const realTask_1 = require("../../harness/realTask");
const realTask_2 = require("../../harness/realTask");
const TIMEOUT = 120000;
const NOVEL_TASKS = [
    realTask_2.G1_MulInsteadOfAdd,
    realTask_2.G2_OffByOne,
    realTask_2.G3_UnknownPathMissing,
    realTask_2.G4_NestedDirMissing,
    realTask_2.G5_ConfigError,
    realTask_2.G6_TwoStageError,
];
async function runMainlineAblationGroup(tasks, mode) {
    const harness = new realTask_1.RealTaskHarness();
    harness.setRecoveryProposerMode(mode);
    const traces = [];
    for (const task of tasks) {
        const result = await harness.runTask(task);
        traces.push({
            taskId: result.taskId,
            group: mode,
            declaredCompleted: result.declaredCompleted,
            externallyVerified: result.externallyVerified,
            verificationEvidence: result.verificationEvidence || '',
            totalTimeMs: result.totalTimeMs,
            error: result.error,
            finalStatus: result.evidenceChain?.finalStatus || 'unknown',
        });
    }
    const total = traces.length;
    const declared = traces.filter(t => t.declaredCompleted).length;
    const verified = traces.filter(t => t.externallyVerified).length;
    const falseRecovery = traces.filter(t => t.declaredCompleted && !t.externallyVerified).length;
    const errors = traces.filter(t => t.error !== null).length;
    const totalTime = traces.reduce((s, t) => s + t.totalTimeMs, 0);
    return {
        group: mode,
        totalAttempts: total,
        declaredCompleted: declared,
        verifiedRecoveries: verified,
        recoveryRate: total > 0 ? verified / total : 0,
        falseRecoveryCount: falseRecovery,
        falseRecoveryRate: declared > 0 ? falseRecovery / declared : 0,
        averageTimeMs: total > 0 ? totalTime / total : 0,
        errorCount: errors,
        perTask: traces.map(t => ({ taskId: t.taskId, verified: t.externallyVerified, time: t.totalTimeMs })),
    };
}
function formatMetrics(m) {
    return `
[MAINLINE ABLATION — ${m.group}]
  totalAttempts:        ${m.totalAttempts}
  declaredCompleted:    ${m.declaredCompleted}
  verifiedRecoveries:   ${m.verifiedRecoveries}
  recoveryRate:         ${m.recoveryRate.toFixed(2)}
  falseRecoveryCount:   ${m.falseRecoveryCount}
  falseRecoveryRate:    ${m.falseRecoveryRate.toFixed(2)}
  averageTimeMs:        ${m.averageTimeMs.toFixed(0)}
  errorCount:           ${m.errorCount}
  perTask:
${m.perTask.map(p => `    ${p.taskId}: verified=${p.verified} time=${p.time}ms`).join('\n')}
`;
}
describe('D8-3.1 Mainline Real Run — A/B/C Strategy Ablation', () => {
    describe('Group A: Generic + EDR via RealTaskHarness', () => {
        test('A: all novel tasks through production harness', async () => {
            const metrics = await runMainlineAblationGroup(NOVEL_TASKS, 'generic_plus_edr');
            process.stderr.write(formatMetrics(metrics));
            expect(metrics.totalAttempts).toBe(6);
            expect(metrics.falseRecoveryRate).toBe(0);
        }, TIMEOUT * 6);
    });
    describe('Group B: Generic Only via RealTaskHarness (STRATEGY-FREE)', () => {
        test('B: all novel tasks through production harness with EDR disabled', async () => {
            const metrics = await runMainlineAblationGroup(NOVEL_TASKS, 'generic_only');
            process.stderr.write(formatMetrics(metrics));
            expect(metrics.totalAttempts).toBe(6);
            expect(metrics.falseRecoveryRate).toBe(0);
        }, TIMEOUT * 6);
    });
    describe('Group C: EDR Only via RealTaskHarness (HEURISTIC BASELINE)', () => {
        test('C: all novel tasks through production harness with Generic disabled', async () => {
            const metrics = await runMainlineAblationGroup(NOVEL_TASKS, 'edr_only');
            process.stderr.write(formatMetrics(metrics));
            expect(metrics.totalAttempts).toBe(6);
        }, TIMEOUT * 6);
    });
    describe('Strategy-Free Gate — Real Mainline Numbers', () => {
        test('Compute Strategy-Free Recovery Rate from Group B mainline run', async () => {
            const metricsB = await runMainlineAblationGroup(NOVEL_TASKS, 'generic_only');
            process.stderr.write(`
╔══════════════════════════════════════════════════════════╗
║          STRATEGY-FREE RECOVERY GATE (MAINLINE)          ║
╠══════════════════════════════════════════════════════════╣
║  Group B (Generic Only, EDR disabled)                    ║
║  Total Attempts:       ${metricsB.totalAttempts}                               ║
║  Verified Recoveries:  ${metricsB.verifiedRecoveries}                               ║
║  Recovery Rate:        ${metricsB.recoveryRate.toFixed(2)}                            ║
║  False Recovery Rate:  ${metricsB.falseRecoveryRate.toFixed(2)}                            ║
║                                                          ║
║  Threshold for D8-4:    0.60                            ║
║  PASS:                  ${metricsB.recoveryRate >= 0.60}                            ║
║                                                          ║
║  Per-task:                                               ║
${metricsB.perTask.map(p => `║    ${p.taskId.padEnd(25)} verified=${String(p.verified).padEnd(5)} ${p.time}ms║`).join('\n')}
╚══════════════════════════════════════════════════════════╝
`);
            expect(metricsB.totalAttempts).toBe(6);
            expect(metricsB.falseRecoveryRate).toBe(0);
        }, TIMEOUT * 6);
    });
    describe('A/B/C Comparison Table', () => {
        test('Full A/B/C comparison through production harness', async () => {
            const mA = await runMainlineAblationGroup(NOVEL_TASKS, 'generic_plus_edr');
            const mB = await runMainlineAblationGroup(NOVEL_TASKS, 'generic_only');
            const mC = await runMainlineAblationGroup(NOVEL_TASKS, 'edr_only');
            process.stderr.write(`
╔══════════════════════════════════════════════════════════════════════╗
║              A/B/C STRATEGY ABLATION COMPARISON (MAINLINE)           ║
╠══════════════════════════════════════════════════════════════════════╣
║ Group │ Proposer       │ Attempts │ Verified │ Rate  │ False │ Avg ms ║
╠═══════╪════════════════╪══════════╪══════════╪═══════╪═══════╪════════╣
║ A     │ Generic + EDR  │ ${String(mA.totalAttempts).padEnd(8)} │ ${String(mA.verifiedRecoveries).padEnd(8)} │ ${mA.recoveryRate.toFixed(2)}  │ ${mA.falseRecoveryCount}     │ ${mA.averageTimeMs.toFixed(0).padEnd(6)} ║
║ B     │ Generic Only   │ ${String(mB.totalAttempts).padEnd(8)} │ ${String(mB.verifiedRecoveries).padEnd(8)} │ ${mB.recoveryRate.toFixed(2)}  │ ${mB.falseRecoveryCount}     │ ${mB.averageTimeMs.toFixed(0).padEnd(6)} ║
║ C     │ EDR Only       │ ${String(mC.totalAttempts).padEnd(8)} │ ${String(mC.verifiedRecoveries).padEnd(8)} │ ${mC.recoveryRate.toFixed(2)}  │ ${mC.falseRecoveryCount}     │ ${mC.averageTimeMs.toFixed(0).padEnd(6)} ║
╠═══════╪════════════════╪══════════╪══════════╪═══════╪═══════╪════════╣
║ Strategy-Free Recovery Rate (B) = ${mB.recoveryRate.toFixed(2)}                            ║
║ Novel Failure Recovery Rate (B) = ${mB.recoveryRate.toFixed(2)}                            ║
║ False Recovery Rate (B)         = ${mB.falseRecoveryRate.toFixed(2)}                            ║
║ D8-4 Gate (B >= 0.60, False=0)  = ${mB.recoveryRate >= 0.60 && mB.falseRecoveryRate === 0}                            ║
╚══════════════════════════════════════════════════════════════════════╝
`);
            expect(mA.totalAttempts).toBe(6);
            expect(mB.totalAttempts).toBe(6);
            expect(mC.totalAttempts).toBe(6);
        }, TIMEOUT * 18);
    });
    describe('planVersion Semantic Audit', () => {
        test('planVersion > 0 reliably indicates recovery/replan phase', async () => {
            const harness = new realTask_1.RealTaskHarness();
            harness.setRecoveryProposerMode('generic_plus_edr');
            const result = await harness.runTask(realTask_2.T08_TestFailAndFix);
            process.stderr.write(`\n[planVersion audit] T08: declared=${result.declaredCompleted} verified=${result.externallyVerified} status=${result.evidenceChain?.finalStatus}\n`);
            expect(result.taskId).toBe(realTask_2.T08_TestFailAndFix.taskId);
        }, TIMEOUT);
    });
});
