/**
 * 批处理路由 - POST /api/batch/run
 *
 * 并行运行多个 prompt，生成结构化轨迹数据（ShareGPT / JSONL / raw）
 * 接入 BatchProcessor 引擎，复用 core.processInput 作为单条执行器
 */

import express from 'express';
import { JiabaixingCore } from '../../core/JiabaixingCore';
import {
  BatchProcessor,
  type BatchConfig,
  type BatchPrompt,
} from '../../harness/batch/BatchProcessor';
import { Logger } from '../../utils/Logger';

interface BatchRunRequest {
  prompts: BatchPrompt[];
  config?: Partial<BatchConfig>;
  outputFormat?: 'sharegpt' | 'jsonl' | 'raw';
}

export function registerBatchRoutes(
  app: express.Application,
  core: JiabaixingCore | null
): void {
  app.post(
    '/api/batch/run',
    express.json({ limit: '50mb' }),
    async (req, res) => {
      try {
        if (!core) {
          res.status(503).json({ success: false, error: '核心未初始化' });
          return;
        }

        const body = req.body as BatchRunRequest;
        if (!Array.isArray(body?.prompts) || body.prompts.length === 0) {
          res
            .status(400)
            .json({ success: false, error: '请提供非空 prompts 数组' });
          return;
        }

        if (body.prompts.length > 100) {
          res
            .status(400)
            .json({ success: false, error: '单次批处理最多100条prompt' });
          return;
        }

        for (const p of body.prompts) {
          if (
            !p.text ||
            typeof p.text !== 'string' ||
            p.text.trim().length === 0
          ) {
            res
              .status(400)
              .json({
                success: false,
                error: '每条prompt必须包含非空text字段',
              });
            return;
          }
          if (p.text.length > 50000) {
            res
              .status(400)
              .json({ success: false, error: '单条prompt不能超过50000字' });
            return;
          }
        }

        const config: BatchConfig = {
          concurrency: Math.min(body.config?.concurrency ?? 3, 10),
          timeout: body.config?.timeout ?? 60000,
          outputFormat: body.outputFormat ?? body.config?.outputFormat ?? 'raw',
          continueOnError: body.config?.continueOnError ?? true,
        };

        const processor = new BatchProcessor(config);

        const results = await processor.run(body.prompts, async (prompt) => {
          const start = Date.now();
          try {
            const result = await core.processInput(
              prompt.text,
              undefined,
              undefined
            );
            return {
              id: prompt.id,
              response: result.response,
              success: true,
              duration: Date.now() - start,
              metadata: {
                ...prompt.metadata,
                traceId: result.traceId,
                quality: result.quality,
              },
            };
          } catch (err) {
            return {
              id: prompt.id,
              response: '',
              success: false,
              duration: Date.now() - start,
              error: (err as Error).message,
              metadata: prompt.metadata,
            };
          }
        });

        const format = config.outputFormat;
        if (format === 'sharegpt') {
          res.json({
            success: true,
            format,
            data: processor.toShareGPT(results),
          });
        } else if (format === 'jsonl') {
          res.type('text/plain').send(processor.toJSONL(results));
        } else {
          res.json({ success: true, format: 'raw', data: results });
        }

        Logger.info(
          `批处理完成: ${results.filter((r) => r.success).length}/${results.length} 成功`,
          'BatchRoutes'
        );
      } catch (error) {
        Logger.error('批处理路由失败', error as Error, 'BatchRoutes');
        res
          .status(500)
          .json({ success: false, error: (error as Error).message });
      }
    }
  );
}
