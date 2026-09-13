"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const GatewayBridge_1 = require("../../integration/GatewayBridge");
const IntegrationManager_1 = require("../../integration/IntegrationManager");
const Logger_1 = require("../../utils/Logger");
const router = express_1.default.Router();
function getGateway() {
    const bridge = GatewayBridge_1.GatewayBridge.getInstance();
    if (bridge.isWorkerAlive()) {
        return bridge;
    }
    return IntegrationManager_1.IntegrationManager.getInstance();
}
function isBridge(gateway) {
    return gateway instanceof GatewayBridge_1.GatewayBridge;
}
router.get('/wechat/qrcode', async (_req, res) => {
    try {
        const gateway = getGateway();
        const qrState = isBridge(gateway)
            ? await gateway.getWeChatQRState()
            : gateway.getWeChatQRState();
        if (!qrState) {
            res.json({
                success: false,
                error: '未开启微信扫码模式，请先连接 (mode: qr)',
            });
            return;
        }
        res.json({
            success: true,
            data: qrState,
        });
    }
    catch (error) {
        Logger_1.Logger.error('获取微信二维码失败', error, 'IntegrationRoutes');
        res.status(500).json({
            success: false,
            error: '获取微信二维码失败',
        });
    }
});
router.get('/platforms', async (_req, res) => {
    try {
        // 状态查询直接走 IntegrationManager，不走 GatewayBridge（sendSyncRequest 会阻塞事件循环）
        const im = IntegrationManager_1.IntegrationManager.getInstance();
        const platforms = im.getPlatforms();
        const response = {
            success: true,
            data: { platforms },
        };
        res.json(response);
    }
    catch (error) {
        Logger_1.Logger.error('获取集成平台失败', error, 'IntegrationRoutes');
        res.status(500).json({
            success: false,
            error: '获取集成平台信息失败',
            message: error.message,
        });
    }
});
router.get('/:platform/status', async (req, res) => {
    try {
        const platform = req.params.platform;
        // 状态查询直接走 IntegrationManager
        const im = IntegrationManager_1.IntegrationManager.getInstance();
        const status = im.getPlatformStatus(platform);
        res.json({
            success: true,
            data: status,
        });
    }
    catch (error) {
        Logger_1.Logger.error('获取平台状态失败', error, 'IntegrationRoutes');
        res.status(500).json({
            success: false,
            error: '获取平台状态失败',
        });
    }
});
router.post('/:platform/connect', async (req, res) => {
    try {
        const platform = req.params.platform;
        const requestBody = req.body;
        // 连接操作走 GatewayBridge (async sendRequest 正常工作)
        const gateway = getGateway();
        const result = isBridge(gateway)
            ? await gateway.connectPlatform(platform, requestBody.config)
            : await gateway.connectPlatform(platform, requestBody.config);
        // result 在 GatewayBridge 模式下是 IPC data 对象，在 IntegrationManager 模式下是 boolean
        const connected = result === true ||
            (typeof result === 'object' &&
                result !== null &&
                result.status === 'connected');
        const response = {
            success: connected,
            data: {
                success: connected,
                platform,
                status: connected ? 'connected' : 'failed',
            },
        };
        if (!connected) {
            response.error = '连接失败';
        }
        res.status(connected ? 200 : 400).json(response);
    }
    catch (error) {
        Logger_1.Logger.error('连接平台失败', error, 'IntegrationRoutes');
        res.status(500).json({
            success: false,
            error: '连接平台失败',
            message: error.message,
        });
    }
});
router.post('/:platform/disconnect', async (req, res) => {
    try {
        const platform = req.params.platform;
        const gateway = getGateway();
        if (isBridge(gateway)) {
            await gateway.disconnectPlatform(platform);
        }
        else {
            await gateway.disconnectPlatform(platform);
        }
        const response = {
            success: true,
            data: {
                success: true,
                platform,
            },
        };
        res.json(response);
    }
    catch (error) {
        Logger_1.Logger.error('断开连接失败', error, 'IntegrationRoutes');
        res.status(500).json({
            success: false,
            error: '断开连接失败',
        });
    }
});
router.post('/:platform/webhook', express_1.default.json({ limit: '1mb' }), async (req, res) => {
    try {
        const platform = req.params.platform;
        const validPlatforms = [
            'wechat',
            'dingtalk',
            'feishu',
            'slack',
            'telegram',
        ];
        if (!validPlatforms.includes(platform)) {
            return res
                .status(400)
                .json({ success: false, error: `不支持的平台: ${platform}` });
        }
        if (!req.body || typeof req.body !== 'object') {
            return res
                .status(400)
                .json({ success: false, error: '无效的webhook数据' });
        }
        const im = IntegrationManager_1.IntegrationManager.getInstance();
        const result = await im.handleWebhook(platform, req.body);
        if (result.success) {
            res.status(200).json(result.response || { success: true });
        }
        else {
            res.status(400).json({ success: false });
        }
    }
    catch (error) {
        Logger_1.Logger.error('处理 Webhook 失败', error, 'IntegrationRoutes');
        res.status(500).json({ success: false });
    }
});
router.post('/:platform/send', async (req, res) => {
    try {
        const platform = req.params.platform;
        const requestBody = {
            ...req.body,
            platform,
        };
        const gateway = getGateway();
        const response = isBridge(gateway)
            ? await gateway.sendMessage(requestBody)
            : await gateway.sendMessage(requestBody);
        const apiResponse = {
            success: response.success,
            data: response,
        };
        if (!response.success) {
            apiResponse.error = response.error;
        }
        res.status(response.success ? 200 : 400).json(apiResponse);
    }
    catch (error) {
        Logger_1.Logger.error('发送消息失败', error, 'IntegrationRoutes');
        res.status(500).json({
            success: false,
            error: '发送消息失败',
            message: error.message,
        });
    }
});
router.get('/system-status', async (_req, res) => {
    try {
        const bridge = GatewayBridge_1.GatewayBridge.getInstance();
        const systemStatus = {
            timestamp: Date.now(),
            architecture: 'v5.0-harness-isolated-gateway',
            gateway: {
                mode: bridge.isWorkerAlive() ? 'isolated_worker' : 'inline_fallback',
                workerAlive: bridge.isWorkerAlive(),
            },
            layers: {
                preprocessor: 'active',
                llmCore: 'active',
                postprocessor: 'active',
            },
            overall: {
                status: 'operational',
            },
        };
        res.json({
            success: true,
            data: systemStatus,
        });
    }
    catch (error) {
        Logger_1.Logger.error('获取系统状态失败', error, 'IntegrationRoutes');
        res.status(500).json({
            success: false,
            error: '获取系统状态失败',
            details: error.message,
        });
    }
});
// ====================== Webhook 管理 API ======================
/**
 * 注册 Webhook 端点
 */
