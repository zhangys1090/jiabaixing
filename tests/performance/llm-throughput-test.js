#!/usr/bin/env node

/**
 * LLM推理吞吐量测试脚本
 * 测量本地模型（Ollama）的token生成速度
 */

import { performance } from 'perf_hooks';
import { JiaBaiXing } from '../../src/index.js';
import { PerformanceMonitor } from '../../src/utils/PerformanceMonitor.js';

const assistant = new JiaBaiXing();
const perfMonitor = PerformanceMonitor.getInstance();

// 测试用例：不同长度的输入
const testCases = [
  {
    name: '短输入',
    input: '你好',
    expectedTokens: 10
  },
  {
    name: '中等输入',
    input: '帮我写一个简单的TypeScript函数，计算两个数的和',
    expectedTokens: 50
  },
  {
    name: '长输入',
    input: '帮我设计一个完整的React组件，包含状态管理、表单处理和API调用，需要使用TypeScript类型注解，并且要考虑性能优化和代码可读性',
    expectedTokens: 100
  }
];

// 估算token数的简单函数
function estimateTokens(text) {
  // 粗略估算：1个中文词≈1个token，1个英文单词≈1.3个token
  const chineseChars = text.match(/[\u4e00-\u9fa5]/g)?.length || 0;
  const englishWords = text.match(/\b[a-zA-Z]+\b/g)?.length || 0;
  return chineseChars + Math.ceil(englishWords * 1.3);
}

async function measureLLMThroughput(testCase) {
  const start = performance.now();
  let tokenCount = 0;
  let lastChunkTime = start;
  
  try {
    const response = await assistant.processInput(testCase.input, 'default', {}, (chunk) => {
      const currentTime = performance.now();
      // 每个字符算一个token（粗略估算）
      tokenCount++;
      lastChunkTime = currentTime;
    });
    
    const end = performance.now();
    const duration = end - start;
    const throughput = (tokenCount / (duration / 1000)).toFixed(2);
    
    // 记录吞吐量
    perfMonitor.recordLLMThroughput(tokenCount, duration);
    
    console.log(`[${testCase.name}] 生成 ${tokenCount} 个token，耗时 ${duration.toFixed(2)}ms，吞吐量 ${throughput} tokens/s`);
    
    return {
      name: testCase.name,
      input: testCase.input,
      inputTokens: estimateTokens(testCase.input),
      outputTokens: tokenCount,
      duration: duration,
      throughput: parseFloat(throughput)
    };
  } catch (error) {
    console.error(`测试出错: ${error.message}`);
    return {
      name: testCase.name,
      input: testCase.input,
      inputTokens: estimateTokens(testCase.input),
      outputTokens: 0,
      duration: 0,
      throughput: 0
    };
  }
}

async function runLLMThroughputTest() {
  console.log('=======================================');
  console.log('开始执行LLM推理吞吐量测试');
  console.log('=======================================');
  
  // 初始化助手
  console.log('初始化助手...');
  await assistant.initialize(true);
  
  // 预热
  console.log('预热中...');
  await measureLLMThroughput({ name: '预热', input: '你好', expectedTokens: 10 });
  
  // 正式测试
  console.log('\n正式测试开始...');
  const results = [];
  
  for (const testCase of testCases) {
    console.log(`\n测试: ${testCase.name}`);
    const result = await measureLLMThroughput(testCase);
    results.push(result);
  }
  
  // 计算统计值
  const validResults = results.filter(r => r.throughput > 0);
  if (validResults.length > 0) {
    const avgThroughput = validResults.reduce((a, b) => a + b.throughput, 0) / validResults.length;
    const maxThroughput = Math.max(...validResults.map(r => r.throughput));
    const minThroughput = Math.min(...validResults.map(r => r.throughput));
    
    console.log('\n=======================================');
    console.log('测试结果统计');
    console.log('=======================================');
    console.log(`平均吞吐量: ${avgThroughput.toFixed(2)} tokens/s`);
    console.log(`最大吞吐量: ${maxThroughput.toFixed(2)} tokens/s`);
    console.log(`最小吞吐量: ${minThroughput.toFixed(2)} tokens/s`);
    
    // 检查是否达到目标值
    if (avgThroughput >= 20) {
      console.log('✅ 平均吞吐量达到目标要求（≥ 20 tokens/s）');
    } else {
      console.log('❌ 平均吞吐量未达到目标要求（≥ 20 tokens/s）');
      console.log('建议：切换更小的模型（如phi3:mini）或启用GPU加速');
    }
  } else {
    console.log('\n❌ 没有有效测试结果');
  }
  
  // 输出性能报告
  perfMonitor.outputReport();
  
  // 关闭助手
  await assistant.shutdown();
  
  console.log('\n=======================================');
  console.log('LLM吞吐量测试完成');
  console.log('=======================================');
}

// 执行测试
runLLMThroughputTest().catch(console.error);
