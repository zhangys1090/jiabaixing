/**
 * AuxiliaryRouter 单元测试
 */
import { AuxiliaryRouter } from '../../../src/models/AuxiliaryRouter';

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('AuxiliaryRouter', () => {
  let router: AuxiliaryRouter;

  beforeEach(() => {
    router = new AuxiliaryRouter();
  });

  it('默认任务应返回主模型配置', () => {
    const config = router.resolve('default');
    expect(config.model).toBeDefined();
    expect(config.baseUrl).toBeDefined();
    expect(config.apiKey).toBeDefined();
  });

  it('应返回所有必填字段', () => {
    const config = router.resolve('compression');
    expect(config).toHaveProperty('model');
    expect(config).toHaveProperty('baseUrl');
    expect(config).toHaveProperty('apiKey');
    expect(config).toHaveProperty('providerName');
  });

  it('显式配置应覆盖', () => {
    router.setConfig('vision', {
      model: 'gpt-4o',
      provider: 'openai',
    });
    const config = router.resolve('vision');
    expect(config.model).toBe('gpt-4o');
  });

  it('不同任务应独立配置', () => {
    router.setConfig('compression', {
      model: 'deepseek-chat',
      provider: 'deepseek',
    });
    router.setConfig('search', {
      model: 'gpt-4o-mini',
      provider: 'openai',
    });

    const compression = router.resolve('compression');
    const search = router.resolve('search');

    expect(compression.model).toBe('deepseek-chat');
    expect(search.model).toBe('gpt-4o-mini');
  });

  it('getConfig 应返回合并后的配置', () => {
    router.setConfig('memory', { model: 'claude-sonnet-4' });
    const config = router.getConfig('memory');
    expect(config.model).toBe('claude-sonnet-4');
  });
});
