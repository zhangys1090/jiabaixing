import { Request, Response, Router } from 'express';
import { ScenarioAwareScheduler } from '../../core/ScenarioAwareScheduler';
import { Logger } from '../../utils/Logger';

const router = Router();

let schedulerInstance: ScenarioAwareScheduler | null = null;

export function setSchedulerInstance(scheduler: ScenarioAwareScheduler): void {
  schedulerInstance = scheduler;
}

router.get('/tasks', async (req: Request, res: Response) => {
  try {
    if (!schedulerInstance) {
      res.status(503).json({ success: false, error: '调度器未初始化' });
      return;
    }
    const tasks = Array.from(schedulerInstance.getTasks().values());
    res.json({ success: true, data: tasks });
  } catch (error) {
    Logger.error('获取任务列表失败', error as Error, 'AutomationAPI');
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.post('/tasks', async (req: Request, res: Response) => {
  try {
    if (!schedulerInstance) {
      res.status(503).json({ success: false, error: '调度器未初始化' });
      return;
    }
    const task = req.body;
    const taskId = schedulerInstance.addTask({
      id: `task_${Date.now()}`,
      name: task.name || '未命名任务',
      description: task.description || '',
      schedule: task.schedule || '0 9 * * *',
      priority: task.priority || 5,
      enabled: true,
      executionCount: 0,
      successCount: 0,
      averageExecutionTime: 0,
    });
    res.json({ success: true, data: { taskId } });
  } catch (error) {
    Logger.error('创建任务失败', error as Error, 'AutomationAPI');
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.patch('/tasks/:taskId/toggle', async (req: Request, res: Response) => {
  try {
    if (!schedulerInstance) {
      res.status(503).json({ success: false, error: '调度器未初始化' });
      return;
    }
    const { taskId } = req.params;
    const { enabled } = req.body;
    schedulerInstance.toggleTask(taskId, enabled);
    res.json({ success: true });
  } catch (error) {
    Logger.error('切换任务状态失败', error as Error, 'AutomationAPI');
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.post('/tasks/:taskId/execute', async (req: Request, res: Response) => {
  try {
    if (!schedulerInstance) {
      res.status(503).json({ success: false, error: '调度器未初始化' });
      return;
    }
    const { taskId } = req.params;
    await schedulerInstance.executeTaskById(taskId);
    res.json({ success: true });
  } catch (error) {
    Logger.error('执行任务失败', error as Error, 'AutomationAPI');
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.get('/triggers', async (req: Request, res: Response) => {
  try {
    if (!schedulerInstance) {
      res.status(503).json({ success: false, error: '调度器未初始化' });
      return;
    }
    const triggers = schedulerInstance.getProactiveTriggers();
    res.json({ success: true, data: triggers });
  } catch (error) {
    Logger.error('获取触发队列失败', error as Error, 'AutomationAPI');
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.get('/patterns', async (req: Request, res: Response) => {
  try {
    if (!schedulerInstance) {
      res.status(503).json({ success: false, error: '调度器未初始化' });
      return;
    }
    const patterns = schedulerInstance.getUserBehaviorPattern();
    res.json({ success: true, data: patterns });
  } catch (error) {
    Logger.error('获取行为模式失败', error as Error, 'AutomationAPI');
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

export default router;
