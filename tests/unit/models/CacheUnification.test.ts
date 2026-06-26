/**
 * P1 缓存系统统一 — 测试 ICache<V> 接口 + 多实现共享同一契约
 *
 * 验证：RedisCache 不再重复定义 ICache，而是复用 ICache.ts 的规范接口
 */
import { ICache, InMemoryCache } from '../../../src/models/ICache';
import { RedisCache } from '../../../src/models/RedisCache';

describe('P1 缓存系统统一 — ICache<V> 接口 + 多实现', () => {
  describe('ICache 规范接口', () => {
    it('ICache.set 应支持可选 ttlMs（向后兼容）', () => {
      const cache: ICache<string> = new InMemoryCache<string>();
      // 不传 ttl 也能工作（使用默认 TTL）
      cache.set('key1', 'value1');
      expect(cache.get('key1')).toBe('value1');
    });

    it('ICache.set 应支持显式 ttlMs', () => {
      const cache: ICache<string> = new InMemoryCache<string>();
      cache.set('key2', 'value2', 60000);
      expect(cache.get('key2')).toBe('value2');
    });

    it('ICache.clear 应返回清除的条目数', () => {
      const cache: ICache<string> = new InMemoryCache<string>();
      cache.set('a', '1');
      cache.set('b', '2');
      const cleared = cache.clear();
      expect(cleared).toBe(2);
    });
  });

  describe('RedisCache 复用规范 ICache 接口', () => {
    it('RedisCache 应实现规范 ICache 接口（非自定义重复定义）', () => {
      const cache: ICache<string> = new RedisCache<string>({});
      // 通过 ICache 接口引用，验证 RedisCache 实现了规范接口
      cache.set('redis-key', 'redis-value');
      expect(cache.get('redis-key')).toBe('redis-value');
    });

    it('RedisCache.set 应支持可选 ttlMs', () => {
      const cache: ICache<number> = new RedisCache<number>({});
      cache.set('counter', 42);
      expect(cache.get('counter')).toBe(42);
    });

    it('RedisCache.clear 应返回清除的条目数（符合 ICache 契约）', () => {
      const cache: ICache<boolean> = new RedisCache<boolean>({});
      cache.set('flag1', true);
      cache.set('flag2', false);
      const cleared = cache.clear();
      expect(cleared).toBeGreaterThanOrEqual(2);
    });

    it('RedisCache.delete 应返回布尔值', () => {
      const cache: ICache<string> = new RedisCache<string>({});
      cache.set('del-key', 'val');
      expect(cache.delete('del-key')).toBe(true);
      expect(cache.delete('nonexistent')).toBe(false);
    });

    it('RedisCache.getStats 应返回 CacheStats', () => {
      const cache: ICache<string> = new RedisCache<string>({});
      cache.set('s', 'v');
      cache.get('s');
      const stats = cache.getStats();
      expect(stats).toHaveProperty('hits');
      expect(stats).toHaveProperty('misses');
      expect(stats).toHaveProperty('hitRate');
    });

    it('RedisCache.close 应可调用且不抛错', () => {
      const cache: ICache<string> = new RedisCache<string>({});
      expect(() => cache.close()).not.toThrow();
    });
  });

  describe('多实现可互换（依赖倒置）', () => {
    it('上层代码应能通过 ICache 接口无缝切换 InMemoryCache 与 RedisCache', () => {
      function useCache(cache: ICache<string>): string | undefined {
        cache.set('shared-key', 'shared-value');
        return cache.get('shared-key');
      }

      const memResult = useCache(new InMemoryCache<string>());
      const redisResult = useCache(new RedisCache<string>({}));

      expect(memResult).toBe('shared-value');
      expect(redisResult).toBe('shared-value');
    });
  });
});
