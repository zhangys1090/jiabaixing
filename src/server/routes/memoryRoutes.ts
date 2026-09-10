/**
 * 记忆系统路由 - memory store / search / profile / preferences
 */

import express from 'express';
import { UserProfile } from '../../memory/UserProfile';

import { JiabaixingCore } from '../../core/JiabaixingCore';
import { getActivePythonBridge } from '../../ide/bridgeRegistry';
import { Logger } from '../../utils/Logger';

export function registerMemoryRoutes(
  app: express.Application,
  core: JiabaixingCore | null
): void {
  app.post(
    '/api/memory/store',
    express.json({ limit: '1mb' }),
    async (req, res) => {
      try {
        const { content, userId, importance, scene } = req.body as {
          content?: string;
          userId?: string;
          importance?: string;
          tags?: string[];
          emotion?: unknown;
          scene?: unknown;
        };

        if (!content) {
          return res
            .status(400)
            .json({ success: false, error: '缺少content参数' });
        }

        if (!core) {
          return res
            .status(503)
            .json({ success: false, error: '核心系统未初始化' });
        }

        const memoryEngine = core.getMemoryEngine();
        if (!memoryEngine) {
          return res
            .status(503)
            .json({ success: false, error: '记忆引擎未初始化' });
        }

        if (memoryEngine.storeShortTermMemory) {
          await memoryEngine.storeShortTermMemory(
            content,
            (scene as string) || 'general',
            userId
          );
        }

        res.json({
          success: true,
          data: {
            id: Date.now().toString(),
            content,
            timestamp: new Date().toISOString(),
            importance: importance || 'medium',
          },
        });
      } catch (error) {
        Logger.error('❌ 记忆存储失败', error as Error, 'MemoryAPI');
        res
          .status(500)
          .json({ success: false, error: (error as Error).message });
      }
    }
  );

  app.get('/api/memory/search', async (req, res) => {
    try {
      const {
        query,
        userId,
        limit = 10,
      } = req.query as {
        query?: string;
        userId?: string;
        limit?: string;
      };

      if (!query) {
        return res.status(400).json({ success: false, error: '缺少query参数' });
      }

      if (!core) {
        return res
          .status(503)
          .json({ success: false, error: '核心系统未初始化' });
      }

      const memoryEngine = core.getMemoryEngine();
      if (!memoryEngine) {
        return res
          .status(503)
          .json({ success: false, error: '记忆引擎未初始化' });
      }

      let results: unknown[] = [];
      if (memoryEngine.retrieveContext) {
        const context = await memoryEngine.retrieveContext(query, userId);
        results = context.memories.map((m: unknown, index: number) => {
          const mem = m as Record<string, unknown>;
          const relevance = mem.relevance as number;
          return {
            id: `memory_${index}`,
            content: mem.content,
            importance:
              relevance > 0.7 ? 'high' : relevance > 0.4 ? 'medium' : 'low',
            timestamp: new Date().toISOString(),
            similarity: relevance,
          };
        });
      }

      res.json({
        success: true,
        data: {
          query,
          results: results.slice(0, parseInt(limit as string) || 10),
          total: results.length,
        },
      });
    } catch (error) {
      Logger.error('❌ 记忆检索失败', error as Error, 'MemoryAPI');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.get('/api/memory/profile', async (req, res) => {
    try {
      if (!core) {
        return res
          .status(503)
          .json({ success: false, error: '核心系统未初始化' });
      }

      const memoryEngine = core.getMemoryEngine();
      if (!memoryEngine) {
        return res
          .status(503)
          .json({ success: false, error: '记忆引擎未初始化' });
      }

      const userProfile = memoryEngine.getUserProfile?.() as
        | UserProfile
        | undefined;

      if (!userProfile) {
        return res
          .status(404)
          .json({ success: false, error: '用户画像不存在' });
      }

      res.json({
        success: true,
        data: {
          basicInfo: userProfile.getBasicInfo(),
          developmentHabits: userProfile.getDevelopmentHabits(),
          lifePreferences: userProfile.getLifePreferences(),
          emotionalPatterns: userProfile.getEmotionalPatterns(),
          taskPreferences: userProfile.getTaskPreferences(),
        },
      });
    } catch (error) {
      Logger.error('❌ 获取用户画像失败', error as Error, 'MemoryAPI');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.post(
    '/api/memory/preferences',
    express.json({ limit: '1mb' }),
    async (req, res) => {
      try {
        const { preferences } = req.body as {
          preferences?: Record<string, unknown>;
        };

        if (!preferences) {
          return res
            .status(400)
            .json({ success: false, error: '缺少preferences参数' });
        }

        if (!core) {
          return res
            .status(503)
            .json({ success: false, error: '核心系统未初始化' });
        }

        const memoryEngine = core.getMemoryEngine();
        if (!memoryEngine) {
          return res
            .status(503)
            .json({ success: false, error: '记忆引擎未初始化' });
        }

        const userProfile = memoryEngine.getUserProfile?.() as
          | UserProfile
          | undefined;

        if (!userProfile) {
          return res
            .status(404)
            .json({ success: false, error: '用户画像不存在' });
        }

        await userProfile.update({
          ...preferences,
          timestamp: new Date(),
        });

        res.json({
          success: true,
          data: {
            basicInfo: userProfile.getBasicInfo(),
            developmentHabits: userProfile.getDevelopmentHabits(),
            lifePreferences: userProfile.getLifePreferences(),
            emotionalPatterns: userProfile.getEmotionalPatterns(),
            taskPreferences: userProfile.getTaskPreferences(),
          },
        });
      } catch (error) {
        Logger.error('❌ 更新用户偏好失败', error as Error, 'MemoryAPI');
        res
          .status(500)
          .json({ success: false, error: (error as Error).message });
      }
    }
  );

  app.post(
    '/api/memory/store-short-term',
    express.json({ limit: '1mb' }),
    async (req, res) => {
      try {
        const bridge = getActivePythonBridge();
        if (!bridge)
          return res
            .status(503)
            .json({ success: false, error: 'Python 后端未连接' });
        const result = await bridge.request(
          'POST',
          '/v1/memory/store-short-term',
          req.body
        );
        res.json({ success: true, data: result });
      } catch (error) {
        Logger.error('短期记忆存储失败', error as Error, 'MemoryAPI');
        res
          .status(500)
          .json({ success: false, error: (error as Error).message });
      }
    }
  );

  app.post(
    '/api/memory/store-long-term',
    express.json({ limit: '1mb' }),
    async (req, res) => {
      try {
        const bridge = getActivePythonBridge();
        if (!bridge)
          return res
            .status(503)
            .json({ success: false, error: 'Python 后端未连接' });
        const result = await bridge.request(
          'POST',
          '/v1/memory/store-long-term',
          req.body
        );
        res.json({ success: true, data: result });
      } catch (error) {
        Logger.error('长期记忆存储失败', error as Error, 'MemoryAPI');
        res
          .status(500)
          .json({ success: false, error: (error as Error).message });
      }
    }
  );

  app.post(
    '/api/memory/store-episodic',
    express.json({ limit: '1mb' }),
    async (req, res) => {
      try {
        const bridge = getActivePythonBridge();
        if (!bridge)
          return res
            .status(503)
            .json({ success: false, error: 'Python 后端未连接' });
        const result = await bridge.request(
          'POST',
          '/v1/memory/store-episodic',
          req.body
        );
        res.json({ success: true, data: result });
      } catch (error) {
        Logger.error('情节记忆存储失败', error as Error, 'MemoryAPI');
        res
          .status(500)
          .json({ success: false, error: (error as Error).message });
      }
    }
  );

  app.post(
    '/api/memory/hybrid-retrieval',
    express.json({ limit: '1mb' }),
    async (req, res) => {
      try {
        const bridge = getActivePythonBridge();
        if (!bridge)
          return res
            .status(503)
            .json({ success: false, error: 'Python 后端未连接' });
        const result = await bridge.request(
          'POST',
          '/v1/memory/hybrid-retrieval',
          req.body
        );
        res.json({ success: true, data: result });
      } catch (error) {
        Logger.error('混合检索失败', error as Error, 'MemoryAPI');
        res
          .status(500)
          .json({ success: false, error: (error as Error).message });
      }
    }
  );

  app.post(
    '/api/memory/dream',
    express.json({ limit: '1mb' }),
    async (req, res) => {
      try {
        const bridge = getActivePythonBridge();
        if (!bridge)
          return res
            .status(503)
            .json({ success: false, error: 'Python 后端未连接' });
        const result = await bridge.request(
          'POST',
          '/v1/memory/dream',
          req.body
        );
        res.json({ success: true, data: result });
      } catch (error) {
        Logger.error('记忆整理失败', error as Error, 'MemoryAPI');
        res
          .status(500)
          .json({ success: false, error: (error as Error).message });
      }
    }
  );

  app.get('/api/memory/knowledge-graph', async (_req, res) => {
    try {
      const bridge = getActivePythonBridge();
      if (!bridge)
        return res
          .status(503)
          .json({ success: false, error: 'Python 后端未连接' });
      const result = await bridge.request('GET', '/v1/memory/knowledge-graph');
      res.json({ success: true, data: result });
    } catch (error) {
      Logger.error('知识图谱获取失败', error as Error, 'MemoryAPI');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });
}
