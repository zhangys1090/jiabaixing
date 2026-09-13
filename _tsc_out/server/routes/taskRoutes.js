"use strict";
/**
 * Harness 任务管理 REST API
 *
 * 跨会话任务的 CRUD 操作
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.setHarnessInstance = setHarnessInstance;
const express_1 = require("express");
const router = (0, express_1.Router)();
/** 获取 Harness 实例 */
let harnessInstance = null;
function setHarnessInstance(harness) {
    harnessInstance = harness;
}
/**
 * POST /api/tasks/create - 创建跨会话任务
 */
router.post('/create', async (req, res) => {
    try {
        if (!harnessInstance) {
            res.status(503).json({ error: 'Harness 未初始化' });
            return;
        }
        const persistence = harnessInstance.getPersistenceService();
        if (!persistence) {
            res.status(503).json({ error: '持久化服务未启用' });
            return;
        }
        const { description, userId } = req.body;
        if (!description) {
            res.status(400).json({ error: '缺少任务描述' });
            return;
        }
        const task = {
            taskId: `task-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
            userId: userId || 'default',
            description,
            status: 'pending',
            currentStepIndex: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        await persistence.saveTaskState(task);
        res.json({ success: true, task });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
/**
 * GET /api/tasks/list - 查询活跃任务
 */
router.get('/list', async (_req, res) => {
    try {
        if (!harnessInstance) {
            res.status(503).json({ error: 'Harness 未初始化' });
            return;
        }
        const persistence = harnessInstance.getPersistenceService();
        if (!persistence) {
            res.status(503).json({ error: '持久化服务未启用' });
            return;
        }
        const tasks = await persistence.listActiveTasks();
        res.json({ success: true, tasks });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
/**
 * POST /api/tasks/:id/cancel - 取消任务
 */
router.post('/:id/cancel', async (req, res) => {
    try {
        if (!harnessInstance) {
            res.status(503).json({ error: 'Harness 未初始化' });
            return;
        }
        const persistence = harnessInstance.getPersistenceService();
        if (!persistence) {
            res.status(503).json({ error: '持久化服务未启用' });
            return;
        }
        const taskId = req.params.id;
        const updated = await persistence.updateTaskStatus(taskId, 'failed', '用户取消');
        if (!updated) {
            res.status(404).json({ error: '任务不存在' });
            return;
        }
        res.json({ success: true, taskId });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
/**
 * POST /api/tasks/:id/pause - 暂停任务
 */
router.post('/:id/pause', async (req, res) => {
    try {
        if (!harnessInstance) {
            res.status(503).json({ error: 'Harness 未初始化' });
            return;
        }
        const persistence = harnessInstance.getPersistenceService();
        if (!persistence) {
            res.status(503).json({ error: '持久化服务未启用' });
            return;
        }
        const taskId = req.params.id;
        const updated = await persistence.updateTaskStatus(taskId, 'paused');
        if (!updated) {
            res.status(404).json({ error: '任务不存在' });
            return;
        }
        res.json({ success: true, taskId });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
/**
 * POST /api/tasks/:id/resume - 恢复任务
 */
router.post('/:id/resume', async (req, res) => {
    try {
        if (!harnessInstance) {
            res.status(503).json({ error: 'Harness 未初始化' });
            return;
        }
        const persistence = harnessInstance.getPersistenceService();
        if (!persistence) {
            res.status(503).json({ error: '持久化服务未启用' });
            return;
        }
        const taskId = req.params.id;
        const { resumeContext } = req.body;
        const updated = await persistence.updateTaskStatus(taskId, 'in_progress', resumeContext);
        if (!updated) {
            res.status(404).json({ error: '任务不存在' });
            return;
        }
        res.json({ success: true, taskId });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
/**
 * GET /api/harness/status - Harness 状态
 */
router.get('/harness/status', (_req, res) => {
    if (!harnessInstance) {
        res.json({ initialized: false, config: null });
        return;
    }
    res.json({
        initialized: true,
        config: harnessInstance.getConfig(),
    });
});
exports.default = router;
