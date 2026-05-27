import { ReportHandler, Metric } from 'web-vitals';

// 性能指标阈值
const PERFORMANCE_THRESHOLDS = {
  CLS: 0.1, // 累积布局偏移
  FID: 100, // 首次输入延迟 (ms)
  FCP: 1800, // 首次内容绘制 (ms)
  LCP: 2500, // 最大内容绘制 (ms)
  TTFB: 800, // 首字节时间 (ms)
};

// 性能指标告警级别
const getPerformanceLevel = (metric: Metric): 'good' | 'needs-improvement' | 'poor' => {
  switch (metric.name) {
    case 'CLS':
      return metric.value <= PERFORMANCE_THRESHOLDS.CLS ? 'good' : 'needs-improvement';
    case 'FID':
      return metric.value <= PERFORMANCE_THRESHOLDS.FID
        ? 'good'
        : metric.value <= PERFORMANCE_THRESHOLDS.FID * 2
          ? 'needs-improvement'
          : 'poor';
    case 'FCP':
      return metric.value <= PERFORMANCE_THRESHOLDS.FCP
        ? 'good'
        : metric.value <= PERFORMANCE_THRESHOLDS.FCP * 2
          ? 'needs-improvement'
          : 'poor';
    case 'LCP':
      return metric.value <= PERFORMANCE_THRESHOLDS.LCP
        ? 'good'
        : metric.value <= PERFORMANCE_THRESHOLDS.LCP * 2
          ? 'needs-improvement'
          : 'poor';
    case 'TTFB':
      return metric.value <= PERFORMANCE_THRESHOLDS.TTFB
        ? 'good'
        : metric.value <= PERFORMANCE_THRESHOLDS.TTFB * 2
          ? 'needs-improvement'
          : 'poor';
    default:
      return 'good';
  }
};

// 发送性能指标到后端
const sendPerformanceMetric = async (metric: Metric) => {
  try {
    const apiBaseUrl = process.env.REACT_APP_API_BASE_URL || window.location.origin;
    const level = getPerformanceLevel(metric);

    await fetch(`${apiBaseUrl}/api/performance/metrics`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: metric.name,
        value: metric.value,
        id: metric.id,
        entries: metric.entries,
        level,
        url: window.location.href,
        userAgent: navigator.userAgent,
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (error) {
    console.error('发送性能指标失败:', error);
  }
};

// 记录性能指标到控制台
const logPerformanceMetric = (metric: Metric) => {
  const level = getPerformanceLevel(metric);
  console.log(`[Performance] ${metric.name}: ${metric.value.toFixed(2)} (${level})`);
};

const reportWebVitals = (onPerfEntry?: ReportHandler) => {
  if (onPerfEntry && onPerfEntry instanceof Function) {
    void import('web-vitals').then(({ getCLS, getFID, getFCP, getLCP, getTTFB }) => {
      const handlePerfEntry = (metric: Metric) => {
        onPerfEntry(metric);
        logPerformanceMetric(metric);
        void sendPerformanceMetric(metric);
      };

      getCLS(handlePerfEntry);
      getFID(handlePerfEntry);
      getFCP(handlePerfEntry);
      getLCP(handlePerfEntry);
      getTTFB(handlePerfEntry);
    });
  }
};

export default reportWebVitals;
