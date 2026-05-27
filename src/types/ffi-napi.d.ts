/**
 * ffi-napi 类型声明
 */

declare module 'ffi-napi' {
  export function Library(
    libraryPath: string,
    functions: Record<string, unknown>
  ): Record<string, unknown>;
  export function Callback(
    retType: string,
    argTypes: string[],
    fn: (...args: unknown[]) => unknown
  ): unknown;
}
