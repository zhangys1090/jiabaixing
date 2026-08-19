/**
 * A2A 协议 TS 端类型定义（薄壳层）。
 *
 * 以 Python `agent/a2a/types.py` 为唯一事实来源，TS 侧类型与之逐一对应
 * （camelCase 字段映射 Python 的 snake_case，见 types.py 的 to_dict/from_dict）。
 *
 * 为避免双端类型定义漂移，本文件直接复用 `AgentRegistry.ts` 中已存在的
 * 权威 TS 类型（types.py 注释明确指向 AgentRegistry.ts 第 851–959 行）。
 * 若未来需要拆分，可在此处定义规范类型并让 AgentRegistry 反向 re-export。
 */

export type {
  A2AAgentCard,
  A2ACapability,
  A2ATask,
  A2ATaskStatus,
  A2ATaskEvent,
} from '../harness/orchestration/AgentRegistry';

/** A2A 传输协议（与 Python A2ATransport 对应）。 */
export type A2ATransport = 'json-rpc' | 'grpc' | 'http';

/** A2A 鉴权方案（与 Python A2AAuthType 对应）。 */
export type A2AAuthType = 'none' | 'api-key' | 'oauth2' | 'bearer' | 'jwt';

/** 创建 Task 的请求负载（camelCase，对应 server.py CreateTaskRequest）。 */
export interface CreateTaskPayload {
  fromAgentId: string;
  toAgentId: string;
  description: string;
  input: Record<string, unknown>;
  sessionId?: string;
}

/** 更新 Task 状态的请求负载（对应 server.py UpdateStatusRequest）。 */
export interface UpdateTaskStatusPayload {
  status: A2ATaskStatus;
  message?: string;
  output?: Record<string, unknown>;
  error?: string;
}

/** 推送通知的请求负载（对应 server.py PushNotificationRequest）。 */
export interface PushNotificationPayload {
  taskId: string;
  eventType?: 'status-change' | 'artifact-update' | 'progress';
  message?: string;
  data?: Record<string, unknown>;
}
