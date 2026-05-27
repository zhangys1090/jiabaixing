/**
 * Desktop Automation Module - 桌面自动化模块
 * P0 实现：眼睛 + 手 + 闭环
 */

export {
  ScreenCapture,
  ScreenshotOptions,
  ScreenshotResult,
} from './ScreenCapture';
export { WindowManager, WindowInfo, WindowActionResult } from './WindowManager';
export { SystemInput, MousePosition, InputResult } from './SystemInput';
export {
  DesktopVisionEngine,
  DesktopObservation,
  DesktopVisionConfig,
} from './DesktopVisionEngine';
export {
  DesktopActionExecutor,
  DesktopAction,
  DesktopActionResult,
  DesktopTaskResult,
} from './DesktopActionExecutor';
export {
  DesktopAgentLoop,
  DesktopAgentConfig,
  DesktopAgentResult,
} from './DesktopAgentLoop';
export {
  DesktopUIInspector,
  UIElement,
  UIElementNode,
  ElementQueryResult,
  UIInspectorConfig,
  UIAControlType,
} from './DesktopUIInspector';
export {
  ElementMatcher,
  VisualElement,
  MatchResult,
  MatcherConfig,
} from './ElementMatcher';
export {
  StateSnapshotManager,
  SnapshotTriggerType,
  SnapshotStatus,
  DesktopStateSnapshot,
  SnapshotMetadata,
  StateDiffResult,
  CustomStateProvider,
  StateSnapshotManagerConfig,
  SnapshotRestoreResult,
  SnapshotListOptions,
} from './StateSnapshotManager';
