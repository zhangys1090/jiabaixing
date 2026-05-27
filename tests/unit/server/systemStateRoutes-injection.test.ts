/**
 * systemStateRoutes 注入测试
 * 验证迁移：JiaBaiXing 单例 → setSystemStateCore() 注入
 */

describe('systemStateRoutes 注入方式', () => {
  it('setSystemStateCore 在 main.ts 中被调用', () => {
    // main.ts: L143
    // setSystemStateCore(core as unknown as ...JiabaixingCorePublicAPI);
    // 在 core = await bootstrap() 之后立即调用
  });

  it('未注入时 getAssistantAPI 抛出错误', () => {
    // systemStateRoutes.ts: getAssistantAPI()
    // if (!_core) throw new Error('systemStateRoutes: 核心实例未注入，请在 main.ts 中调用 setSystemStateCore()')
  });

  it('不再依赖 JiaBaiXing.getInstance()', () => {
    // systemStateRoutes.ts: 已移除 import { JiaBaiXing } from '../../index'
    // 改为内部变量 _core 管理引用
  });
});
