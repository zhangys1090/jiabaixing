"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const MemoryAuthority_1 = require("../../authority/MemoryAuthority");
describe('E2-V2: Memory Authority Runtime Canonicality', () => {
    let ma;
    beforeEach(() => {
        MemoryAuthority_1.MemoryAuthority.resetInstance();
        ma = MemoryAuthority_1.MemoryAuthority.getInstance();
    });
    afterAll(() => {
        MemoryAuthority_1.MemoryAuthority.resetInstance();
    });
    describe('M1: bridge registered → write → Python owner', () => {
        test('write with bridge registered goes to Python', async () => {
            const mockWrite = jest.fn().mockResolvedValue({ success: true, memoryId: 'mem_1', operationId: 'op_1', source: 'python' });
            const mockRead = jest.fn().mockResolvedValue({ items: [], operationId: 'op_2', source: 'python' });
            ma.registerBridge(mockWrite, mockRead);
            const result = await ma.write({
                content: 'test',
                memoryType: 'short_term',
                goalId: 'G_test',
                decisionId: 'D_test',
            });
            expect(result.success).toBe(true);
            expect(result.source).toBe('python');
            expect(mockWrite).toHaveBeenCalledTimes(1);
        });
    });
    describe('M2: bridge registered → read → Python owner', () => {
        test('read with bridge registered goes to Python', async () => {
            const mockWrite = jest.fn().mockResolvedValue({ success: true, memoryId: 'mem_1', operationId: 'op_1', source: 'python' });
            const mockRead = jest.fn().mockResolvedValue({ items: [{ id: '1', content: 'data', memoryType: 'short_term', relevanceScore: 0.9, timestamp: Date.now() }], operationId: 'op_2', source: 'python' });
            ma.registerBridge(mockWrite, mockRead);
            const result = await ma.read({ query: 'test', memoryType: 'short_term' });
            expect(result.source).toBe('python');
            expect(result.items.length).toBe(1);
            expect(mockRead).toHaveBeenCalledTimes(1);
        });
    });
    describe('M3: bridge NOT registered → write/read → failed_closed', () => {
        test('write without bridge returns failed_closed for Python domain', async () => {
            const result = await ma.write({
                content: 'test',
                memoryType: 'short_term',
            });
            expect(result.success).toBe(false);
            expect(result.source).toBe('failed_closed');
        });
        test('read without bridge returns failed_closed for Python domain', async () => {
            const result = await ma.read({ query: 'test', memoryType: 'short_term' });
            expect(result.source).toBe('failed_closed');
            expect(result.items.length).toBe(0);
        });
        test('write without bridge returns failed_closed for all Python domains', async () => {
            const pythonDomains = ['short_term', 'long_term', 'episodic', 'cross_session', 'visual', 'tool_selection', 'feedback'];
            for (const domain of pythonDomains) {
                const result = await ma.write({ content: 'test', memoryType: domain });
                expect(result.success).toBe(false);
                expect(result.source).toBe('failed_closed');
            }
        });
        test('read without bridge returns failed_closed for all Python domains', async () => {
            const pythonDomains = ['short_term', 'long_term', 'episodic', 'cross_session', 'visual', 'tool_selection', 'feedback'];
            for (const domain of pythonDomains) {
                const result = await ma.read({ query: 'test', memoryType: domain });
                expect(result.source).toBe('failed_closed');
            }
        });
    });
    describe('M4: persistent_hermes (ts_bridge) does NOT fail-closed when bridge absent', () => {
        test('write for ts_bridge domain routes to ts_bridge', async () => {
            const result = await ma.write({
                content: 'test',
                memoryType: 'persistent_hermes',
            });
            expect(result.source).toBe('ts_bridge');
            expect(result.success).toBe(true);
        });
    });
    describe('operation log tracks failed_closed operations', () => {
        test('failed_closed writes appear in operation log', async () => {
            await ma.write({ content: 'test', memoryType: 'short_term' });
            const log = ma.getOperationLog({ memoryType: 'short_term' });
            const failedOps = log.filter(op => op.source === 'failed_closed');
            expect(failedOps.length).toBeGreaterThan(0);
        });
        test('operation stats include failed_closed count', async () => {
            await ma.write({ content: 'test', memoryType: 'short_term' });
            await ma.read({ query: 'test', memoryType: 'long_term' });
            const stats = ma.getOperationStats();
            expect(stats.bySource['failed_closed']).toBeGreaterThanOrEqual(2);
        });
    });
});
