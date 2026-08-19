/**
 * 轻量 per-store 异步互斥锁。
 *
 * 用于序列化同一存储对象上的 read-modify-write 临界区，
 * 防止 task / note / calendar 在并发写同一存储时相互丢失更新（审计 E3）。
 *
 * 按存储对象引用(WeakMap)分桶：不同存储之间不互相阻塞；
 * 同一存储上的所有 mutate 操作严格串行执行。
 */

type AnyStore = object;

const lockChains = new WeakMap<AnyStore, Promise<unknown>>();

/**
 * 在 `store` 的独占临界区内执行 `critical`。
 * - 返回 `critical` 的结果（含其 reject，错误照常向调用方传播）。
 * - 单次失败不会让锁链断裂（链中错误被吞掉以维持序列化顺序）。
 */
export function withStoreLock<T>(
  store: AnyStore,
  critical: () => Promise<T>
): Promise<T> {
  const prev = lockChains.get(store) ?? Promise.resolve();
  const run = () => critical();
  const next = prev.then(run, run);
  // 维持锁链但不因单次失败而断裂。
  lockChains.set(store, next.then(() => undefined, () => undefined));
  return next;
}
