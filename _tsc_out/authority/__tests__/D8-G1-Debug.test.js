"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const RealTaskHarness_1 = require("../../harness/realTask/RealTaskHarness");
const RealTasks_1 = require("../../harness/realTask/RealTasks");
test('G1 debug: trace full execution', async () => {
    const harness = new RealTaskHarness_1.RealTaskHarness();
    harness.setRecoveryProposerMode('generic_only');
    const origLog = console.log;
    const logs = [];
    console.log = (...args) => {
        const msg = args.map(String).join(' ');
        logs.push(msg);
        process.stderr.write(msg + '\n');
    };
    try {
        const result = await harness.runTask(RealTasks_1.G1_MulInsteadOfAdd);
        process.stderr.write(`\n=== G1 RESULT ===\n`);
        process.stderr.write(`taskId: ${result.taskId}\n`);
        process.stderr.write(`declaredCompleted: ${result.declaredCompleted}\n`);
        process.stderr.write(`externallyVerified: ${result.externallyVerified}\n`);
        process.stderr.write(`totalTimeMs: ${result.totalTimeMs}\n`);
        process.stderr.write(`error: ${result.error || 'none'}\n`);
        process.stderr.write(`evidenceChain: ${JSON.stringify(result.evidenceChain, null, 2)}\n`);
    }
    finally {
        console.log = origLog;
    }
    expect(true).toBe(true);
}, 60000);
