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
exports.initGateway = initGateway;
const EventBus_1 = require("../../shared/EventBus");
const Logger_1 = require("../../utils/Logger");
async function initGateway(core, _harness) {
    const { GatewayBridge } = await Promise.resolve().then(() => __importStar(require('../../integration/GatewayBridge')));
    const gatewayBridge = GatewayBridge.getInstance();
    gatewayBridge.setIncomingMessageHandler(async (message) => {
        Logger_1.Logger.info(`收到平台消息: ${message.platform}`, 'Bootstrap');
        try {
            const result = await core.processInput(message.content, message.from);
            if (result.response && message.from && message.platform) {
                await gatewayBridge.sendMessage({
                    platform: message.platform,
                    message: result.response,
                    to: message.from,
                });
            }
        }
        catch (error) {
            Logger_1.Logger.error(`处理平台消息失败: ${error.message}`, error, 'Bootstrap');
        }
    });
    try {
        await gatewayBridge.start();
        Logger_1.Logger.info('网关启动成功: 隔离进程模式', 'Bootstrap');
    }
    catch (err) {
        Logger_1.Logger.warn(`网关隔离进程启动失败: ${err.message}，回退到内联模式`, 'Bootstrap');
        const { IntegrationManager } = await Promise.resolve().then(() => __importStar(require('../../integration/IntegrationManager')));
        const integrationManager = IntegrationManager.getInstance();
        integrationManager.setCore(core);
        Logger_1.Logger.info('网关启动成功: 内联模式', 'Bootstrap');
    }
    EventBus_1.EventBus.on('integration_message', async (data) => {
        try {
            const payload = data;
            Logger_1.Logger.info(`收到平台消息: ${payload.platform}`, 'Bootstrap');
            const result = await core.processInput(payload.content, payload.from);
            if (result.response && payload.from && payload.platform) {
                if (gatewayBridge.isWorkerAlive()) {
                    await gatewayBridge.sendMessage({
                        platform: payload.platform,
                        message: result.response,
                        to: payload.from,
                    });
                }
                else {
                    const { IntegrationManager } = await Promise.resolve().then(() => __importStar(require('../../integration/IntegrationManager')));
                    const im = IntegrationManager.getInstance();
                    await im.sendMessage({
                        platform: payload.platform,
                        message: result.response,
                        to: payload.from,
                    });
                }
            }
        }
        catch (error) {
            Logger_1.Logger.error('处理集成消息失败', error, 'Bootstrap');
        }
    });
    return {};
}
