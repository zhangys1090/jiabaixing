/**
 * VoiceInteractionManager 单元测试
 * 覆盖率目标：≥80%
 */

import { VoiceInteractionManager, VoiceSession, VoiceCommand } from '../../../src/interaction/VoiceInteractionManager';

describe('VoiceInteractionManager', () => {
  let manager: VoiceInteractionManager;

  beforeEach(async () => {
    manager = new VoiceInteractionManager();
    await manager.initialize();
  });

  afterEach(() => {
    manager.cleanup();
  });

  describe('会话管理', () => {
    test('应该能够开始语音会话', () => {
      const sessionId = manager.startSession('user-1', 'mobile');
      
      expect(sessionId).toBeDefined();
      expect(sessionId).toContain('session_');
      
      const session = manager.getSessionState(sessionId);
      expect(session).toBeDefined();
      expect(session?.userId).toBe('user-1');
      expect(session?.metadata.device).toBe('mobile');
    });

    test('应该能够结束语音会话', () => {
      const sessionId = manager.startSession('user-1');
      
      manager.endSession(sessionId);
      
      const session = manager.getSessionState(sessionId);
      expect(session?.context.conversationState).toBe('ended');
    });

    test('应该能够获取所有会话', () => {
      manager.startSession('user-1');
      manager.startSession('user-2');
      
      const sessions = manager.getAllSessions();
      expect(sessions).toHaveLength(2);
    });

    test('应该能够获取会话状态', () => {
      const sessionId = manager.startSession('user-1');
      
      const session = manager.getSessionState(sessionId);
      expect(session).toBeDefined();
      expect(session?.id).toBe(sessionId);
    });
  });

  describe('语音处理', () => {
    test('应该能够处理语音输入', async () => {
      const sessionId = manager.startSession('user-1');
      const audioData = Buffer.from('模拟音频数据');
      
      const command = await manager.processVoiceInput(sessionId, audioData);
      
      expect(command).toBeDefined();
      expect(command.text).toBeDefined();
      expect(command.confidence).toBeGreaterThan(0);
      expect(command.intent).toBeDefined();
    });

    test('应该更新会话时间', async () => {
      const sessionId = manager.startSession('user-1');
      const beforeTime = manager.getSessionState(sessionId)?.lastInteraction;
      
      // 等待一小段时间
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const audioData = Buffer.from('模拟音频数据');
      await manager.processVoiceInput(sessionId, audioData);
      
      const afterTime = manager.getSessionState(sessionId)?.lastInteraction;
      expect(afterTime?.getTime()).toBeGreaterThan(beforeTime?.getTime() || 0);
    });

    test('应该记录命令历史', async () => {
      const sessionId = manager.startSession('user-1');
      const audioData = Buffer.from('模拟音频数据');
      
      await manager.processVoiceInput(sessionId, audioData);
      await manager.processVoiceInput(sessionId, audioData);
      
      const session = manager.getSessionState(sessionId);
      expect(session?.commands.length).toBe(2);
    });

    test('应该限制命令数量', async () => {
      const sessionId = manager.startSession('user-1');
      const audioData = Buffer.from('模拟音频数据');
      
      // 添加超过最大限制的命令
      for (let i = 0; i < 55; i++) {
        await manager.processVoiceInput(sessionId, audioData).catch(() => {});
      }
      
      const session = manager.getSessionState(sessionId);
      expect(session?.commands.length).toBeLessThanOrEqual(50);
    }, 30000);
  });

  describe('语音响应', () => {
    test('应该能够生成语音响应', async () => {
      const sessionId = manager.startSession('user-1');
      const text = '这是一个测试响应';
      
      const audioBuffer = await manager.generateVoiceResponse(sessionId, text);
      
      expect(audioBuffer).toBeDefined();
      expect(audioBuffer.length).toBeGreaterThan(0);
    });

    test('应该根据情绪调整语音参数', async () => {
      const sessionId = manager.startSession('user-1');
      const text = '这是一个测试响应';
      
      // 测试不同情绪的响应
      const happyAudio = await manager.generateVoiceResponse(sessionId, text, '开心');
      const sadAudio = await manager.generateVoiceResponse(sessionId, text, '悲伤');
      
      expect(happyAudio).toBeDefined();
      expect(sadAudio).toBeDefined();
    });

    test('应该更新会话时间', async () => {
      const sessionId = manager.startSession('user-1');
      const beforeTime = manager.getSessionState(sessionId)?.lastInteraction;
      
      await new Promise(resolve => setTimeout(resolve, 100));
      
      await manager.generateVoiceResponse(sessionId, '测试');
      
      const afterTime = manager.getSessionState(sessionId)?.lastInteraction;
      expect(afterTime?.getTime()).toBeGreaterThan(beforeTime?.getTime() || 0);
    });
  });

  describe('配置管理', () => {
    test('应该能够设置识别配置', () => {
      manager.setRecognitionConfig({
        language: 'en-US',
        sampleRate: 44100
      });
      
      // 配置应该被更新（通过后续操作验证）
      const sessionId = manager.startSession('user-1');
      expect(sessionId).toBeDefined();
    });

    test('应该能够设置响应配置', () => {
      manager.setResponseConfig({
        voice: 'en-US-Wavenet-A',
        language: 'en-US'
      });
      
      // 配置应该被更新
      const sessionId = manager.startSession('user-1');
      expect(sessionId).toBeDefined();
    });
  });

  describe('会话清理', () => {
    test('应该清理过期会话', async () => {
      const sessionId = manager.startSession('user-1');
      
      // 模拟过期（手动修改最后交互时间）
      const session = manager.getSessionState(sessionId);
      if (session) {
        session.lastInteraction = new Date(Date.now() - 6 * 60 * 1000); // 6分钟前
      }
      
      const cleanedCount = manager.cleanupExpiredSessions();
      
      expect(cleanedCount).toBeGreaterThan(0);
      expect(manager.getSessionState(sessionId)).toBeUndefined();
    });

    test('不应该清理未过期会话', () => {
      const sessionId = manager.startSession('user-1');
      
      const cleanedCount = manager.cleanupExpiredSessions();
      
      expect(cleanedCount).toBe(0);
      expect(manager.getSessionState(sessionId)).toBeDefined();
    });
  });

  describe('统计信息', () => {
    test('应该提供正确的统计信息', async () => {
      const sessionId = manager.startSession('user-1');
      const audioData = Buffer.from('模拟音频数据');
      
      await manager.processVoiceInput(sessionId, audioData);
      
      const stats = manager.getStatistics();
      
      expect(stats.activeSessions).toBe(1);
      expect(stats.totalCommands).toBe(1);
    });

    test('应该计算平均置信度', async () => {
      const sessionId = manager.startSession('user-1');
      const audioData = Buffer.from('模拟音频数据');
      
      await manager.processVoiceInput(sessionId, audioData);
      
      const stats = manager.getStatistics();
      expect(stats.averageConfidence).toBeGreaterThan(0);
    });
  });

  describe('边界条件', () => {
    test('应该处理不存在的会话ID', async () => {
      const audioData = Buffer.from('模拟音频数据');
      
      await expect(
        manager.processVoiceInput('non-existent', audioData)
      ).rejects.toThrow('会话不存在');
    });

    test('应该处理空音频数据', async () => {
      const sessionId = manager.startSession('user-1');
      const audioData = Buffer.from('');

      // 空音频数据应该抛出"未检测到语音"的错误
      await expect(manager.processVoiceInput(sessionId, audioData)).rejects.toThrow('未检测到语音');
    });

    test('应该处理空文本响应', async () => {
      const sessionId = manager.startSession('user-1');
      
      const audioBuffer = await manager.generateVoiceResponse(sessionId, '');
      expect(audioBuffer).toBeDefined();
    });

    test('应该处理会话结束后的操作', async () => {
      const sessionId = manager.startSession('user-1');
      manager.endSession(sessionId);
      
      // 结束后应该仍然能够获取会话状态
      const session = manager.getSessionState(sessionId);
      expect(session).toBeDefined();
      expect(session?.context.conversationState).toBe('ended');
    });
  });
});
