/**
 * Action 统一抽象 —— 类型契约
 *
 * P1-2 目标：将 harness 工具 / 桌面 / MCP 三通道归并为单一调度接口。
 * 编排层只需构造一个 ActionRequest 并指定 channel，即可经 ActionDispatcher
 * 调度任一类动作，结果统一归一为 ActionResult（含可选 verification 回写闭环）。
 *
 * 设计遵循 AGENTS.md §0.1：校验核心（ActionVerifier）归属 Python，TS 仅做
 * 桥接与归一化；VerificationOutcome 是 Python VerificationResult 的归一化投影。
 */

import type { DesktopAction } from '../../desktop/DesktopActionExecutor';
import type { ToolContext } from '../types';

/** 三类动作通道 */
export type ActionChannelKind = 'tool' | 'desktop' | 'mcp';

/** 可选的操作验证请求（接回 Python ActionVerifier） */
export interface VerifyRequest {
  /** 操作描述，供验证器理解意图 */
  description: string;
  /** 操作前截图路径（与 postPath 共同构成对比验证） */
  prePath?: string;
  /** 操作后截图路径 */
  postPath?: string;
  /** 验证策略（默认 auto） */
  strategy?: 'auto' | 'pixel' | 'ocr' | 'vlm' | 'uia_diff';
  /** 关注区域 (x1,y1,x2,y2) */
  targetRegion?: string;
  /** 像素差异阈值 */
  threshold?: number;
  /** VLM 验证问题 */
  question?: string;
}

/** Python ActionVerifier.VerificationResult 的归一化投影 */
export interface VerificationOutcome {
  success: boolean;
  confidence: number;
  evidence: string;
  retrySuggested: boolean;
  method: string;
  diffRatio: number;
}

/** 统一动作请求 */
export interface ActionRequest {
  channel: ActionChannelKind;
  /** tool / mcp 通道：工具名（mcp 通道兼容 mcp_{server}_{tool} 与 {server}/{tool}） */
  tool?: string;
  /** tool / mcp 通道：工具参数 */
  params?: Record<string, unknown>;
  /** tool 通道：工具执行上下文 */
  context?: ToolContext;
  /** desktop 通道：单条桌面动作 */
  desktopAction?: DesktopAction;
  /** 任意通道：执行后接回验证器（desktop 通道最常用） */
  verify?: VerifyRequest;
}

/** 统一动作结果（三通道输出归一） */
export interface ActionResult {
  channel: ActionChannelKind;
  success: boolean;
  output: unknown;
  error?: string;
  durationMs: number;
  /** 通道原生结果（保留完整信息，便于调试） */
  raw?: unknown;
  /** 接回验证器的产出（request.verify 存在且通道支持时填充） */
  verification?: VerificationOutcome;
  metadata?: Record<string, unknown>;
}

/** 动作通道接口：所有通道实现统一的 dispatch 契约 */
export interface ActionChannel {
  readonly kind: ActionChannelKind;
  dispatch(request: ActionRequest): Promise<ActionResult>;
}
