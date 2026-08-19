﻿declare module 'js-yaml' {
  export interface LoadOptions {
    schema?: unknown;
    json?: boolean;
    onWarning?(e: Error): void;
  }
  export function load(str: string, opts?: LoadOptions): unknown;
  export function safeLoad(str: string, opts?: LoadOptions): unknown;
  export function dump(obj: unknown, opts?: object): string;
  export function safeDump(obj: unknown, opts?: object): string;
}
