
export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  status: 'idle' | 'busy' | 'offline';
  lastHeartbeat: number;
  metadata?: Record<string, unknown>;
}

export interface AgentMessage {
  id: string;
  from: string;
  to?: string;
  topic: string;
  type: 'request' | 'response' | 'notification' | 'broadcast';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  payload: unknown;
  replyTo?: string;
  ttl?: number;
  timestamp: number;
}

export class AgentDiscovery {
  private agentRegistry: Map<string, AgentProfile> = new Map();
  private agentSubscriptions: Map<string, Set<string>> = new Map();
  private agentMailboxes: Map<string, AgentMessage[]> = new Map();

  private readonly MAX_MAILBOX_SIZE = 100;
  private readonly MESSAGE_TTL = 5 * 60 * 1000;

  registerAgent(profile: AgentProfile): void {
    this.agentRegistry.set(profile.id, profile);

    for (const capability of profile.capabilities) {
      const topic = this.capabilityToTopic(capability);
      if (!this.agentSubscriptions.has(topic)) {
        this.agentSubscriptions.set(topic, new Set());
      }
      this.agentSubscriptions.get(topic)!.add(profile.id);
    }

    if (!this.agentMailboxes.has(profile.id)) {
      this.agentMailboxes.set(profile.id, []);
    }
  }

  unregisterAgent(agentId: string): void {
    this.agentRegistry.delete(agentId);
    this.agentMailboxes.delete(agentId);

    for (const subscribers of this.agentSubscriptions.values()) {
      subscribers.delete(agentId);
    }
  }

  broadcastAgentMessage(message: Omit<AgentMessage, 'id' | 'timestamp'>): string {
    const fullMessage: AgentMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      timestamp: Date.now(),
      ...message,
    };

    const topic = message.topic;
    const subscribers = this.agentSubscriptions.get(topic);
    if (subscribers) {
      for (const agentId of subscribers) {
        if (agentId !== message.from) {
          this.deliverMessage(agentId, fullMessage);
        }
      }
    }

    if (message.to) {
      this.deliverMessage(message.to, fullMessage);
    }

    return fullMessage.id;
  }

  getAgentMessages(agentId: string): AgentMessage[] {
    const mailbox = this.agentMailboxes.get(agentId) || [];
    const now = Date.now();
    const validMessages = mailbox.filter(msg => {
      if (msg.ttl && now - msg.timestamp > msg.ttl) return false;
      return true;
    });

    if (validMessages.length !== mailbox.length) {
      this.agentMailboxes.set(agentId, validMessages);
    }

    return validMessages.sort((a, b) => {
      const priorityOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }

  getAgentProfile(agentId: string): AgentProfile | undefined {
    return this.agentRegistry.get(agentId);
  }

  getAllAgents(): AgentProfile[] {
    return Array.from(this.agentRegistry.values());
  }

  getAgentsByCapability(capability: string): AgentProfile[] {
    const topic = this.capabilityToTopic(capability);
    const subscribers = this.agentSubscriptions.get(topic) || new Set();
    return Array.from(subscribers)
      .map(id => this.agentRegistry.get(id))
      .filter((a): a is AgentProfile => a !== undefined);
  }

  agentHeartbeat(agentId: string): void {
    const profile = this.agentRegistry.get(agentId);
    if (profile) {
      profile.lastHeartbeat = Date.now();
    }
  }

  getActiveAgents(): AgentProfile[] {
    const now = Date.now();
    const heartbeatTimeout = 30_000;
    return this.getAllAgents().filter(
      a => a.status !== 'offline' && now - a.lastHeartbeat < heartbeatTimeout
    );
  }

  clear(): void {
    this.agentRegistry.clear();
    this.agentSubscriptions.clear();
    this.agentMailboxes.clear();
  }

  private capabilityToTopic(capability: string): string {
    return `capability.${capability.toLowerCase().replace(/\s+/g, '_')}`;
  }

  private deliverMessage(agentId: string, message: AgentMessage): void {
    let mailbox = this.agentMailboxes.get(agentId) || [];

    if (mailbox.length >= this.MAX_MAILBOX_SIZE) {
      mailbox = mailbox.slice(-this.MAX_MAILBOX_SIZE + 1);
    }

    mailbox.push(message);
    this.agentMailboxes.set(agentId, mailbox);
  }
}
