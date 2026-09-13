import {
  ConversationHistoryManager,
  BridgeHistorySource,
  ConversationEntry,
} from '../../../src/core/ConversationHistoryManager';

class MockBridgeSource implements BridgeHistorySource {
  private messages: ConversationEntry[] = [];

  setMessages(msgs: ConversationEntry[]): void {
    this.messages = msgs;
  }

  async getRecentMessages(_sessionId: string, count: number): Promise<ConversationEntry[]> {
    return this.messages.slice(-count);
  }

  async getAllMessages(_sessionId: string): Promise<ConversationEntry[]> {
    return [...this.messages];
  }
}

class FailingBridgeSource implements BridgeHistorySource {
  async getRecentMessages(): Promise<ConversationEntry[]> {
    throw new Error('Bridge connection refused');
  }

  async getAllMessages(): Promise<ConversationEntry[]> {
    throw new Error('Bridge connection refused');
  }
}

describe('P7-C: Conversation history dual-write sync', () => {
  let manager: ConversationHistoryManager;

  beforeEach(() => {
    manager = new ConversationHistoryManager('test-user');
  });

  test('by default, bridge sync is disabled', () => {
    expect(manager.isBridgeSyncEnabled()).toBe(false);
  });

  test('enableBridgeSync activates bridge mode', () => {
    const bridge = new MockBridgeSource();
    manager.enableBridgeSync(bridge);
    expect(manager.isBridgeSyncEnabled()).toBe(true);
  });

  test('disableBridgeSync deactivates bridge mode', () => {
    const bridge = new MockBridgeSource();
    manager.enableBridgeSync(bridge);
    expect(manager.isBridgeSyncEnabled()).toBe(true);
    manager.disableBridgeSync();
    expect(manager.isBridgeSyncEnabled()).toBe(false);
  });

  test('without bridge sync, local writes are tracked', () => {
    expect(manager.getUnsyncedLocalWrites()).toBe(0);
    manager.addUserMessage('hello');
    manager.addAssistantMessage('hi there');
    expect(manager.getUnsyncedLocalWrites()).toBe(2);
  });

  test('with bridge sync, local saves are skipped (no unsynced writes)', () => {
    const bridge = new MockBridgeSource();
    manager.enableBridgeSync(bridge);
    manager.addUserMessage('hello');
    manager.addAssistantMessage('hi there');
    expect(manager.getUnsyncedLocalWrites()).toBe(0);
  });

  test('getRecentFromBridge: bridge available → returns bridge data', async () => {
    const bridge = new MockBridgeSource();
    const bridgeMessages: ConversationEntry[] = [
      { role: 'user', content: 'from-python', timestamp: new Date() },
      { role: 'assistant', content: 'python-reply', timestamp: new Date() },
    ];
    bridge.setMessages(bridgeMessages);
    manager.enableBridgeSync(bridge);

    const recent = await manager.getRecentFromBridge(5);
    expect(recent.length).toBe(2);
    expect(recent[0].content).toBe('from-python');
    expect(recent[1].content).toBe('python-reply');
  });

  test('getRecentFromBridge: bridge fails → falls back to local', async () => {
    const bridge = new FailingBridgeSource();
    manager.enableBridgeSync(bridge);
    manager.addUserMessage('local-only');

    const recent = await manager.getRecentFromBridge(5);
    expect(recent.length).toBe(1);
    expect(recent[0].content).toBe('local-only');
  });

  test('getRecentFromBridge: bridge sync disabled → returns local', async () => {
    manager.addUserMessage('local-msg');
    const recent = await manager.getRecentFromBridge(5);
    expect(recent.length).toBe(1);
    expect(recent[0].content).toBe('local-msg');
  });

  test('getAllFromBridge: bridge available → returns all bridge data', async () => {
    const bridge = new MockBridgeSource();
    const bridgeMessages: ConversationEntry[] = [
      { role: 'user', content: 'msg1', timestamp: new Date() },
      { role: 'assistant', content: 'msg2', timestamp: new Date() },
      { role: 'user', content: 'msg3', timestamp: new Date() },
    ];
    bridge.setMessages(bridgeMessages);
    manager.enableBridgeSync(bridge);

    const all = await manager.getAllFromBridge();
    expect(all.length).toBe(3);
  });

  test('dual-write scenario: Python writes, TS does not duplicate', () => {
    const bridge = new MockBridgeSource();
    manager.enableBridgeSync(bridge);

    manager.addUserMessage('user input');
    manager.addAssistantMessage('assistant response');

    expect(manager.getUnsyncedLocalWrites()).toBe(0);
    expect(manager.getLength()).toBe(2);
  });
});
