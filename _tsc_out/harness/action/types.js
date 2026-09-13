"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
