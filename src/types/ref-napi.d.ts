/**
 * ref-napi 类型声明
 */

declare module 'ref-napi' {
  export const types: Record<string, unknown>;
  export function alloc(type: unknown, value?: unknown): unknown;
  export function deref(buffer: unknown): unknown;
}
