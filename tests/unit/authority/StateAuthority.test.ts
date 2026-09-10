import type { StateReadProviders } from '../../../src/authority';
import {
  GoalAuthority,
  StateAuthority
} from '../../../src/authority';

describe('StateAuthority v2 (Canonical Decision Snapshot Provider)', () => {
  let goalAuthority: GoalAuthority;
  let stateAuthority: StateAuthority;

  beforeEach(() => {
    GoalAuthority.resetInstance();
    StateAuthority.resetInstance();
    goalAuthority = GoalAuthority.getInstance();
    stateAuthority = StateAuthority.getInstance();
  });

  describe('captureSnapshot without providers', () => {
    it('returns minimal snapshot when no providers registered', async () => {
      const goal = goalAuthority.createGoal({
        description: 'test',
        originalInput: 'test',
      });

      const snapshot = await stateAuthority.captureSnapshot([goal.goalId]);

      expect(snapshot.snapshotId).toMatch(/^SS_[a-z0-9]+_[a-z0-9]{4}$/);
      expect(snapshot.activeGoalIds).toEqual([goal.goalId]);
      expect(snapshot.timestamp).toBeGreaterThan(0);
      expect(snapshot.self.agentId).toBe('unknown');
      expect(snapshot.self.safetyStatus).toBe('degraded');
      expect(snapshot.world.observation).toBeNull();
      expect(snapshot.memory.relevantMemories).toEqual([]);
      expect(snapshot.context.conversationHistory).toEqual([]);
      expect(snapshot.capabilities.desktopAvailable).toBe(false);
    });
  });

  describe('captureSnapshot with providers', () => {
    it('aggregates state from read providers (does NOT own them)', async () => {
      const providers: StateReadProviders = {
        readWorldState: jest.fn().mockResolvedValue({
          observation: { windows: [] },
          platform: 'desktop',
          timestamp: Date.now(),
        }),
        readMemory: jest.fn().mockResolvedValue({
          relevantMemories: [{ id: 'm1', content: 'previous task' }],
          query: 'test',
          timestamp: Date.now(),
        }),
        readContext: jest.fn().mockResolvedValue({
          systemPrompt: 'You are JARVIS',
          conversationHistory: [{ role: 'user', content: 'hello' }],
          fileContexts: [],
          personaSummary: 'helpful assistant',
          timestamp: Date.now(),
        }),
        readCapabilities: jest.fn().mockResolvedValue({
          availableTools: ['desktop_automate', 'memory_search'],
          availableSkills: ['file_organizer'],
          desktopAvailable: true,
          bridgeAvailable: true,
        }),
        getAgentId: jest.fn().mockReturnValue('jiabaixing-agent-1'),
        getSafetyStatus: jest.fn().mockReturnValue('nominal'),
      };

      stateAuthority.registerProviders(providers);

      const goal = goalAuthority.createGoal({
        description: '整理下载文件',
        originalInput: '帮我整理桌面上的下载文件',
      });

      const snapshot = await stateAuthority.captureSnapshot([goal.goalId]);

      expect(snapshot.activeGoalIds).toEqual([goal.goalId]);
      expect(snapshot.self.agentId).toBe('jiabaixing-agent-1');
      expect(snapshot.self.safetyStatus).toBe('nominal');
      expect(snapshot.self.activeGoalIds).toContain(goal.goalId);
      expect(snapshot.world.platform).toBe('desktop');
      expect(snapshot.world.observation).toEqual({ windows: [] });
      expect(snapshot.memory.relevantMemories).toHaveLength(1);
      expect(snapshot.context.systemPrompt).toBe('You are JARVIS');
      expect(snapshot.context.personaSummary).toBe('helpful assistant');
      expect(snapshot.capabilities.availableTools).toContain('desktop_automate');
      expect(snapshot.capabilities.availableSkills).toContain('file_organizer');

      expect(providers.readWorldState).toHaveBeenCalledTimes(1);
      expect(providers.readMemory).toHaveBeenCalledWith('整理下载文件');
      expect(providers.readContext).toHaveBeenCalledWith([goal.goalId]);
      expect(providers.readCapabilities).toHaveBeenCalledTimes(1);
    });

    it('handles provider failures gracefully', async () => {
      const providers: StateReadProviders = {
        readWorldState: jest.fn().mockRejectedValue(new Error('vision failed')),
        readMemory: jest.fn().mockRejectedValue(new Error('memory down')),
        readContext: jest.fn().mockResolvedValue({
          systemPrompt: '',
          conversationHistory: [],
          fileContexts: [],
          personaSummary: '',
          timestamp: Date.now(),
        }),
        readCapabilities: jest.fn().mockRejectedValue(new Error('tools unavailable')),
        getAgentId: jest.fn().mockReturnValue('agent-1'),
        getSafetyStatus: jest.fn().mockReturnValue('degraded'),
      };

      stateAuthority.registerProviders(providers);

      const goal = goalAuthority.createGoal({
        description: 'test',
        originalInput: 'test',
      });

      const snapshot = await stateAuthority.captureSnapshot([goal.goalId]);

      expect(snapshot.world.observation).toBeNull();
      expect(snapshot.memory.relevantMemories).toEqual([]);
      expect(snapshot.capabilities.availableTools).toEqual([]);
      expect(snapshot.self.safetyStatus).toBe('degraded');
    });
  });

  describe('snapshot serves multiple active goals (review point 2)', () => {
    it('activeGoalIds contains all active goals', async () => {
      const g1 = goalAuthority.createGoal({ description: '整理文件', originalInput: '整理文件' });
      const g2 = goalAuthority.createGoal({ description: '保证安全', originalInput: '保证安全' });

      const snapshot = await stateAuthority.captureSnapshot([g1.goalId, g2.goalId]);

      expect(snapshot.activeGoalIds).toEqual([g1.goalId, g2.goalId]);
    });

    it('auto-discovers active goals when no ids specified', async () => {
      const g1 = goalAuthority.createGoal({ description: 'task1', originalInput: 'task1' });
      const g2 = goalAuthority.createGoal({ description: 'task2', originalInput: 'task2' });
      goalAuthority.markAbandoned(g2.goalId, 'done');

      const snapshot = await stateAuthority.captureSnapshot();

      expect(snapshot.activeGoalIds).toEqual([g1.goalId]);
    });
  });

  describe('getLatestSnapshot', () => {
    it('returns the most recent snapshot', async () => {
      const providers: StateReadProviders = {
        readWorldState: jest.fn().mockResolvedValue({
          observation: null, platform: 'server', timestamp: Date.now(),
        }),
        readMemory: jest.fn().mockResolvedValue({
          relevantMemories: [], query: '', timestamp: Date.now(),
        }),
        readContext: jest.fn().mockResolvedValue({
          systemPrompt: '', conversationHistory: [], fileContexts: [], personaSummary: '', timestamp: Date.now(),
        }),
        readCapabilities: jest.fn().mockResolvedValue({
          availableTools: [], availableSkills: [], desktopAvailable: false, bridgeAvailable: false,
        }),
        getAgentId: jest.fn().mockReturnValue('agent'),
        getSafetyStatus: jest.fn().mockReturnValue('nominal'),
      };

      stateAuthority.registerProviders(providers);

      const goal = goalAuthority.createGoal({ description: 'test', originalInput: 'test' });

      const s1 = await stateAuthority.captureSnapshot([goal.goalId]);
      const s2 = await stateAuthority.captureSnapshot([goal.goalId]);

      expect(stateAuthority.getLatestSnapshot()).toBe(s2);
      expect(s2.snapshotId).not.toBe(s1.snapshotId);
    });

    it('returns null before any snapshot', () => {
      expect(stateAuthority.getLatestSnapshot()).toBeNull();
    });
  });

  describe('StateAuthority does NOT own state (review point 1)', () => {
    it('only reads from providers, never writes', async () => {
      const readWorldState = jest.fn().mockResolvedValue({
        observation: { windows: [] }, platform: 'desktop', timestamp: Date.now(),
      });
      const readMemory = jest.fn().mockResolvedValue({
        relevantMemories: [], query: '', timestamp: Date.now(),
      });
      const readContext = jest.fn().mockResolvedValue({
        systemPrompt: '', conversationHistory: [], fileContexts: [], personaSummary: '', timestamp: Date.now(),
      });
      const readCapabilities = jest.fn().mockResolvedValue({
        availableTools: [], availableSkills: [], desktopAvailable: false, bridgeAvailable: false,
      });

      stateAuthority.registerProviders({
        readWorldState,
        readMemory,
        readContext,
        readCapabilities,
        getAgentId: () => 'agent',
        getSafetyStatus: () => 'nominal',
      });

      const goal = goalAuthority.createGoal({ description: 'test', originalInput: 'test' });
      await stateAuthority.captureSnapshot([goal.goalId]);

      expect(readWorldState).toHaveBeenCalledTimes(1);
      expect(readMemory).toHaveBeenCalledTimes(1);
      expect(readContext).toHaveBeenCalledTimes(1);
      expect(readCapabilities).toHaveBeenCalledTimes(1);
    });
  });
});
