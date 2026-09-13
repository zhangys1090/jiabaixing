"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RequestQueue = void 0;
class RequestQueue {
    _queue = [];
    _running = 0;
    _maxConcurrent;
    constructor(config) {
        this._maxConcurrent =
            typeof config === 'number' ? config : (config?.maxConcurrent ?? 5);
    }
    async enqueue(fn) {
        return fn();
    }
    get pending() {
        return this._queue.length;
    }
    get running() {
        return this._running;
    }
    get maxConcurrent() {
        return this._maxConcurrent;
    }
}
exports.RequestQueue = RequestQueue;
