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
    if (!task || typeof task !== 'object') {
      res.status(400).json({ success: false, error: '无效的任务数据' });
      return;
    }
    const taskName = typeof task.name === 'string' ? task.name.trim() : '';
    if (taskName.length === 0 || taskName.length > 200) {
      res
        .status(400)
        .json({ success: false, error: '任务名称长度须在1-200字之间' });
      return;
    }
    const schedule =
      typeof task.schedule === 'string' ? task.schedule : '0 9 * * *';
    const cronPattern = /^[\d*/,\-]+(\s+[\d*/,\-]+){4,5}$/;
    if (!cronPattern.test(schedule)) {
      res.status(400).json({ success: false, error: '无效的cron表达式' });
      return;
    }
    const priority =
      typeof task.priority === 'number'
        ? Math.min(Math.max(task.priority, 1), 10)
        : 5;
    const taskId = schedulerInstance.addTask({
      id: `task_${Date.now()}`,
      name: taskName,
      description:
        typeof task.description === 'string'
          ? task.description.substring(0, 1000)
          : '',
      schedule,
      priority,
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
