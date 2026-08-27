/**
 * 废弃组件运行时警告工具
 *
 * 为所有 @deprecated 组件添加运行时警告，确保开发者在实际使用时能感知废弃状态。
 * V6.0 时将移除废弃组件本身。
 *
 * 使用方式:
 *   import { emitDeprecationWarning } from '../shared/deprecationWarning';
 *   emitDeprecationWarning('MemoryEngine', 'PythonAgentBridge (AGENT_BACKEND=python)', 'V6.0');
 */

import { Logger } from '../utils/Logger';

const emittedWarnings = new Set<string>();

export interface DeprecationWarningOptions {
  component: string;
  replacement: string;
  removeVersion: string;
  additionalGuidance?: string;
}

export function emitDeprecationWarning(
  component: string,
  replacement: string,
  removeVersion: string,
  additionalGuidance?: string
): void {
  const key = `${component}@${removeVersion}`;
  if (emittedWarnings.has(key)) return;
  emittedWarnings.add(key);

  const message = [
    `[DEPRECATED] ${component} is deprecated.`,
    `  → Use ${replacement} instead.`,
    `  → Will be removed in ${removeVersion}.`,
    additionalGuidance ? `  → ${additionalGuidance}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  if (process.env.NODE_ENV === 'production') return;

  Logger.debug(message, 'Deprecation');
}

export function emitDeprecationWarningOnce(
  options: DeprecationWarningOptions
): void {
  emitDeprecationWarning(
    options.component,
    options.replacement,
    options.removeVersion,
    options.additionalGuidance
  );
}

export function getEmittedWarnings(): ReadonlySet<string> {
  return emittedWarnings;
}

export function clearEmittedWarnings(): void {
  emittedWarnings.clear();
}
