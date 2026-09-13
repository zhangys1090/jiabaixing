"use strict";
/**
 * WebSocket 消息处理器索引
 * 统一导出所有处理器
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleUnknownMessage = exports.sendError = exports.sendConnectedMessage = exports.handleDisconnect = exports.handleConnection = exports.handleExecutionConfirm = exports.handleClarificationResponse = exports.handleAutomationTriggerExecute = exports.handleAutomationTaskCreate = exports.handleAutomationTaskToggle = exports.handleGetStatus = exports.handleCancelTask = exports.extractUserId = exports.handleUserInput = void 0;
var userInput_1 = require("./userInput");
Object.defineProperty(exports, "handleUserInput", { enumerable: true, get: function () { return userInput_1.handleUserInput; } });
Object.defineProperty(exports, "extractUserId", { enumerable: true, get: function () { return userInput_1.extractUserId; } });
var cancelTask_1 = require("./cancelTask");
Object.defineProperty(exports, "handleCancelTask", { enumerable: true, get: function () { return cancelTask_1.handleCancelTask; } });
var status_1 = require("./status");
Object.defineProperty(exports, "handleGetStatus", { enumerable: true, get: function () { return status_1.handleGetStatus; } });
var automation_1 = require("./automation");
Object.defineProperty(exports, "handleAutomationTaskToggle", { enumerable: true, get: function () { return automation_1.handleAutomationTaskToggle; } });
Object.defineProperty(exports, "handleAutomationTaskCreate", { enumerable: true, get: function () { return automation_1.handleAutomationTaskCreate; } });
Object.defineProperty(exports, "handleAutomationTriggerExecute", { enumerable: true, get: function () { return automation_1.handleAutomationTriggerExecute; } });
var events_1 = require("./events");
Object.defineProperty(exports, "handleClarificationResponse", { enumerable: true, get: function () { return events_1.handleClarificationResponse; } });
Object.defineProperty(exports, "handleExecutionConfirm", { enumerable: true, get: function () { return events_1.handleExecutionConfirm; } });
Object.defineProperty(exports, "handleConnection", { enumerable: true, get: function () { return events_1.handleConnection; } });
Object.defineProperty(exports, "handleDisconnect", { enumerable: true, get: function () { return events_1.handleDisconnect; } });
Object.defineProperty(exports, "sendConnectedMessage", { enumerable: true, get: function () { return events_1.sendConnectedMessage; } });
Object.defineProperty(exports, "sendError", { enumerable: true, get: function () { return events_1.sendError; } });
Object.defineProperty(exports, "handleUnknownMessage", { enumerable: true, get: function () { return events_1.handleUnknownMessage; } });
