/**
 * 虚拟滚动 Hook
 * 优化大量消息的渲染性能
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface VirtualScrollOptions {
  itemHeight: number;
  overscan?: number;
  containerHeight: number;
}

interface VirtualScrollResult<T> {
  virtualItems: Array<{ item: T; index: number; style: React.CSSProperties }>;
  totalHeight: number;
  scrollToIndex: (index: number) => void;
  containerRef: React.RefObject<HTMLDivElement>;
  onScroll: () => void;
}

/**
 * 虚拟滚动 Hook
 * @param items 完整数据列表
 * @param options 配置选项
 * @returns 虚拟滚动结果
 */
export function useVirtualScroll<T>(items: T[], options: VirtualScrollOptions): VirtualScrollResult<T> {
  const { itemHeight, overscan = 5, containerHeight } = options;
  const containerRef = useRef<HTMLDivElement>(null!);
  const [scrollTop, setScrollTop] = useState(0);

  // 计算可见范围
  const virtualItems = useMemo(() => {
    const visibleCount = Math.ceil(containerHeight / itemHeight);
    const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
    const endIndex = Math.min(items.length, startIndex + visibleCount + overscan * 2);

    return items.slice(startIndex, endIndex).map((item, idx) => {
      const actualIndex = startIndex + idx;
      return {
        item,
        index: actualIndex,
        style: {
          position: 'absolute' as const,
          top: actualIndex * itemHeight,
          height: itemHeight,
          left: 0,
          right: 0,
        },
      };
    });
  }, [items, scrollTop, itemHeight, overscan, containerHeight]);

  // 总高度
  const totalHeight = useMemo(() => items.length * itemHeight, [items.length, itemHeight]);

  // 滚动处理
  const onScroll = useCallback(() => {
    if (containerRef.current) {
      setScrollTop(containerRef.current.scrollTop);
    }
  }, []);

  // 滚动到指定索引
  const scrollToIndex = useCallback(
    (index: number) => {
      if (containerRef.current) {
        containerRef.current.scrollTop = index * itemHeight;
      }
    },
    [itemHeight]
  );

  // 监听滚动事件
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, [onScroll]);

  return {
    virtualItems,
    totalHeight,
    scrollToIndex,
    containerRef,
    onScroll,
  };
}

export default useVirtualScroll;
