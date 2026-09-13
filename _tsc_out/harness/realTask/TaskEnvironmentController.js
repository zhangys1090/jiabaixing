"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTaskEnvironmentController = getTaskEnvironmentController;
exports.resetTaskEnvironmentController = resetTaskEnvironmentController;
const fs = __importStar(require("fs"));
const Logger_1 = require("../../utils/Logger");
class TaskEnvironmentControllerImpl {
    async setup(task, env) {
        if (task.setup) {
            await task.setup(env);
            Logger_1.Logger.info(`[D8-2.1] TaskEnvironmentController.setup: ${task.taskId} at ${env.tempDir}`, 'TaskEnvironmentController');
        }
    }
    async injectDisturbance(task, env) {
        if (!task.disturbance) {
            Logger_1.Logger.info(`[D8-2.1] No disturbance defined for ${task.taskId}`, 'TaskEnvironmentController');
            return false;
        }
        Logger_1.Logger.info(`[D8-2.1] Injecting disturbance for ${task.taskId}: ${task.disturbance.description}`, 'TaskEnvironmentController');
        try {
            await task.disturbance.execute(env);
            const verifyResult = await task.disturbance.verify(env);
            Logger_1.Logger.info(`[D8-2.1] Disturbance injected: disturbed=${verifyResult.disturbed} evidence="${verifyResult.evidence}"`, 'TaskEnvironmentController');
            return verifyResult.disturbed;
        }
        catch (err) {
            Logger_1.Logger.error(`[D8-2.1] Disturbance injection failed: ${err.message}`, err, 'TaskEnvironmentController');
            return false;
        }
    }
    async verifyDisturbance(task, env) {
        if (!task.disturbance) {
            return { disturbed: false, evidence: 'no disturbance defined' };
        }
        return task.disturbance.verify(env);
    }
    async snapshot(env) {
        const timestamp = Date.now();
        const files = [];
        const directories = [];
        try {
            if (fs.existsSync(env.tempDir)) {
                const entries = fs.readdirSync(env.tempDir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isFile())
                        files.push(entry.name);
                    if (entry.isDirectory())
                        directories.push(entry.name);
                }
            }
        }
        catch { }
        return {
            timestamp,
            files,
            directories,
            metadata: { tempDir: env.tempDir, platform: env.platform },
        };
    }
    async cleanup(task, env) {
        if (task.teardown) {
            try {
                await task.teardown(env);
                Logger_1.Logger.info(`[D8-2.1] TaskEnvironmentController.cleanup: ${task.taskId}`, 'TaskEnvironmentController');
            }
            catch (err) {
                Logger_1.Logger.error(`[D8-2.1] Cleanup failed for ${task.taskId}: ${err.message}`, err, 'TaskEnvironmentController');
            }
        }
    }
}
let instance = null;
function getTaskEnvironmentController() {
    if (!instance) {
        instance = new TaskEnvironmentControllerImpl();
    }
    return instance;
}
function resetTaskEnvironmentController() {
    instance = null;
}
