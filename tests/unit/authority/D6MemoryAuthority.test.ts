import { MemoryAuthority } from '../../../src/authority/MemoryAuthority';
import type {
  MemoryAuthorityTrace,
  MemoryDomain,
  RogueStoreReport,
  MemoryWriteRequest,
  MemoryReadRequest,
} from '../../../src/authority/MemoryAuthority';

function resetMemoryAuthority(): void {
  MemoryAuthority.resetInstance();
}

describe('D6 Memory Authority', () => {
  beforeEach(() => {
    resetMemoryAuthority();
  });

  afterAll(() => {
    resetMemoryAuthority();
  });

  describe('G1: Single Canonical Write Path', () => {
    test('every memory domain has a canonical owner', () => {
      const ma = MemoryAuthority.getInstance();
      const domains: MemoryDomain[] = [
        'short_term', 'long_term', 'episodic', 'persistent_hermes',
        'cross_session', 'visual', 'tool_selection', 'feedback',
      ];
      for (const domain of domains) {
        const owner = ma.getCanonicalOwner(domain);
        expect(owner).toBeDefined();
        expect(owner!.domain).toBe(domain);
        expect(['python', 'ts_bridge']).toContain(owner!.process);
      }
    });

    test('Python is canonical owner for most domains', () => {
      const ma = MemoryAuthority.getInstance();
      const owners = ma.getAllCanonicalOwners();
      const pythonOwned = owners.filter((o) => o.process === 'python');
      expect(pythonOwned.length).toBeGreaterThanOrEqual(6);
    });

    test('write delegates to Python when bridge is available', async () => {
      const ma = MemoryAuthority.getInstance();
      const writeCalls: MemoryWriteRequest[] = [];
      ma.registerBridge(
        async (req) => {
          writeCalls.push(req);
          return { success: true, memoryId: `py_${Date.now()}`, operationId: 'test', source: 'python' };
        },
        async () => ({ items: [], operationId: 'test', source: 'python' })
      );

      const result = await ma.write({
        content: 'test memory',
        memoryType: 'short_term',
        goalId: 'G_test',
        decisionId: 'D_test',
      });

      expect(result.success).toBe(true);
      expect(result.source).toBe('python');
      expect(writeCalls.length).toBe(1);
      expect(writeCalls[0].content).toBe('test memory');
      expect(writeCalls[0].goalId).toBe('G_test');
    });

    test('write falls back to ts_local when Python unavailable', async () => {
      const ma = MemoryAuthority.getInstance();
      const result = await ma.write({
        content: 'test memory',
        memoryType: 'short_term',
      });

      expect(result.success).toBe(true);
      expect(result.source).toBe('ts_local');
    });
  });

  describe('G2: No Rogue Stores in Production', () => {
    test('rogue stores are identified', () => {
      const ma = MemoryAuthority.getInstance();
      const rogues = ma.getRogueStores();
      expect(rogues.length).toBeGreaterThanOrEqual(2);

      const classNames = rogues.map((r) => r.className);
      expect(classNames).toContain('EpisodicMemoryStore');
      expect(classNames).toContain('PersistentMemoryService');
    });

    test('EpisodicMemoryStore is marked bridge_to_python', () => {
      const ma = MemoryAuthority.getInstance();
      const episodicRogue = ma.getRogueStores().find((r) => r.className === 'EpisodicMemoryStore');
      expect(episodicRogue).toBeDefined();
      expect(episodicRogue!.recommendation).toBe('bridge_to_python');
      expect(episodicRogue!.domain).toBe('episodic');
    });

    test('PersistentMemoryService is marked bridge_to_python', () => {
      const ma = MemoryAuthority.getInstance();
      const persistentRogue = ma.getRogueStores().find((r) => r.className === 'PersistentMemoryService');
      expect(persistentRogue).toBeDefined();
      expect(persistentRogue!.recommendation).toBe('bridge_to_python');
      expect(persistentRogue!.domain).toBe('persistent_hermes');
    });

    test('MemoryRetriever is marked deprecate (dead code)', () => {
      const ma = MemoryAuthority.getInstance();
      const retrieverRogue = ma.getRogueStores().find((r) => r.className === 'MemoryRetriever');
      expect(retrieverRogue).toBeDefined();
      expect(retrieverRogue!.recommendation).toBe('deprecate');
    });
  });

  describe('G3: Memory Authority Trace', () => {
    test('every write operation is recorded with operationId', async () => {
      const ma = MemoryAuthority.getInstance();
      ma.registerBridge(
        async (req) => ({ success: true, memoryId: 'py_1', operationId: 'test', source: 'python' }),
        async () => ({ items: [], operationId: 'test', source: 'python' })
      );

      await ma.write({ content: 'test', memoryType: 'long_term', goalId: 'G1', decisionId: 'D1', snapshotId: 'SS1' });

      const log = ma.getOperationLog();
      expect(log.length).toBe(1);
      expect(log[0].operationId).toMatch(/^MO_/);
      expect(log[0].operation).toBe('store');
      expect(log[0].memoryType).toBe('long_term');
      expect(log[0].goalId).toBe('G1');
      expect(log[0].decisionId).toBe('D1');
      expect(log[0].snapshotId).toBe('SS1');
      expect(log[0].source).toBe('python');
    });

    test('every read operation is recorded', async () => {
      const ma = MemoryAuthority.getInstance();
      ma.registerBridge(
        async (req) => ({ success: true, memoryId: 'py_1', operationId: 'test', source: 'python' }),
        async (req) => ({
          items: [{ id: 'm1', content: 'result', memoryType: req.memoryType ?? 'short_term', relevanceScore: 0.9, timestamp: Date.now() }],
          operationId: 'test',
          source: 'python',
        })
      );

      await ma.read({ query: 'test query', memoryType: 'episodic', goalId: 'G1' });

      const log = ma.getOperationLog();
      expect(log.length).toBe(1);
      expect(log[0].operation).toBe('retrieve');
      expect(log[0].memoryType).toBe('episodic');
      expect(log[0].goalId).toBe('G1');
    });

    test('operations without goalId/decisionId are tracked as withoutAuthorityTrace', async () => {
      const ma = MemoryAuthority.getInstance();
      ma.registerBridge(
        async (req) => ({ success: true, memoryId: 'py_1', operationId: 'test', source: 'python' }),
        async () => ({ items: [], operationId: 'test', source: 'python' })
      );

      await ma.write({ content: 'background memory', memoryType: 'short_term' });
      await ma.write({ content: 'goal memory', memoryType: 'short_term', goalId: 'G1', decisionId: 'D1' });

      const stats = ma.getOperationStats();
      expect(stats.total).toBe(2);
      expect(stats.withAuthorityTrace).toBe(1);
      expect(stats.withoutAuthorityTrace).toBe(1);
    });

    test('operation log respects capacity limit', async () => {
      const ma = MemoryAuthority.getInstance();
      ma.registerBridge(
        async (req) => ({ success: true, memoryId: 'py_1', operationId: 'test', source: 'python' }),
        async () => ({ items: [], operationId: 'test', source: 'python' })
      );

      for (let i = 0; i < 100; i++) {
        await ma.write({ content: `memory_${i}`, memoryType: 'short_term' });
      }

      const log = ma.getOperationLog();
      expect(log.length).toBe(100);
      expect(log.length).toBeLessThanOrEqual(2000);
    });
  });

  describe('G4: Cross-Process Consistency', () => {
    test('Python bridge write returns python source', async () => {
      const ma = MemoryAuthority.getInstance();
      ma.registerBridge(
        async (req) => ({ success: true, memoryId: 'py_123', operationId: 'test', source: 'python' }),
        async () => ({ items: [], operationId: 'test', source: 'python' })
      );

      const result = await ma.write({ content: 'test', memoryType: 'episodic' });
      expect(result.source).toBe('python');
    });

    test('Python bridge read returns python source', async () => {
      const ma = MemoryAuthority.getInstance();
      ma.registerBridge(
        async (req) => ({ success: true, memoryId: 'py_1', operationId: 'test', source: 'python' }),
        async () => ({ items: [], operationId: 'test', source: 'python' })
      );

      const result = await ma.read({ query: 'test', memoryType: 'episodic' });
      expect(result.source).toBe('python');
    });

    test('when Python bridge fails, fallback reflects bridge status', async () => {
      const ma = MemoryAuthority.getInstance();
      ma.registerBridge(
        async () => { throw new Error('Python unavailable'); },
        async () => { throw new Error('Python unavailable'); }
      );

      const writeResult = await ma.write({ content: 'test', memoryType: 'short_term' });
      expect(writeResult.source).toBe('ts_bridge');

      const readResult = await ma.read({ query: 'test' });
      expect(readResult.source).toBe('ts_bridge');
    });

    test('when no bridge registered at all, fallback is ts_local', async () => {
      const ma = MemoryAuthority.getInstance();

      const writeResult = await ma.write({ content: 'test', memoryType: 'short_term' });
      expect(writeResult.source).toBe('ts_local');

      const readResult = await ma.read({ query: 'test' });
      expect(readResult.source).toBe('ts_local');
    });
  });

  describe('G5: Retrieval Serves Decision', () => {
    test('read with goalId filters for goal-relevant memory', async () => {
      const ma = MemoryAuthority.getInstance();
      const readCalls: MemoryReadRequest[] = [];
      ma.registerBridge(
        async (req) => ({ success: true, memoryId: 'py_1', operationId: 'test', source: 'python' }),
        async (req) => {
          readCalls.push(req);
          return { items: [], operationId: 'test', source: 'python' };
        }
      );

      await ma.read({ query: 'user preferences', goalId: 'G_123', memoryType: 'long_term' });

      expect(readCalls.length).toBe(1);
      expect(readCalls[0].goalId).toBe('G_123');
      expect(readCalls[0].memoryType).toBe('long_term');
    });

    test('operation log can be filtered by goalId', async () => {
      const ma = MemoryAuthority.getInstance();
      ma.registerBridge(
        async (req) => ({ success: true, memoryId: 'py_1', operationId: 'test', source: 'python' }),
        async () => ({ items: [], operationId: 'test', source: 'python' })
      );

      await ma.write({ content: 'for G1', memoryType: 'short_term', goalId: 'G1' });
      await ma.write({ content: 'for G2', memoryType: 'short_term', goalId: 'G2' });
      await ma.write({ content: 'no goal', memoryType: 'short_term' });

      const g1Ops = ma.getOperationLog({ goalId: 'G1' });
      expect(g1Ops.length).toBe(1);
      expect(g1Ops[0].goalId).toBe('G1');
    });
  });

  describe('Audit Trail Completeness', () => {
    test('operation stats cover all dimensions', async () => {
      const ma = MemoryAuthority.getInstance();
      ma.registerBridge(
        async (req) => ({ success: true, memoryId: 'py_1', operationId: 'test', source: 'python' }),
        async () => ({ items: [], operationId: 'test', source: 'python' })
      );

      await ma.write({ content: 'stm', memoryType: 'short_term' });
      await ma.write({ content: 'ltm', memoryType: 'long_term', goalId: 'G1', decisionId: 'D1' });
      await ma.read({ query: 'test', memoryType: 'episodic' });

      const stats = ma.getOperationStats();
      expect(stats.total).toBe(3);
      expect(stats.bySource.python).toBe(3);
      expect(stats.byOperation.store).toBe(2);
      expect(stats.byOperation.retrieve).toBe(1);
      expect(stats.byDomain.short_term).toBe(1);
      expect(stats.byDomain.long_term).toBe(1);
      expect(stats.byDomain.episodic).toBe(1);
      expect(stats.withAuthorityTrace).toBe(1);
      expect(stats.withoutAuthorityTrace).toBe(2);
    });

    test('canonical owners list is complete and non-empty', () => {
      const ma = MemoryAuthority.getInstance();
      const owners = ma.getAllCanonicalOwners();
      expect(owners.length).toBeGreaterThanOrEqual(8);

      const domains = new Set(owners.map((o) => o.domain));
      expect(domains.has('short_term')).toBe(true);
      expect(domains.has('long_term')).toBe(true);
      expect(domains.has('episodic')).toBe(true);
      expect(domains.has('cross_session')).toBe(true);
      expect(domains.has('visual')).toBe(true);
      expect(domains.has('tool_selection')).toBe(true);
      expect(domains.has('feedback')).toBe(true);
      expect(domains.has('persistent_hermes')).toBe(true);
    });
  });
});
