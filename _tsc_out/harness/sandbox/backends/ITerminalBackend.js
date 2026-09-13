"use strict";
/**
 * 多环境终端后端统一接口
 *
 * 设计参考: Hermes Agent tools/environments/ 多后端架构
 * 支持后端: local | docker | ssh (后续可扩展 modal | daytona | singularity)
 *
 * 数据流: BackendFactory.create(config) → ITerminalBackend.execute() → BackendResult
 */
Object.defineProperty(exports, "__esModule", { value: true });
