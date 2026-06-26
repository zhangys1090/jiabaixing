/**
 * WebSocket 消息处理器索引
 * 统一导出所有处理器
 */

export { handleUserInput, extractUserId } from './userInput';
export { handleCancelTask } from './cancelTask';
export { handleGetStatus } from './status';
export {
  handleAutomationTaskToggle,
  handleAutomationTaskCreate,
  handleAutomationTriggerExecute,
} from './automation';
export {
  handleClarificationResponse,
  handleExecutionConfirm,
  handleConnection,
  handleDisconnect,
  sendConnectedMessage,
  sendError,
  handleUnknownMessage,
} from './events';