router.post('/webhooks', async (req, res) => {
    try {
        const endpoint = req.body;
        if (!endpoint.id ||
            !endpoint.name ||
            !endpoint.url ||
            !Array.isArray(endpoint.events)) {
            res.status(400).json({
                success: false,
                error: '缺少必填字段: id, name, url, events',
            });
            return;
        }
        const manager = IntegrationManager_1.IntegrationManager.getInstance();
        manager.registerWebhook({
            ...endpoint,
            enabled: endpoint.enabled ?? true,
            retryCount: endpoint.retryCount ?? 3,
            timeout: endpoint.timeout ?? 5000,
        });
        Logger_1.Logger.info(`Webhook 已注册: ${endpoint.id} (${endpoint.name})`, 'IntegrationRoutes');
        res.status(201).json({
            success: true,
            data: { id: endpoint.id },
        });
    }
    catch (error) {
        Logger_1.Logger.error('注册 Webhook 失败', error, 'IntegrationRoutes');
        res.status(500).json({
            success: false,
            error: '注册 Webhook 失败',
            message: error.message,
        });
    }
});
/**
 * 注销 Webhook 端点
 */
router.delete('/webhooks/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const manager = IntegrationManager_1.IntegrationManager.getInstance();
        manager.unregisterWebhook(id);
        Logger_1.Logger.info(`Webhook 已注销: ${id}`, 'IntegrationRoutes');
        res.json({
            success: true,
            data: { id },
        });
    }
    catch (error) {
        Logger_1.Logger.error('注销 Webhook 失败', error, 'IntegrationRoutes');
        res.status(500).json({
            success: false,
            error: '注销 Webhook 失败',
            message: error.message,
        });
    }
});
/**
 * 列出所有 Webhook 端点
 */
router.get('/webhooks', async (_req, res) => {
    try {
        const manager = IntegrationManager_1.IntegrationManager.getInstance();
        const webhooks = manager.listWebhooks();
        res.json({
            success: true,
            data: { webhooks },
        });
    }
    catch (error) {
        Logger_1.Logger.error('获取 Webhook 列表失败', error, 'IntegrationRoutes');
        res.status(500).json({
            success: false,
            error: '获取 Webhook 列表失败',
            message: error.message,
        });
    }
});
/**
 * 测试 Webhook 连通性
 */
router.post('/webhooks/:id/test', async (req, res) => {
    try {
        const { id } = req.params;
        const manager = IntegrationManager_1.IntegrationManager.getInstance();
        const endpoint = manager.getWebhook(id);
        if (!endpoint) {
            res.status(404).json({
                success: false,
                error: `Webhook 端点不存在: ${id}`,
            });
            return;
        }
        const testPayload = {
            message: 'jiabaixing Webhook 连通性测试',
            timestamp: new Date().toISOString(),
        };
        const success = await manager.deliverWebhook(endpoint, 'webhook_test', testPayload);
        res.json({
            success,
            data: {
                id,
                delivered: success,
                message: success ? 'Webhook 连通性测试成功' : 'Webhook 连通性测试失败',
            },
        });
    }
    catch (error) {
        Logger_1.Logger.error('测试 Webhook 失败', error, 'IntegrationRoutes');
        res.status(500).json({
            success: false,
            error: '测试 Webhook 失败',
            message: error.message,
        });
    }
});
exports.default = router;
