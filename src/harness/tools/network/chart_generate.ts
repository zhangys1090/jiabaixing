import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';
import { Logger } from '../../../utils/Logger';

export const CHART_GENERATE_DEF: ToolDefinition = {
  name: 'chart_generate',
  description:
    '用 QuickChart.io 免费API生成数据图表（柱状图、折线图、饼图、环形图、雷达图），返回Markdown图片链接。USE WHEN: 需要可视化数据分析结果、生成图表报告、展示统计数据。DO NOT USE WHEN: 需要生成复杂交互式图表、需要本地保存图表文件。',
  category: ToolCategory.NETWORK,
  parameters: {
    chart_type: {
      type: 'string',
      description: '图表类型',
      enum: ['bar', 'line', 'pie', 'doughnut', 'radar'],
      default: 'bar',
    },
    title: {
      type: 'string',
      description: '图表标题',
    },
    labels: {
      type: 'array',
      description: 'X轴标签/数据类别名称',
      items: { type: 'string', description: '标签名称' },
    },
    datasets: {
      type: 'array',
      description: '数据集列表',
      items: {
        type: 'object',
        description: '单个数据集',
        properties: {
          label: { type: 'string', description: '数据集名称' },
          data: {
            type: 'array',
            description: '数据值数组',
            items: { type: 'number', description: '数据点值' },
          },
          color: { type: 'string', description: '颜色（可选，如 #ff6384）' },
        },
      },
    },
    output_format: {
      type: 'string',
      description: '输出格式',
      enum: ['markdown', 'url', 'base64'],
      default: 'markdown',
    },
    width: {
      type: 'number',
      description: '图表宽度（像素）',
      default: 600,
    },
    height: {
      type: 'number',
      description: '图表高度（像素）',
      default: 400,
    },
  },
  requiredParams: ['title', 'labels', 'datasets'],
  requiredPermissions: [Permission.NETWORK_ACCESS],
  riskLevel: 'low',
  idempotent: true,
  timeout: 30000,
};

export interface ChartGenerateDeps {
  httpClient?: {
    get(url: string): Promise<string>;
  };
}

function ok(
  output: string,
  duration: number,
  metadata?: Record<string, unknown>
): ToolResult {
  return { success: true, output, duration, validated: false, metadata };
}

function fail(
  error: string,
  duration: number,
  output: string = ''
): ToolResult {
  return { success: false, output, error, duration, validated: false };
}

/** 生成 Chart.js 配置 */
function buildChartConfig(
  chartType: string,
  title: string,
  labels: string[],
  datasets: Array<{ label: string; data: number[]; color?: string }>
): Record<string, unknown> {
  const colors = [
    '#36a2eb',
    '#ff6384',
    '#4bc0c0',
    '#ff9f40',
    '#9966ff',
    '#ffcd56',
    '#c9cbcf',
    '#7bc043',
    '#f37735',
    '#ee4037',
  ];

  const chartDatasets = datasets.map((ds, idx) => {
    const baseColor = ds.color || colors[idx % colors.length];
    const isPieLike = ['pie', 'doughnut'].includes(chartType);
    return {
      label: ds.label,
      data: ds.data,
      backgroundColor: isPieLike
        ? ds.data.map((_, i) => colors[i % colors.length])
        : baseColor,
      borderColor: isPieLike ? '#ffffff' : baseColor,
      borderWidth: isPieLike ? 2 : 1,
    };
  });

  const config: Record<string, unknown> = {
    type: chartType,
    data: {
      labels,
      datasets: chartDatasets,
    },
    options: {
      title: {
        display: true,
        text: title,
      },
      plugins: {
        legend: { display: true, position: 'bottom' },
      },
    },
  };

  // 雷达图需额外配置
  if (chartType === 'radar') {
    (config.options as Record<string, unknown>).scale = {
      ticks: { beginAtZero: true },
    };
  }

  return config;
}

/**
 * 通过 QuickChart.io API 生成图表图片URL
 * 使用 POST 方式发送 Chart.js JSON 配置
 */
