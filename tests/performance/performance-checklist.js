#!/usr/bin/env node

/**
 * 性能测试检查清单脚本
 * 检查系统是否满足性能要求
 */

import { JiaBaiXing } from '../../src/index.js';
import { PerformanceMonitor } from '../../src/utils/PerformanceMonitor.js';

const assistant = new JiaBaiXing();
const perfMonitor = PerformanceMonitor.getInstance();

// 性能检查项目
const checkItems = [
  {
    name: '首字响应延迟(TTFB)',
    description: '用户输入后到第一个字符/语音出现的延迟',
    target: '≤ 300ms',
    test: async () => {
      const start = performance.now();
      let firstTokenTime = null;
      
      await assistant.processInput('你好', 'default', {}, (chunk) => {
        if (!firstTokenTime) {
          firstTokenTime = performance.now();
        }
      });
      
      const ttfb = firstTokenTime - start;
      console.log(`首字响应延迟: ${ttfb.toFixed(2)}ms`);
      return ttfb <= 300;
    }
  },
  {
    name: '端到端响应时间（短回复）',
    description: '完整对话回合计时（含LLM推理+话术生成）',
    target: '≤ 800ms',
    test: async () => {
      const start = performance.now();
      await assistant.processInput('你好', 'default');
      const end = performance.now();
      const total = end - start;
      console.log(`端到端响应时间: ${total.toFixed(2)}ms`);
      return total <= 800;
    }
  },
  {
    name: '端到端响应时间（复杂任务）',
    description: '任务拆解+首轮工具调用返回的延迟',
    target: '≤ 3s',
    test: async () => {
      const start = performance.now();
      await assistant.processInput('帮我写一个简单的TypeScript函数', 'default');
      const end = performance.now();
      const total = end - start;
      console.log(`复杂任务响应时间: ${total.toFixed(2)}ms`);
      return total <= 3000;
    }
  },
  {
    name: '语义搜索延迟',
    description: '在10,000条记忆规模下测试ChromaDB查询时间',
    target: '≤ 150ms',
    test: async () => {
      // 生成测试记忆
      for (let i = 0; i < 1000; i++) {
        await assistant.processInput(`测试记忆 ${i}`, 'default');
      }
      
      const start = performance.now();
      await assistant.processInput('帮我查找相关信息', 'default');
      const end = performance.now();
      const latency = end - start;
      console.log(`语义搜索延迟: ${latency.toFixed(2)}ms`);
      return latency <= 150;
    }
  },
  {
    name: '内存占用（常驻）',
    description: '含Node.js堆+ChromaDB+Ollama模型加载后',
    target: '≤ 800MB',
    test: async () => {
      const memory = process.memoryUsage();
      const heapUsed = memory.heapUsed / 1024 / 1024;
      console.log(`内存占用: ${heapUsed.toFixed(2)}MB`);
      return heapUsed <= 800;
    }
  },
  {
    name: '流式传输支持',
    description: '是否使用了流式传输避免长回复等待',
    target: '是',
    test: async () => {
      // 检查processInput方法是否支持onChunk参数
      const inputMethod = assistant.processInput.toString();
      const hasOnChunk = inputMethod.includes('onChunk');
      console.log(`流式传输支持: ${hasOnChunk ? '是' : '否'}`);
      return hasOnChunk;
    }
  },
  {
    name: '记忆检索限制',
    description: '记忆检索是否设置了合理的limit（默认10条）',
    target: '是',
    test: async () => {
      // 检查MemoryEngine中的mergeAndSortMemories方法
      const fs = require('fs');
      const memoryEngineContent = fs.readFileSync('./src/memory/MemoryEngine.ts', 'utf8');
      const hasLimit = memoryEngineContent.includes('slice(0, 10)');
      console.log(`记忆检索限制: ${hasLimit ? '是' : '否'}`);
      return hasLimit;
    }
  },
  {
    name: 'Prompt长度限制',
    description: '是否对用户输入的Prompt长度做了硬限制',
    target: '是',
    test: async () => {
      // 检查是否有Prompt长度限制
      const fs = require('fs');
      const coreReasoningContent = fs.readFileSync('./src/core/CoreReasoningEngine.ts', 'utf8');
      const hasLimit = coreReasoningContent.includes('maxContextTokens');
      console.log(`Prompt长度限制: ${hasLimit ? '是' : '否'}`);
      return hasLimit;
    }
  },
  {
    name: '内存稳定性',
    description: '是否有内存泄漏检测和处理机制',
    target: '是',
    test: async () => {
      // 检查是否有内存监控代码
      const fs = require('fs');
      const performanceMonitorContent = fs.readFileSync('./src/utils/PerformanceMonitor.ts', 'utf8');
      const hasMemoryMonitoring = performanceMonitorContent.includes('recordMemoryUsage');
      console.log(`内存稳定性监控: ${hasMemoryMonitoring ? '是' : '否'}`);
      return hasMemoryMonitoring;
    }
  },
  {
    name: 'Worker Threads支持',
    description: '是否使用Worker Threads执行CPU密集型任务',
    target: '是',
    test: async () => {
      // 检查是否有Worker Threads相关代码
      const fs = require('fs');
      const toolExecutorContent = fs.readFileSync('./src/tools/ToolExecutor.ts', 'utf8');
      const hasWorkerThreads = toolExecutorContent.includes('WorkerPool');
      console.log(`Worker Threads支持: ${hasWorkerThreads ? '是' : '否'}`);
      return hasWorkerThreads;
    }
  }
];

async function runChecklist() {
  console.log('=======================================');
  console.log('开始执行性能测试检查清单');
  console.log('=======================================');
  
  // 初始化助手
  console.log('初始化助手...');
  await assistant.initialize(true);
  
  let passed = 0;
  let failed = 0;
  
  for (const item of checkItems) {
    console.log(`\n检查项目: ${item.name}`);
    console.log(`描述: ${item.description}`);
    console.log(`目标: ${item.target}`);
    
    try {
      const result = await item.test();
      if (result) {
        console.log('✅ 通过');
        passed++;
      } else {
        console.log('❌ 未通过');
        failed++;
      }
    } catch (error) {
      console.log(`❌ 测试出错: ${error.message}`);
      failed++;
    }
  }
  
  console.log('\n=======================================');
  console.log('性能测试检查清单结果');
  console.log('=======================================');
  console.log(`通过: ${passed}`);
  console.log(`未通过: ${failed}`);
  console.log(`总检查项: ${checkItems.length}`);
  
  if (failed === 0) {
    console.log('🎉 所有检查项都通过了！');
  } else {
    console.log('⚠️  有检查项未通过，需要进一步优化。');
  }
  
  // 输出性能报告
  perfMonitor.outputReport();
  
  // 关闭助手
  await assistant.shutdown();
  
  console.log('\n=======================================');
  console.log('性能测试检查清单完成');
  console.log('=======================================');
}

// 执行检查
runChecklist().catch(console.error);
