import { MemoryAuthority } from '../../authority/MemoryAuthority';
import type { MemoryWriteRequest, MemoryReadRequest, MemoryWriteResult, MemoryReadResult } from '../../authority/MemoryAuthority';

describe('D6: Memory Authority Audit', () => {
  let ma: MemoryAuthority;

  beforeEach(() => {
    MemoryAuthority.resetInstance();
    ma = MemoryAuthority.getInstance();
  });

  afterAll(() => {
    MemoryAuthority.resetInstance();
  });

  describe('Audit 1: Canonical owner for every memory domain', () => {
    it('all 8 domains have canonical owners', () => {
      const owners = ma.getAllCanonicalOwners();
      expect(owners.length).toBe(8);
      const domains = owners.map((o: any) => o.domain);
      expect(domains).toContain('short_term');
      expect(domains).toContain('long_term');
      expect(domains).toContain('episodic');
      expect(domains).toContain('cross_session');
      expect(domains).toContain('visual');
      expect(domains).toContain('tool_selection');
      expect(domains).toContain('feedback');
      expect(domains).toContain('persistent_hermes');
    });

    it('Python owns 7 domains, ts_bridge owns 1', () => {
      const owners = ma.getAllCanonicalOwners();
      const pythonCount = owners.filter((o: any) => o.process === 'python').length;
      const tsBridgeCount = owners.filter((o: any) => o.process === 'ts_bridge').length;
      expect(pythonCount).toBe(7);
      expect(tsBridgeCount).toBe(1);
    });

    it('each domain has exactly one canonical owner', () => {
      const owners = ma.getAllCanonicalOwners();
      const domains = owners.map((o: any) => o.domain);
      const unique = new Set(domains);
      expect(unique.size).toBe(domains.length);
    });

    it('TS MemoryEngine is NOT canonical for any Python domain', () => {
      const pythonDomains = ['short_term', 'long_term', 'episodic', 'cross_session', 'visual', 'tool_selection', 'feedback'] as const;
      for (const d of pythonDomains) {
        const owner = ma.getCanonicalOwner(d);
        expect(owner).toBeDefined();
        expect(owner!.process).toBe('python');
      }
    });
  });

  describe('Audit 2: Rogue stores identified and fully isolated', () => {
    it('3 rogue stores identified', () => {
      const rogues = ma.getRogueStores();
      expect(rogues.length).toBe(3);
    });

    it('EpisodicMemoryStore: rogue, bridge_to_python', () => {
      const rogues = ma.getRogueStores();
      const r = rogues.find((x: any) => x.className === 'EpisodicMemoryStore');
      expect(r).toBeDefined();
      expect(r!.domain).toBe('episodic');
      expect(r!.recommendation).toBe('bridge_to_python');
    });

    it('PersistentMemoryService: rogue, bridge_to_python', () => {
      const rogues = ma.getRogueStores();
      const r = rogues.find((x: any) => x.className === 'PersistentMemoryService');
      expect(r).toBeDefined();
      expect(r!.recommendation).toBe('bridge_to_python');
    });

    it('MemoryRetriever: rogue, deprecate', () => {
      const rogues = ma.getRogueStores();
      const r = rogues.find((x: any) => x.className === 'MemoryRetriever');
      expect(r).toBeDefined();
      expect(r!.recommendation).toBe('deprecate');
    });

    it('no production code imports any rogue store', () => {
      const fs = require('fs');
      const path = require('path');
      const srcDir = path.join(__dirname, '../../');
      const tsFiles = findTsFiles(srcDir);
      let violations = 0;
      for (const file of tsFiles) {
        const c = fs.readFileSync(file, 'utf-8');
        if (c.includes("from './EpisodicMemoryStore'") || c.includes("from '../memory/EpisodicMemoryStore'")) {
          if (!file.includes('EpisodicMemoryStore.ts')) violations++;
        }
        if (c.includes("from './PersistentMemoryService'") || c.includes("from '../memory/PersistentMemoryService'")) {
          if (!file.includes('PersistentMemoryService.ts')) violations++;
        }
        if (c.includes("from './MemoryRetriever'") || c.includes("from '../memory/MemoryRetriever'")) {
          if (!file.includes('MemoryRetriever.ts')) violations++;
        }
      }
      expect(violations).toBe(0);
    });
  });

  describe('Audit 3: Fail-closed — no silent fallback to rogue stores', () => {
    it('write to Python domain without bridge → failed_closed, NOT ts_local', async () => {
      const result = await ma.write({ content: 'test', memoryType: 'episodic' });
      expect(result.success).toBe(false);
      expect(result.source).toBe('failed_closed');
    });

    it('read from Python domain without bridge → failed_closed, NOT ts_local', async () => {
      const result = await ma.read({ query: 'test', memoryType: 'episodic' });
      expect(result.items).toEqual([]);
      expect(result.source).toBe('failed_closed');
    });

    it('all 7 Python domains fail-closed without bridge', async () => {
      const domains = ['short_term', 'long_term', 'episodic', 'cross_session', 'visual', 'tool_selection', 'feedback'] as const;
      for (const d of domains) {
        const r = await ma.write({ content: 'test', memoryType: d });
        expect(r.source).toBe('failed_closed');
        expect(r.success).toBe(false);
      }
    });

    it('ts_bridge domain does NOT fail-closed', async () => {
      const r = await ma.write({ content: 'test', memoryType: 'persistent_hermes' });
      expect(r.source).toBe('ts_bridge');
      expect(r.success).toBe(true);
    });
  });

  describe('Audit 4: Bridge registered → Python canonical owner respected', () => {
    it('write goes to Python when bridge available', async () => {
      const mockWrite = jest.fn().mockResolvedValue({ success: true, memoryId: 'm1', operationId: 'o1', source: 'python' });
      const mockRead = jest.fn().mockResolvedValue({ items: [], operationId: 'o2', source: 'python' });
      ma.registerBridge(
        mockWrite as any,
        mockRead as any
      );

      const r = await ma.write({ content: 'test', memoryType: 'episodic', goalId: 'G1', decisionId: 'D1' });
      expect(r.success).toBe(true);
      expect(r.source).toBe('python');
      expect(mockWrite).toHaveBeenCalledTimes(1);
    });

    it('read goes to Python when bridge available', async () => {
      const mockWrite = jest.fn().mockResolvedValue({ success: true, memoryId: 'm1', operationId: 'o1', source: 'python' });
      const mockRead = jest.fn().mockResolvedValue({
        items: [{ id: 'm1', content: 'data', memoryType: 'episodic', relevanceScore: 0.9, timestamp: Date.now() }],
        operationId: 'o2',
        source: 'python',
      });
      ma.registerBridge(mockWrite as any, mockRead as any);

      const r = await ma.read({ query: 'test', memoryType: 'episodic' });
      expect(r.source).toBe('python');
      expect(r.items.length).toBe(1);
    });
  });

  describe('Audit 5: Every operation traceable to goalId/snapshotId/decisionId', () => {
    it('write with full authority trace is recorded', async () => {
      const mockWrite = jest.fn().mockResolvedValue({ success: true, memoryId: 'm1', operationId: 'o1', source: 'python' });
      ma.registerBridge(mockWrite as any, jest.fn().mockResolvedValue({ items: [], operationId: 'o2', source: 'python' }) as any);

      await ma.write({
        content: 'traceable',
        memoryType: 'short_term',
        goalId: 'G_trace',
        decisionId: 'D_trace',
        snapshotId: 'S_trace',
      });

      const log = ma.getOperationLog({ goalId: 'G_trace' });
      expect(log.length).toBeGreaterThan(0);
      const op = log[0];
      expect(op.goalId).toBe('G_trace');
      expect(op.decisionId).toBe('D_trace');
      expect(op.snapshotId).toBe('S_trace');
      expect(op.operation).toBe('store');
      expect(op.source).toBe('python');
      expect(op.operationId).toBeTruthy();
      expect(op.timestamp).toBeGreaterThan(0);
    });

    it('stats distinguish with-authority vs without-authority operations', async () => {
      const mockWrite = jest.fn().mockResolvedValue({ success: true, memoryId: 'm1', operationId: 'o1', source: 'python' });
      ma.registerBridge(mockWrite as any, jest.fn().mockResolvedValue({ items: [], operationId: 'o2', source: 'python' }) as any);

      await ma.write({ content: 'with', memoryType: 'short_term', goalId: 'G_s', decisionId: 'D_s' });
      await ma.write({ content: 'without', memoryType: 'short_term' });

      const stats = ma.getOperationStats();
      expect(stats.withAuthorityTrace).toBeGreaterThanOrEqual(1);
      expect(stats.withoutAuthorityTrace).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Audit 6: experience → memory write → retrieval → state → decision flow', () => {
    it('write then read produces consistent data', async () => {
      const stored: any[] = [];
      const mockWrite = jest.fn().mockImplementation(async (req: any) => {
        stored.push({ id: 'mem_stored', content: req.content, memoryType: req.memoryType });
        return { success: true, memoryId: 'mem_stored', operationId: 'o1', source: 'python' };
      });
      const mockRead = jest.fn().mockImplementation(async (req: any) => ({
        items: stored.map((s, i) => ({ ...s, relevanceScore: 0.9, timestamp: Date.now() })),
        operationId: 'o2',
        source: 'python',
      }));
      ma.registerBridge(mockWrite as any, mockRead as any);

      const writeResult = await ma.write({
        content: 'important experience',
        memoryType: 'episodic',
        goalId: 'G_flow',
        decisionId: 'D_flow',
      });
      expect(writeResult.success).toBe(true);

      const readResult = await ma.read({
        query: 'experience',
        memoryType: 'episodic',
        goalId: 'G_flow',
      });
      expect(readResult.items.length).toBeGreaterThan(0);
      expect(readResult.items[0].content).toBe('important experience');
    });
  });
});

function findTsFiles(dir: string): string[] {
  const fs = require('fs');
  const path = require('path');
  const results: string[] = [];
  const skip = ['node_modules', 'release', '__tests__', '.git'];
  function walk(d: string) {
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (skip.includes(e.name)) continue;
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) results.push(f);
      }
    } catch {}
  }
  walk(dir);
  return results;
}
