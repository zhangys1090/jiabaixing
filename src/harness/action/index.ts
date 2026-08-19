/**
 * Action 统一抽象模块统一导出
 *
 * 编排层只需：
 *   import { getActionDispatcher } from '../harness/action';
 *   const result = await getActionDispatcher().dispatch({ channel: 'desktop', desktopAction, verify });
 */

export * from './types';
export * from './verify/VerificationBridge';
export * from './channels/ToolChannel';
export * from './channels/DesktopChannel';
export * from './channels/McpChannel';
export * from './ActionDispatcher';
