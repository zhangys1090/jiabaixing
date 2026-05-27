/**
 * 性能监控 Hook
 * 监控组件渲染性能、内存使用和交互延迟
 */

import { useCallback, useEffect, useRef, useState } from 'react';

interface PerformanceMetrics {
  renderCount: number;
  averageRenderTime: number;
  lastRenderTime: number;
  memoryUsage: number;
  fps: number;
  interactionDelay: number;
}

interface PerformanceMonitorOptions {
  enabled?: boolean;
  logThreshold?: number;
  onPerformanceIssue?: (metrics: PerformanceMetrics) => void;
}

/**
 * 性能监控 Hook
 * @param options 配置选项
 * @returns 性能指标和监控方法
 */
export function usePerformanceMonitor(options: PerformanceMonitorOptions = {}) {
  const { enabled = true, logThreshold = 100, onPerformanceIssue } = options;

  const [metrics, setMetrics] = useState<PerformanceMetrics>({
    renderCount: 0,
    averageRenderTime: 0,
    lastRenderTime: 0,
    memoryUsage: 0,
    fps: 60,
    interactionDelay: 0,
  });

  const renderCountRef = useRef(0);
  const renderTimesRef = useRef<number[]>([]);
  const lastRenderStartRef = useRef<number>(0);
  const fpsRef = useRef(60);
  const frameCountRef = useRef(0);
  const lastFpsUpdateRef = useRef(Date.now());
  const interactionStartRef = useRef<number>(0);

  // 开始渲染计时
  const _startRender = useCallback(() => {
    if (!enabled) return;
    lastRenderStartRef.current = performance.now();
  }, [enabled]);

  // 结束渲染计时
  const _endRender = useCallback(() => {
    if (!enabled) return;

    const renderTime = performance.now() - lastRenderStartRef.current;
    renderCountRef.current += 1;
    renderTimesRef.current.push(renderTime);

    // 只保留最近50次渲染时间
    if (renderTimesRef.current.length > 50) {
      renderTimesRef.current.shift();
    }

    const avgTime = renderTimesRef.current.reduce((a, b) => a + b, 0) / renderTimesRef.current.length;

    // 获取内存使用（如果可用）
    let memoryUsage = 0;
    const perfMemory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    if (perfMemory) {
      memoryUsage = perfMemory.usedJSHeapSize;
    }

    setMetrics((prev) => ({
      ...prev,
      renderCount: renderCountRef.current,
      averageRenderTime: Math.round(avgTime * 100) / 100,
      lastRenderTime: Math.round(renderTime * 100) / 100,
      memoryUsage,
      fps: fpsRef.current,
    }));

    // 检测性能问题
    if (renderTime > logThreshold && onPerformanceIssue) {
      onPerformanceIssue({
        renderCount: renderCountRef.current,
        averageRenderTime: avgTime,
        lastRenderTime: renderTime,
        memoryUsage,
        fps: fpsRef.current,
        interactionDelay: 0,
      });
    }
  }, [enabled, logThreshold, onPerformanceIssue]);

  // 开始交互计时
  const startInteraction = useCallback(() => {
    if (!enabled) return;
    interactionStartRef.current = performance.now();
  }, [enabled]);

  // 结束交互计时
  const endInteraction = useCallback(() => {
    if (!enabled || interactionStartRef.current === 0) return;

    const delay = performance.now() - interactionStartRef.current;
    interactionStartRef.current = 0;

    setMetrics((prev) => ({
      ...prev,
      interactionDelay: Math.round(delay * 100) / 100,
    }));
  }, [enabled]);

  // FPS 计算
  useEffect(() => {
    if (!enabled) return;

    let animationFrameId: number;

    const calculateFps = () => {
      frameCountRef.current += 1;
      const now = Date.now();

      if (now - lastFpsUpdateRef.current >= 1000) {
        fpsRef.current = frameCountRef.current;
        frameCountRef.current = 0;
        lastFpsUpdateRef.current = now;
      }

      animationFrameId = requestAnimationFrame(calculateFps);
    };

    animationFrameId = requestAnimationFrame(calculateFps);

    return () => cancelAnimationFrame(animationFrameId);
  }, [enabled]);

  // 定期清理旧数据
  useEffect(() => {
    if (!enabled) return;

    const interval = setInterval(() => {
      if (renderTimesRef.current.length > 50) {
        renderTimesRef.current = renderTimesRef.current.slice(-50);
      }
    }, 30000);

    return () => clearInterval(interval);
  }, [enabled]);

  return {
    metrics,
    startRender: _startRender,
    endRender: _endRender,
    startInteraction,
    endInteraction,
  };
}

export default usePerformanceMonitor;
