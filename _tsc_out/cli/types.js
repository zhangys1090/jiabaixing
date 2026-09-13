"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReplState = void 0;
/**
 * CLI 模块共享类型
 */
/** REPL 状态 */
class ReplState {
    history = [];
    historyIndex = -1;
    inputBuffer = '';
    startTime = Date.now();
    aborted = false;
    pushHistory(line) {
        if (line && line !== this.history[this.history.length - 1]) {
            this.history.push(line);
            if (this.history.length > 500)
                this.history.shift();
        }
        this.historyIndex = this.history.length;
    }
    getUptime() {
        const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
        const m = Math.floor(elapsed / 60);
        const s = elapsed % 60;
        return m > 0 ? `${m}m ${s}s` : `${s}s`;
    }
}
exports.ReplState = ReplState;
