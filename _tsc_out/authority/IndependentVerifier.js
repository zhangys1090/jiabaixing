"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DesktopVerifier = exports.CodeVerifier = exports.TestVerifier = exports.FilesystemVerifier = void 0;
exports.getVerifierRegistry = getVerifierRegistry;
exports.resetVerifierRegistry = resetVerifierRegistry;
exports.runIndependentVerification = runIndependentVerification;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const Logger_1 = require("../utils/Logger");
function fsExists(filePath) {
    try {
        return fs.existsSync(filePath);
    }
    catch {
        return false;
    }
}
function fsReadContent(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf-8');
    }
    catch {
        return null;
    }
}
function fsFileSize(filePath) {
    try {
        return fs.statSync(filePath).size;
    }
    catch {
        return null;
    }
}
function fsHash(filePath) {
    try {
        const content = fs.readFileSync(filePath);
        return crypto.createHash('sha256').update(content).digest('hex');
    }
    catch {
        return null;
    }
}
function fsDirMembers(dirPath) {
    try {
        return fs.readdirSync(dirPath);
    }
    catch {
        return null;
    }
}
class FilesystemVerifier {
    verifierId = 'filesystem_verifier';
    domain = 'filesystem';
    canVerify(goal, _executionResult) {
        const tempDir = goal.metadata?.tempDir;
        if (!tempDir)
            return false;
        const taskId = goal.metadata?.taskId;
        if (!taskId)
            return false;
        return taskId.startsWith('T01') || taskId.startsWith('T02') || taskId.startsWith('T03') ||
            taskId.startsWith('T06') || taskId.startsWith('T09') || taskId.startsWith('T10');
    }
    async verify(goal, _decision, _executionResult) {
        const tempDir = goal.metadata?.tempDir;
        const taskId = goal.metadata?.taskId;
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
        }
        catch (err) {
            Logger_1.Logger.error(`[D8-1.1] FilesystemVerifier error for ${taskId}: ${err.message}`, err, 'FilesystemVerifier');
            return { verified: false, verificationMethod: 'filesystem_error', verificationReason: err.message, observedState: { verificationSource: 'independent_verifier' } };
        }
    }
    verifyT01(tempDir) {
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
    verifyT02(tempDir) {
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
    verifyT03(tempDir) {
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
    verifyT06(tempDir) {
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
    verifyT09(tempDir) {
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
    verifyT10(tempDir) {
        const filePath = path.join(tempDir, 'data.json');
        if (!fsExists(filePath)) {
            return { verified: false, verificationMethod: 'fs_exists', verificationReason: 'data.json not found', observedState: { exists: false, verificationSource: 'independent_verifier' } };
        }
        const content = fsReadContent(filePath);
        const hash = fsHash(filePath);
        try {
            const parsed = JSON.parse(content);
            const hasField = 'addedField' in parsed;
            return {
                verified: hasField,
                verificationMethod: 'fs_read_json',
                verificationReason: hasField ? 'data.json has addedField' : `missing addedField: ${JSON.stringify(parsed)}`,
                observedState: { exists: true, hasAddedField: hasField, keys: Object.keys(parsed), hash, verificationSource: 'independent_verifier' },
            };
        }
        catch {
            return { verified: false, verificationMethod: 'fs_read_json', verificationReason: 'data.json is not valid JSON', observedState: { exists: true, parseError: true, hash, verificationSource: 'independent_verifier' } };
        }
    }
}
exports.FilesystemVerifier = FilesystemVerifier;
class TestVerifier {
    verifierId = 'test_verifier';
    domain = 'test';
    canVerify(goal, _executionResult) {
        const taskId = goal.metadata?.taskId;
        return taskId === 'T07_run_test' || taskId === 'T08_test_fail_fix';
    }
    async verify(goal, _decision, _executionResult) {
        const tempDir = goal.metadata?.tempDir;
        const taskId = goal.metadata?.taskId;
        try {
            if (taskId === 'T07_run_test') {
                return this.verifyT07(tempDir);
            }
            if (taskId === 'T08_test_fail_fix') {
                return this.verifyT08(tempDir);
            }
            return { verified: false, verificationMethod: 'test_no_handler', verificationReason: `no handler for ${taskId}`, observedState: { verificationSource: 'independent_verifier' } };
        }
        catch (err) {
            Logger_1.Logger.error(`[D8-1.1] TestVerifier error for ${taskId}: ${err.message}`, err, 'TestVerifier');
            return { verified: false, verificationMethod: 'test_error', verificationReason: err.message, observedState: { verificationSource: 'independent_verifier' } };
        }
    }
    verifyT07(tempDir) {
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
        }
        catch (err) {
            return {
                verified: false,
                verificationMethod: 'independent_test_run',
                verificationReason: `test failed: ${err.message}`,
                observedState: { exitCode: err.status ?? 1, passed: false, failed: 1, verificationSource: 'independent_verifier' },
            };
        }
    }
    verifyT08(tempDir) {
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
        }
        catch (err) {
            return {
                verified: false,
                verificationMethod: 'independent_test_run',
                verificationReason: `test still fails: ${err.message}`,
                observedState: { exitCode: err.status ?? 1, passed: false, failed: 1, verificationSource: 'independent_verifier' },
            };
        }
    }
}
exports.TestVerifier = TestVerifier;
class CodeVerifier {
    verifierId = 'code_verifier';
    domain = 'code';
    canVerify(goal, _executionResult) {
        const taskId = goal.metadata?.taskId;
        if (taskId === 'T06_code_modify')
            return true;
        const domain = goal.metadata?.domain;
        return domain === 'code';
    }
    async verify(goal, _decision, _executionResult) {
        const tempDir = goal.metadata?.tempDir;
        const taskId = goal.metadata?.taskId;
        try {
            if (taskId === 'T06_code_modify') {
                return this.verifyT06(tempDir);
            }
            return { verified: false, verificationMethod: 'code_no_handler', verificationReason: `no handler for ${taskId}`, observedState: { verificationSource: 'independent_verifier' } };
        }
        catch (err) {
            Logger_1.Logger.error(`[D8-1.1] CodeVerifier error: ${err.message}`, err, 'CodeVerifier');
            return { verified: false, verificationMethod: 'code_error', verificationReason: err.message, observedState: { verificationSource: 'independent_verifier' } };
        }
    }
    verifyT06(tempDir) {
        const filePath = path.join(tempDir, 'calculator.js');
        if (!fsExists(filePath)) {
            return { verified: false, verificationMethod: 'code_file_exists', verificationReason: 'calculator.js not found', observedState: { exists: false, verificationSource: 'independent_verifier' } };
        }
        const content = fsReadContent(filePath);
        const hasAdd = content?.includes('add') ?? false;
        const hasAddBody = content?.includes('a + b') ?? false;
        const match = hasAdd && hasAddBody;
        let testResult = null;
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
            try {
                fs.unlinkSync(testPath);
            }
            catch { }
        }
        catch (err) {
            testResult = { passed: false, output: err.message };
            const testPath = path.join(tempDir, '__code_verify_test__.js');
            try {
                fs.unlinkSync(testPath);
            }
            catch { }
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
exports.CodeVerifier = CodeVerifier;
class DesktopVerifier {
    verifierId = 'desktop_verifier';
    domain = 'desktop';
    canVerify(goal, executionResult) {
        return executionResult.actionType === 'desktop_action';
    }
    async verify(_goal, _decision, executionResult) {
        const rawResult = executionResult.rawResult;
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
exports.DesktopVerifier = DesktopVerifier;
class VerifierRegistry {
    verifiers = [];
    register(verifier) {
        this.verifiers.push(verifier);
    }
    findVerifier(goal, executionResult) {
        for (const v of this.verifiers) {
            if (v.canVerify(goal, executionResult))
                return v;
        }
        return null;
    }
    findAllVerifiers(goal, executionResult) {
        return this.verifiers.filter(v => v.canVerify(goal, executionResult));
    }
    getVerifiers() {
        return this.verifiers;
    }
}
let registry = null;
function getVerifierRegistry() {
    if (!registry) {
        registry = new VerifierRegistry();
        registry.register(new FilesystemVerifier());
        registry.register(new TestVerifier());
        registry.register(new CodeVerifier());
        registry.register(new DesktopVerifier());
    }
    return registry;
}
function resetVerifierRegistry() {
    registry = null;
}
async function runIndependentVerification(goal, decision, executionResult) {
    const reg = getVerifierRegistry();
    const verifier = reg.findVerifier(goal, executionResult);
    if (!verifier) {
        Logger_1.Logger.info(`[D8-1.1] No independent verifier found for goal ${goal.goalId} (taskId=${goal.metadata?.taskId})`, 'IndependentVerifier');
        return null;
    }
    Logger_1.Logger.info(`[D8-1.1] Running ${verifier.verifierId} for goal ${goal.goalId}`, 'IndependentVerifier');
    const result = await verifier.verify(goal, decision, executionResult);
    Logger_1.Logger.info(`[D8-1.1] ${verifier.verifierId} result: verified=${result.verified} reason="${result.verificationReason}"`, 'IndependentVerifier');
    return result;
}
