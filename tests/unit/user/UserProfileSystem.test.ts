/**
 * UserProfileSystem 单元测试
 * 覆盖率目标：70%
 */

import { UserProfileSystem, UserBehavior } from '../../../src/user/UserProfileSystem';

describe('UserProfileSystem', () => {
  let system: UserProfileSystem;

  beforeEach(() => {
    system = new UserProfileSystem();
    system.initialize();
  });

  afterEach(() => {
    system.cleanup();
  });

  describe('用户画像创建', () => {
    test('应该能够创建用户画像', () => {
      const profile = system.createProfile('user-1');
      
      expect(profile).toBeDefined();
      expect(profile.userId).toBe('user-1');
      expect(profile.metadata.confidenceScore).toBe(0.5);
    });

    test('创建画像应该包含默认偏好', () => {
      const profile = system.createProfile('user-1');
      
      expect(profile.preferences.communicationStyle).toBe('friendly');
      expect(profile.preferences.responseLength).toBe('medium');
      expect(profile.preferences.preferredChannels).toContain('text');
    });

    test('创建画像应该包含空行为模式', () => {
      const profile = system.createProfile('user-1');
      
      expect(profile.behaviorPatterns.interactionFrequency).toBe(0);
      expect(profile.behaviorPatterns.averageSessionDuration).toBe(0);
    });
  });

  describe('行为记录', () => {
    test('应该能够记录用户行为', () => {
      const behavior: UserBehavior = {
        userId: 'user-1',
        timestamp: new Date(),
        type: 'interaction',
        action: 'click',
        content: '用户点击了按钮',
        context: {
          scene: '主页',
          emotion: '开心'
        },
        metadata: {
          duration: 5,
          success: true,
          satisfaction: 4
        }
      };

      system.recordBehavior(behavior);
      
      const stats = system.getStatistics();
      expect(stats.totalBehaviors).toBe(1);
    });

    test('应该能够批量记录行为', () => {
      const behaviors: UserBehavior[] = [
        {
          userId: 'user-1',
          timestamp: new Date(),
          type: 'interaction',
          action: 'click',
          content: '点击1',
          context: {},
          metadata: {}
        },
        {
          userId: 'user-1',
          timestamp: new Date(),
          type: 'task',
          action: 'complete',
          content: '完成任务',
          context: {},
          metadata: {}
        }
      ];

      system.recordBehaviors(behaviors);
      
      const stats = system.getStatistics();
      expect(stats.totalBehaviors).toBe(2);
    });

    test('应该限制行为历史数量', () => {
      for (let i = 0; i < 10100; i++) {
        const behavior: UserBehavior = {
          userId: 'user-1',
          timestamp: new Date(),
          type: 'interaction',
          action: `action-${i}`,
          content: `内容${i}`,
          context: {},
          metadata: {}
        };
        system.recordBehavior(behavior);
      }
      
      const stats = system.getStatistics();
      expect(stats.totalBehaviors).toBeLessThanOrEqual(10000);
    });
  });

  describe('画像更新', () => {
    test('应该基于行为更新偏好', () => {
      system.createProfile('user-1');
      
      const behaviors: UserBehavior[] = [
        {
          userId: 'user-1',
          timestamp: new Date(),
          type: 'interaction',
          action: 'search',
          content: '搜索工作相关内容',
          context: { scene: '工作' },
          metadata: {}
        },
        {
          userId: 'user-1',
          timestamp: new Date(),
          type: 'interaction',
          action: 'search',
          content: '搜索工作相关内容',
          context: { scene: '工作' },
          metadata: {}
        }
      ];

      system.recordBehaviors(behaviors);
      
      const profile = system.getProfile('user-1');
      expect(profile?.preferences.topics['工作']).toBeGreaterThan(0);
    });

    test('应该更新行为模式', () => {
      system.createProfile('user-1');
      
      for (let i = 0; i < 10; i++) {
        const behavior: UserBehavior = {
          userId: 'user-1',
          timestamp: new Date(),
          type: 'interaction',
          action: 'click',
          content: '点击',
          context: {},
          metadata: { duration: 10 }
        };
        system.recordBehavior(behavior);
      }
      
      const profile = system.getProfile('user-1');
      expect(profile?.behaviorPatterns.interactionFrequency).toBeGreaterThan(0);
    });

    test('应该更新情感画像', () => {
      system.createProfile('user-1');
      
      const behaviors: UserBehavior[] = [
        {
          userId: 'user-1',
          timestamp: new Date(),
          type: 'emotion',
          action: 'express',
          content: '表达情绪',
          context: { emotion: '开心' },
          metadata: {}
        },
        {
          userId: 'user-1',
          timestamp: new Date(),
          type: 'emotion',
          action: 'express',
          content: '表达情绪',
          context: { emotion: '开心' },
          metadata: {}
        }
      ];

      system.recordBehaviors(behaviors);
      
      const profile = system.getProfile('user-1');
      expect(profile?.emotionalProfile.dominantEmotions['开心']).toBe(2);
    });

    test('应该更新交互历史', () => {
      system.createProfile('user-1');
      
      const behaviors: UserBehavior[] = [
        {
          userId: 'user-1',
          timestamp: new Date(),
          type: 'task',
          action: 'complete',
          content: '完成任务',
          context: {},
          metadata: { success: true, satisfaction: 5 }
        },
        {
          userId: 'user-1',
          timestamp: new Date(),
          type: 'task',
          action: 'fail',
          content: '任务失败',
          context: {},
          metadata: { success: false }
        }
      ];

      system.recordBehaviors(behaviors);
      
      const profile = system.getProfile('user-1');
      expect(profile?.interactionHistory.totalInteractions).toBe(2);
      expect(profile?.interactionHistory.successfulTasks).toBe(1);
      expect(profile?.interactionHistory.failedTasks).toBe(1);
    });
  });

  describe('行为预测', () => {
    test('应该能够预测用户行为', () => {
      system.createProfile('user-1');
      
      const behaviors: UserBehavior[] = [
        {
          userId: 'user-1',
          timestamp: new Date(),
          type: 'interaction',
          action: 'read_news',
          content: '阅读新闻',
          context: { scene: '早晨' },
          metadata: {}
        },
        {
          userId: 'user-1',
          timestamp: new Date(),
          type: 'interaction',
          action: 'read_news',
          content: '阅读新闻',
          context: { scene: '早晨' },
          metadata: {}
        }
      ];

      system.recordBehaviors(behaviors);
      
      const predictions = system.predictUserBehavior('user-1', { scene: '早晨' });
      expect(predictions).toContain('read_news');
    });

    test('应该能够获取个性化推荐', () => {
      system.createProfile('user-1');
      
      const behaviors: UserBehavior[] = [
        {
          userId: 'user-1',
          timestamp: new Date(),
          type: 'interaction',
          action: 'like',
          content: '喜欢科技话题',
          context: {},
          metadata: {}
        }
      ];

      system.recordBehaviors(behaviors);
      
      const recommendations = system.getPersonalizedRecommendations('user-1', {});
      expect(recommendations.length).toBeGreaterThan(0);
    });
  });

  describe('画像查询', () => {
    test('应该能够获取用户画像', () => {
      system.createProfile('user-1');
      
      const profile = system.getProfile('user-1');
      expect(profile).toBeDefined();
      expect(profile?.userId).toBe('user-1');
    });

    test('应该能够获取所有画像', () => {
      system.createProfile('user-1');
      system.createProfile('user-2');
      
      const profiles = system.getAllProfiles();
      expect(profiles).toHaveLength(2);
    });

    test('不存在的用户应该返回undefined', () => {
      const profile = system.getProfile('non-existent');
      expect(profile).toBeUndefined();
    });
  });

  describe('统计信息', () => {
    test('应该提供正确的统计信息', () => {
      system.createProfile('user-1');
      system.createProfile('user-2');

      const behavior: UserBehavior = {
        userId: 'user-1',
        timestamp: new Date(),
        type: 'interaction',
        action: 'click',
        content: '点击',
        context: {},
        metadata: {}
      };
      system.recordBehavior(behavior);
      
      const stats = system.getStatistics();
      expect(stats.totalUsers).toBe(2);
      expect(stats.totalBehaviors).toBe(1);
    });

    test('应该计算活跃用户', () => {
      system.createProfile('user-1');
      system.createProfile('user-2');

      const behavior: UserBehavior = {
        userId: 'user-1',
        timestamp: new Date(),
        type: 'interaction',
        action: 'click',
        content: '点击',
        context: {},
        metadata: {}
      };
      system.recordBehavior(behavior);
      
      const stats = system.getStatistics();
      expect(stats.activeUsers).toBe(1);
    });
  });

  describe('数据清理', () => {
    test('应该能够清理用户数据', () => {
      system.createProfile('user-1');

      const behavior: UserBehavior = {
        userId: 'user-1',
        timestamp: new Date(),
        type: 'interaction',
        action: 'click',
        content: '点击',
        context: {},
        metadata: {}
      };
      system.recordBehavior(behavior);
      
      system.cleanupUser('user-1');
      
      const profile = system.getProfile('user-1');
      expect(profile).toBeUndefined();
      
      const stats = system.getStatistics();
      expect(stats.totalBehaviors).toBe(0);
    });

    test('应该能够清理所有数据', () => {
      system.createProfile('user-1');
      system.createProfile('user-2');
      
      system.cleanup();
      
      const stats = system.getStatistics();
      expect(stats.totalUsers).toBe(0);
      expect(stats.totalBehaviors).toBe(0);
    });
  });

  describe('边界条件', () => {
    test('应该处理空行为列表', () => {
      system.createProfile('user-1');
      
      const profile = system.getProfile('user-1');
      expect(profile?.interactionHistory.totalInteractions).toBe(0);
    });

    test('应该处理单个行为', () => {
      system.createProfile('user-1');

      const behavior: UserBehavior = {
        userId: 'user-1',
        timestamp: new Date(),
        type: 'interaction',
        action: 'click',
        content: '点击',
        context: {},
        metadata: {}
      };
      system.recordBehavior(behavior);
      
      const profile = system.getProfile('user-1');
      expect(profile?.interactionHistory.totalInteractions).toBe(1);
    });

    test('应该处理不同时间戳的行为', () => {
      system.createProfile('user-1');
      
      const now = new Date();
      const behaviors: UserBehavior[] = [
        {
          userId: 'user-1',
          timestamp: new Date(now.getTime() - 1000),
          type: 'interaction',
          action: 'click',
          content: '点击1',
          context: {},
          metadata: {}
        },
        {
          userId: 'user-1',
          timestamp: now,
          type: 'interaction',
          action: 'click',
          content: '点击2',
          context: {},
          metadata: {}
        }
      ];

      system.recordBehaviors(behaviors);
      
      const profile = system.getProfile('user-1');
      expect(profile?.interactionHistory.totalInteractions).toBe(2);
    });
  });
});