async function generateChartUrl(
  chartConfig: Record<string, unknown>,
  width: number,
  height: number,
  httpClient?: ChartGenerateDeps['httpClient']
): Promise<string> {
  if (httpClient) {
    // Use injected httpClient.get (the existing project pattern).
    // QuickChart supports GET with 'c' param for chart config.
    const chartJson = JSON.stringify(chartConfig);
    const encoded = encodeURIComponent(chartJson);
    const chartUrlWithConfig = `https://quickchart.io/chart?c=${encoded}&width=${width}&height=${height}&format=png`;
    await httpClient.get(chartUrlWithConfig);
    return chartUrlWithConfig;
  }

  // Production path: POST to QuickChart, response is the image bytes
  // We use the chart URL (GET) approach which is simpler and more reliable
  // Encode the chart config as JSON and put it in the URL query param
  const chartJson = JSON.stringify(chartConfig);
  const encoded = encodeURIComponent(chartJson);
  const chartUrl = `https://quickchart.io/chart?c=${encoded}&width=${width}&height=${height}&format=png`;

  // Verify the QuickChart service is reachable (quick HEAD request)
  try {
    const resp = await fetch(chartUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      throw new Error(`QuickChart service returned HTTP ${resp.status}`);
    }
  } catch (err) {
    // If the HEAD fails, still return the URL — it may work when the user opens it
    Logger.warn(
      `QuickChart 连通性检查失败: ${(err as Error).message}，仍返回生成的URL`,
      'ChartGenerate'
    );
  }

  return chartUrl;
}

export function createChartGenerateExecutor(deps: ChartGenerateDeps = {}) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const chartType = (params.chart_type as string) || 'bar';
    const title = params.title as string;
    const labels = params.labels as string[];
    const datasets = params.datasets as Array<{
      label: string;
      data: number[];
      color?: string;
    }>;
    const outputFormat = (params.output_format as string) || 'markdown';
    const width = (params.width as number) || 600;
    const height = (params.height as number) || 400;

    try {
      // 参数校验
      if (!title || title.trim().length === 0) {
        return fail('图表标题不能为空', Date.now() - startTime);
      }

      if (!labels || !Array.isArray(labels) || labels.length === 0) {
        return fail('标签数组不能为空', Date.now() - startTime);
      }

      if (!datasets || !Array.isArray(datasets) || datasets.length === 0) {
        return fail('数据集不能为空', Date.now() - startTime);
      }

      for (const ds of datasets) {
        if (!ds.label) {
          return fail('每个数据集必须有 label', Date.now() - startTime);
        }
        if (!ds.data || !Array.isArray(ds.data) || ds.data.length === 0) {
          return fail(
            `数据集"${ds.label}"的数据不能为空`,
            Date.now() - startTime
          );
        }
      }

      const validChartTypes = ['bar', 'line', 'pie', 'doughnut', 'radar'];
      if (!validChartTypes.includes(chartType)) {
        return fail(
          `不支持的图表类型: "${chartType}"，支持: ${validChartTypes.join(', ')}`,
          Date.now() - startTime
        );
      }

      const chartConfig = buildChartConfig(chartType, title, labels, datasets);
      const chartUrl = await generateChartUrl(
        chartConfig,
        width,
        height,
        deps.httpClient
      );

      let output: string;
      let metadata: Record<string, unknown> = {
        chartType,
        title,
        width,
        height,
        labelsCount: labels.length,
        datasetsCount: datasets.length,
      };

      switch (outputFormat) {
        case 'url':
          output = chartUrl;
          break;
        case 'base64':
          // QuickChart returns PNG, so we'd need to fetch the actual image and base64 encode it
          // For simplicity with just HTTP API, return the URL with a note
          output = `图表URL (如需base64请自行下载转码): ${chartUrl}`;
          break;
        case 'markdown':
        default:
          output = `![${title}](${chartUrl})`;
          break;
      }

      Logger.info(
        `📊 chart_generate 成功: ${chartType} "${title}" (${labels.length} labels, ${datasets.length} datasets)`,
        'ChartGenerate'
      );

      return ok(output, Date.now() - startTime, metadata);
    } catch (error) {
      Logger.error('❌ chart_generate 失败', error as Error, 'ChartGenerate');
      return fail(
        `图表生成失败: ${(error as Error).message}`,
        Date.now() - startTime
      );
    }
  };
}
