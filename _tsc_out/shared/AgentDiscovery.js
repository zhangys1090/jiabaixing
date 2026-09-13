"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentDiscovery = void 0;
class AgentDiscovery {
    agentRegistry = new Map();
    agentSubscriptions = new Map();
    agentMailboxes = new Map();
    MAX_MAILBOX_SIZE = 100;
    MESSAGE_TTL = 5 * 60 * 1000;
    registerAgent(profile) {
        this.agentRegistry.set(profile.id, profile);
        for (const capability of profile.capabilities) {
            const topic = this.capabilityToTopic(capability);
            if (!this.agentSubscriptions.has(topic)) {
                this.agentSubscriptions.set(topic, new Set());
            }
            this.agentSubscriptions.get(topic).add(profile.id);
        }
        if (!this.agentMailboxes.has(profile.id)) {
            this.agentMailboxes.set(profile.id, []);
        }
    }
    unregisterAgent(agentId) {
        this.agentRegistry.delete(agentId);
        this.agentMailboxes.delete(agentId);
        for (const subscribers of this.agentSubscriptions.values()) {
            subscribers.delete(agentId);
        }
    }
    broadcastAgentMessage(message) {
        const fullMessage = {
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
    getAgentMessages(agentId) {
        const mailbox = this.agentMailboxes.get(agentId) || [];
        const now = Date.now();
        const validMessages = mailbox.filter((msg) => {
            if (msg.ttl && now - msg.timestamp > msg.ttl)
                return false;
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
    getAgentProfile(agentId) {
        return this.agentRegistry.get(agentId);
    }
    getAllAgents() {
        return Array.from(this.agentRegistry.values());
    }
    getAgentsByCapability(capability) {
        const topic = this.capabilityToTopic(capability);
        const subscribers = this.agentSubscriptions.get(topic) || new Set();
        return Array.from(subscribers)
            .map((id) => this.agentRegistry.get(id))
            .filter((a) => a !== undefined);
    }
    agentHeartbeat(agentId) {
        const profile = this.agentRegistry.get(agentId);
        if (profile) {
            profile.lastHeartbeat = Date.now();
        }
    }
    getActiveAgents() {
        const now = Date.now();
        const heartbeatTimeout = 30_000;
        return this.getAllAgents().filter((a) => a.status !== 'offline' && now - a.lastHeartbeat < heartbeatTimeout);
    }
    clear() {
        this.agentRegistry.clear();
        this.agentSubscriptions.clear();
        this.agentMailboxes.clear();
    }
    capabilityToTopic(capability) {
        return `capability.${capability.toLowerCase().replace(/\s+/g, '_')}`;
    }
    deliverMessage(agentId, message) {
        let mailbox = this.agentMailboxes.get(agentId) || [];
        if (mailbox.length >= this.MAX_MAILBOX_SIZE) {
            mailbox = mailbox.slice(-this.MAX_MAILBOX_SIZE + 1);
        }
        mailbox.push(message);
        this.agentMailboxes.set(agentId, mailbox);
    }
}
exports.AgentDiscovery = AgentDiscovery;
