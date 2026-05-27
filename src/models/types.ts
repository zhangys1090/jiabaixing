import { Model, ModelConfig } from '../core/ModelInterface';

export interface ModelCapabilityProfile {
  visionScore: number;
  codingScore: number;
  reasoningScore: number;
  speedScore: number;
  contextLength: number;
  features: string[];
}

export interface RegisteredModel {
  id: string;
  name: string;
  model: Model;
  config: ModelConfig;
  capabilities: ModelCapabilityProfile;
  health: ModelHealthStatus;
  priority: number;
  enabled: boolean;
}

export interface ModelHealthStatus {
  available: boolean;
  averageLatencyMs: number;
  successRate: number;
  lastCheckTime: number;
  consecutiveFailures: number;
  lastError?: string;
}

export enum RoutingStrategy {
  PRIORITY = 'priority',
  CAPABILITY = 'capability',
  LATENCY = 'latency',
  ROUND_ROBIN = 'round_robin',
  RANDOM = 'random',
}

export interface MultiModelConfig {
  defaultStrategy?: RoutingStrategy;
  healthCheckIntervalMs?: number;
  maxConsecutiveFailures?: number;
  requestTimeoutMs?: number;
  enableHealthCheck?: boolean;
}

export interface RoutingResult {
  modelId: string;
  modelName: string;
  reason: string;
  fallbackChain: string[];
}
