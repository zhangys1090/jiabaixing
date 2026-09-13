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
const EvolutionRollback_1 = require("../EvolutionRollback");
describe('EvolutionRollback', () => {
    let tempDir;
    let rollback;
    beforeEach(() => {
        tempDir = path.join(os.tmpdir(), `evolution-test-${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });
        rollback = new EvolutionRollback_1.EvolutionRollback(path.join(tempDir, 'checkpoints'));
    });
    afterEach(() => {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        catch {
            /* ignore */
        }
    });
    test('create checkpoint and rollback', async () => {
        const testFile = path.join(tempDir, 'test.txt');
        fs.writeFileSync(testFile, 'Original content', 'utf-8');
        const actions = [
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
