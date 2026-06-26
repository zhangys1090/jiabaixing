import * as readline from 'readline';

/**
 * CLI 模块共享类型
 */

/** REPL 状态 */
export class ReplState {
  history: string[] = [];
  historyIndex: number = -1;
  inputBuffer: string = '';
  startTime: number = Date.now();
  aborted: boolean = false;

  pushHistory(line: string): void {
    if (line && line !== this.history[this.history.length - 1]) {
      this.history.push(line);
      if (this.history.length > 500) this.history.shift();
    }
    this.historyIndex = this.history.length;
  }

  getUptime(): string {
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }
}

/** readline 内部接口扩展 */
export type ReadlineInternal = readline.Interface & {
  input: NodeJS.ReadStream;
  line: string;
  cursor: number;
};

/** 按键事件结果 */
export interface KeypressResult {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

/** 子命令选项 */
export interface SubcommandOptions {
  json: boolean;
  quiet: boolean;
}
