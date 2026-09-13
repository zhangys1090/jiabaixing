"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerSessionRoutes = registerSessionRoutes;
const express_1 = __importDefault(require("express"));
const bridgeRegistry_1 = require("../../ide/bridgeRegistry");
const Logger_1 = require("../../utils/Logger");
function registerSessionRoutes(app) {
    app.post('/api/sessions', express_1.default.json({ limit: '1mb' }), async (req, res) => {
        try {
            const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
            if (!bridge) {
                return res
                    .status(503)
                    .json({ success: false, error: 'Python 后端未连接' });
            }
            const result = await bridge.request('POST', '/v1/sessions', req.body);
            res.json({ success: true, data: result });
        }
        catch (error) {
            Logger_1.Logger.error('创建会话失败', error, 'SessionRoutes');
            res
                .status(500)
                .json({ success: false, error: error.message });
        }
    });
    app.get('/api/sessions/:id', async (req, res) => {
        try {
            const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
            if (!bridge) {
                return res
                    .status(503)
                    .json({ success: false, error: 'Python 后端未连接' });
            }
            const result = await bridge.request('GET', `/v1/sessions/${req.params.id}`);
            res.json({ success: true, data: result });
        }
        catch (error) {
            Logger_1.Logger.error('获取会话失败', error, 'SessionRoutes');
            res.status(500).json({ success: false, error: error.message });
        }
    });
    app.delete('/api/sessions/:id', async (req, res) => {
        try {
            const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
            if (!bridge) {
                return res
                    .status(503)
                    .json({ success: false, error: 'Python 后端未连接' });
            }
            const result = await bridge.request('DELETE', `/v1/sessions/${req.params.id}`);
            res.json({ success: true, data: result });
        }
        catch (error) {
            Logger_1.Logger.error('删除会话失败', error, 'SessionRoutes');
            res.status(500).json({ success: false, error: error.message });
        }
    });
    app.post('/api/sessions/:id/checkpoint', express_1.default.json(), async (req, res) => {
        try {
            const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
            if (!bridge) {
                return res
                    .status(503)
                    .json({ success: false, error: 'Python 后端未连接' });
            }
            const result = await bridge.request('POST', `/v1/sessions/${req.params.id}/checkpoint`, req.body);
            res.json({ success: true, data: result });
        }
        catch (error) {
            Logger_1.Logger.error('创建检查点失败', error, 'SessionRoutes');
            res.status(500).json({ success: false, error: error.message });
        }
    });
    app.post('/api/sessions/:id/resume', express_1.default.json(), async (req, res) => {
        try {
            const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
            if (!bridge) {
                return res
                    .status(503)
                    .json({ success: false, error: 'Python 后端未连接' });
            }
            const result = await bridge.request('POST', `/v1/sessions/${req.params.id}/resume`, req.body);
            res.json({ success: true, data: result });
        }
        catch (error) {
            Logger_1.Logger.error('恢复会话失败', error, 'SessionRoutes');
            res.status(500).json({ success: false, error: error.message });
        }
    });
}
