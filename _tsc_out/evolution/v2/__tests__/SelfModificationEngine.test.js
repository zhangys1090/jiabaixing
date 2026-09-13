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
const SelfModificationEngine_1 = require("../SelfModificationEngine");
const types_1 = require("../types");
describe('SelfModificationEngine', () => {
    let tempDir;
    let engine;
    beforeEach(() => {
        tempDir = path.join(os.tmpdir(), `evolution-test-${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });
        engine = new SelfModificationEngine_1.SelfModificationEngine();
    });
    afterEach(() => {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        catch {
            /* ignore */
        }
    });
    test('create file', async () => {
        const testFile = path.join(tempDir, 'new-file.txt');
        const plan = {
            id: 'test-create',
            type: types_1.EvolutionType.CODE_OPTIMIZATION,
            priority: types_1.EvolutionPriority.MEDIUM,
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
        const plan = {
            id: 'test-modify',
            type: types_1.EvolutionType.CODE_FIX,
            priority: types_1.EvolutionPriority.HIGH,
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
