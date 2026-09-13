"use strict";
/**
 * 多环境终端后端系统
 *
 * 统一入口: BackendFactory → ITerminalBackend → BackendResult
 *
 * 支持后端:
 *   - local:  宿主机直接执行（无隔离）
 *   - docker: Docker 容器隔离执行
 *   - ssh:    SSH 远程执行（网络边界隔离）
 *
 * 配置方式:
 *   环境变量: JBX_TERMINAL_BACKEND=docker|ssh|local
 *   代码:     BackendFactory.getBackend(config)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SSHBackend = exports.LocalBackend = exports.DockerBackend = exports.BackendFactory = void 0;
var BackendFactory_1 = require("./BackendFactory");
Object.defineProperty(exports, "BackendFactory", { enumerable: true, get: function () { return BackendFactory_1.BackendFactory; } });
var DockerBackend_1 = require("./DockerBackend");
Object.defineProperty(exports, "DockerBackend", { enumerable: true, get: function () { return DockerBackend_1.DockerBackend; } });
var LocalBackend_1 = require("./LocalBackend");
Object.defineProperty(exports, "LocalBackend", { enumerable: true, get: function () { return LocalBackend_1.LocalBackend; } });
var SSHBackend_1 = require("./SSHBackend");
Object.defineProperty(exports, "SSHBackend", { enumerable: true, get: function () { return SSHBackend_1.SSHBackend; } });
