/**
 * Conversation API 路由 — 会话持久化 CRUD + FTS 搜索
 *
 * GET    /api/conversations           — 列出会话（支持 userId/limit/offset）
 * GET    /api/conversations/:id        — 获取会话详情
 * GET    /api/conversations/:id/messages — 获取会话消息
 * POST   /api/conversations           — 创建新会话
 * PUT    /api/conversations/:id        — 更新会话（标题/标签/摘要）
 * DELETE /api/conversations/:id        — 删除会话
 * POST   /api/conversations/search     — FTS5 搜索对话内容
 * GET    /api/conversations/:id/export  — ShareGPT 格式导出
 */

import express from 'express';
import { ConversationStore } from '../../memory/ConversationStore';
import { Logger } from '../../utils/Logger';

const router = express.Router();

// 单例 ConversationStore
let store: ConversationStore | null = null;

function getStore(): ConversationStore {
  if (!store) {
    store = new ConversationStore();
    Logger.info('ConversationStore 已初始化', 'ConversationRoutes');
  }
  return store;
}

/** 列出会话 */
router.get('/', (req: express.Request, res: express.Response) => {
  try {
    const userId = req.query.userId as string | undefined;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const conversations = getStore().listConversations(userId, limit, offset);
    res.json({ data: conversations, count: conversations.length });
  } catch (err) {
    Logger.error('列出会话失败', err as Error, 'ConversationRoutes');
    res.status(500).json({ error: (err as Error).message });
  }
});

/** 获取会话详情 */
router.get('/:id', (req: express.Request, res: express.Response) => {
  try {
    const conversation = getStore().getConversation(req.params.id);
    if (!conversation) {
      return res.status(404).json({ error: '会话不存在' });
    }
    res.json({ data: conversation });
  } catch (err) {
    Logger.error('获取会话失败', err as Error, 'ConversationRoutes');
    res.status(500).json({ error: (err as Error).message });
  }
});

/** 获取会话消息 */
router.get('/:id/messages', (req: express.Request, res: express.Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || undefined;
    const messages = getStore().getMessages(req.params.id, limit);
    res.json({ data: messages, count: messages.length });
  } catch (err) {
    Logger.error('获取消息失败', err as Error, 'ConversationRoutes');
    res.status(500).json({ error: (err as Error).message });
  }
});

/** 创建新会话 */
router.post('/', (req: express.Request, res: express.Response) => {
  try {
    const { id, title, userId, model, tags } = req.body;
    if (!id) {
      return res.status(400).json({ error: '缺少 id 字段' });
    }

    const conversation = getStore().createConversation({
      id,
      title: title || '',
      userId: userId || 'default',
      model: model || '',
      tags: tags || [],
    });
    res.json({ data: conversation, success: true });
  } catch (err) {
    Logger.error('创建会话失败', err as Error, 'ConversationRoutes');
    res.status(500).json({ error: (err as Error).message });
  }
});

/** 添加消息到会话 */
router.post('/:id/messages', (req: express.Request, res: express.Response) => {
  try {
    const { id: msgId, role, content, metadata } = req.body;
    if (!msgId || !role || !content) {
      return res.status(400).json({ error: '缺少 id/role/content 字段' });
    }

    getStore().addMessage({
      id: msgId,
      conversationId: req.params.id,
      role,
      content,
      timestamp: Date.now(),
      metadata,
    });
    res.json({ success: true });
  } catch (err) {
    Logger.error('添加消息失败', err as Error, 'ConversationRoutes');
    res.status(500).json({ error: (err as Error).message });
  }
});

/** 更新会话 */
router.put('/:id', (req: express.Request, res: express.Response) => {
  try {
    const { title, model, tags, summary } = req.body;
    const success = getStore().updateConversation(req.params.id, {
      title,
      model,
      tags,
      summary,
    });
    res.json({ success });
  } catch (err) {
    Logger.error('更新会话失败', err as Error, 'ConversationRoutes');
    res.status(500).json({ error: (err as Error).message });
  }
});

/** 删除会话 */
router.delete('/:id', (req: express.Request, res: express.Response) => {
  try {
    const success = getStore().deleteConversation(req.params.id);
    res.json({ success });
  } catch (err) {
    Logger.error('删除会话失败', err as Error, 'ConversationRoutes');
    res.status(500).json({ error: (err as Error).message });
  }
});

/** FTS5 搜索对话内容 */
router.post('/search', (req: express.Request, res: express.Response) => {
  try {
    const { query, limit } = req.body;
    if (!query) {
      return res.status(400).json({ error: '缺少 query 字段' });
    }

    const results = getStore().searchConversations(query, limit || 20);
    res.json({ data: results, count: results.length });
  } catch (err) {
    Logger.error('搜索对话失败', err as Error, 'ConversationRoutes');
    res.status(500).json({ error: (err as Error).message });
  }
});

/** ShareGPT 格式导出 */
router.get('/:id/export', (req: express.Request, res: express.Response) => {
  try {
    const trajectory = getStore().exportShareGPT(req.params.id);
    if (!trajectory) {
      return res.status(404).json({ error: '会话不存在' });
    }
    res.json({ data: trajectory });
  } catch (err) {
    Logger.error('导出轨迹失败', err as Error, 'ConversationRoutes');
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
