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
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const EvolutionEngineV2_1 = require("../EvolutionEngineV2");
const types_1 = require("../types");
// Mock child_process for validateEvolution (runs tsc/jest in production)
jest.mock('child_process', () => ({
    execSync: jest.fn().mockReturnValue(Buffer.from('')),
}));
describe('EvolutionEngineV2 - 真正自我进化', () => {
    let tempDir;
    let engine;
    let mockLLM;
    beforeEach(() => {
        tempDir = path.join(os.tmpdir(), `evolution-engine-v2-test-${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });
        mockLLM = {
            chat: jest.fn(),
        };
        engine = new EvolutionEngineV2_1.EvolutionEngineV2(mockLLM, tempDir);
    });
    afterEach(() => {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        catch {
            /* ignore */
        }
    });
    describe('核心功能测试', () => {
        test('应该触发真正的进化并修改文件', async () => {
            const testFile = path.join(tempDir, 'target-file.ts');
            fs.writeFileSync(testFile, 'const oldCode = "old";\n', 'utf-8');
            mockLLM.chat.mockResolvedValue(JSON.stringify({
                type: types_1.EvolutionType.CODE_FIX,
                priority: types_1.EvolutionPriority.HIGH,
                title: '修复代码Bug',
                description: '修复测试文件中的bug',
                actions: [
                    {
                        type: 'MODIFY_FILE',
                        target: { filePath: testFile },
                        content: 'const newCode = "new";\n',
                        originalContent: 'const oldCode = "old";\n',
                        description: '修复bug',
                    },
                ],
                estimatedRisk: 'LOW',
                validationSteps: ['检查文件修改'],
            }));
            const cause = {
                type: 'FAILURE',
                description: '代码执行失败',
                context: {
                    failureInfo: '测试文件中的代码有bug',
                },
                timestamp: Date.now(),
            };
            const result = await engine.triggerEvolution(cause);
            expect(result).not.toBeNull();
            expect(result.success).toBe(true);
            expect(result.executedActions).toBe(1);
            expect(fs.readFileSync(testFile, 'utf-8')).toBe('const newCode = "new";\n');
        });
        test('应该执行成功的进化并修改文件', async () => {
            const testFile = path.join(tempDir, 'success-test.ts');
            const originalContent = 'const original = true;\n';
            fs.writeFileSync(testFile, originalContent, 'utf-8');
            mockLLM.chat.mockResolvedValue(JSON.stringify({
                type: types_1.EvolutionType.CODE_FIX,
                priority: types_1.EvolutionPriority.HIGH,
                title: '成功修改文件',
                description: '修改测试文件',
                actions: [
                    {
                        type: 'MODIFY_FILE',
                        target: { filePath: testFile },
                        content: 'const modified = false;\n',
                        originalContent: originalContent,
                        description: '修改文件',
                    },
                ],
                estimatedRisk: 'LOW',
                validationSteps: ['检查文件修改'],
            }));
            const cause = {
                type: 'FAILURE',
                description: '测试成功进化',
                context: {
                    failureInfo: '测试用例',
                },
                timestamp: Date.now(),
            };
            const result = await engine.triggerEvolution(cause);
            expect(result).not.toBeNull();
            expect(result.success).toBe(true);
            // 成功的进化应该修改文件，而不是回滚
            expect(fs.readFileSync(testFile, 'utf-8')).toBe('const modified = false;\n');
        });
        test('应该创建新文件作为进化结果', async () => {
            const newFilePath = path.join(tempDir, 'new-evolved-file.ts');
            mockLLM.chat.mockResolvedValue(JSON.stringify({
                type: types_1.EvolutionType.CODE_OPTIMIZATION,
                priority: types_1.EvolutionPriority.MEDIUM,
                title: '创建优化文件',
                description: '创建新的优化文件',
                actions: [
                    {
                        type: 'CREATE_FILE',
                        target: newFilePath,
                        content: 'export const optimized = true;\n',
                        description: '创建优化文件',
                    },
                ],
                estimatedRisk: 'LOW',
                validationSteps: ['检查文件创建'],
            }));
            const cause = {
                type: 'PROACTIVE_IMPROVEMENT',
                description: '主动优化性能',
                context: {},
                timestamp: Date.now(),
            };
            const result = await engine.triggerEvolution(cause);
            expect(result).not.toBeNull();
            expect(result.success).toBe(true);
            expect(fs.existsSync(newFilePath)).toBe(true);
            expect(fs.readFileSync(newFilePath, 'utf-8')).toBe('export const optimized = true;\n');
        });
        test('应该拒绝空计划（无操作）', async () => {
            mockLLM.chat.mockResolvedValue(JSON.stringify({
                type: types_1.EvolutionType.CODE_FIX,
                priority: types_1.EvolutionPriority.LOW,
                title: '空计划',
                description: '没有操作的计划',
                actions: [],
                estimatedRisk: 'LOW',
                validationSteps: [],
            }));
            const cause = {
                type: 'PROACTIVE_IMPROVEMENT',
                description: '测试空计划',
                context: {},
                timestamp: Date.now(),
            };
            const result = await engine.triggerEvolution(cause);
            expect(result).not.toBeNull();
            expect(result.success).toBe(true);
            expect(result.executedActions).toBe(0);
        });
    });
    describe('进化历史和指标', () => {
        test('应该记录进化历史', async () => {
            mockLLM.chat.mockResolvedValue(JSON.stringify({
                type: types_1.EvolutionType.CODE_FIX,
                priority: types_1.EvolutionPriority.HIGH,
                title: '测试进化',
                description: '测试进化历史记录',
                actions: [],
                estimatedRisk: 'LOW',
                validationSteps: [],
            }));
            const cause = {
                type: 'FAILURE',
                description: '测试',
                context: {},
                timestamp: Date.now(),
            };
            await engine.triggerEvolution(cause);
            const history = engine.getHistory();
            expect(history.length).toBe(1);
            expect(history[0].type).toBe(types_1.EvolutionType.CODE_FIX);
        });
        test('应该计算进化指标', async () => {
            mockLLM.chat.mockResolvedValue(JSON.stringify({
                type: types_1.EvolutionType.CODE_OPTIMIZATION,
                priority: types_1.EvolutionPriority.MEDIUM,
                title: '性能优化',
                description: '优化性能',
                actions: [],
                estimatedRisk: 'LOW',
                validationSteps: [],
            }));
            const cause = {
                type: 'PERFORMANCE_ISSUE',
                description: '性能问题',
                context: {
                    performanceMetric: {
                        name: 'response_time',
                        value: 5000,
                        threshold: 1000,
                    },
                },
                timestamp: Date.now(),
            };
            await engine.triggerEvolution(cause);
            const metrics = engine.getMetrics();
            expect(metrics.totalEvolutions).toBe(1);
            expect(metrics.evolutionsByType[types_1.EvolutionType.CODE_OPTIMIZATION]).toBe(1);
        });
    });
    describe('并发控制', () => {
        test('应该在进化进行中时拒绝新的进化请求', async () => {
            mockLLM.chat.mockImplementation(async () => {
                await new Promise((resolve) => setTimeout(resolve, 100));
                return JSON.stringify({
                    type: types_1.EvolutionType.CODE_FIX,
                    priority: types_1.EvolutionPriority.HIGH,
                    title: '长任务',
                    description: '模拟长时间运行的进化',
                    actions: [],
                    estimatedRisk: 'LOW',
                    validationSteps: [],
                });
            });
            const cause = {
                type: 'FAILURE',
                description: '测试并发',
                context: {},
                timestamp: Date.now(),
            };
            const result1Promise = engine.triggerEvolution(cause);
            const result2 = await engine.triggerEvolution(cause);
            expect(result2).toBeNull();
            await result1Promise;
        });
    });
});
