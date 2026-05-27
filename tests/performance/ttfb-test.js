#!/usr/bin/env node

/**
 * 首字响应延迟(TTFB)测试脚本
 * 测量用户输入后到第一个字符/语音出现的延迟
 */

import { performance } from 'perf_hooks';
import { JiaBaiXing } from '../../src/index.js';
import { PerformanceMonitor } from '../../src/utils/PerformanceMonitor.js';

const assistant = new JiaBaiXing();
const perfMonitor = PerformanceMonitor.getInstance();

const testQueries = [
  '帮我看看这段代码：const a = 1;',
  '我有点累了',
  '把刚才的对话总结一下',
  '帮我写一个简单的TypeScript函数',
  '计算1+1等于多少'
];

async function measureTTFB(query) {
  const start = performance.now();
  let firstTokenTime = null;
  
  try {
    const response = await assistant.processInput(query, 'default', {}, (chunk) => {
      if (!firstTokenTime) {
        firstTokenTime = performance.now();
        perfMonitor.recordTTFB(start, firstTokenTime);
        console.log(`[${query}] 首字出现时间: ${(firstTokenTime - start).toFixed(2)}ms`);
      }
    });
    
    const end = performance.now();
    return {
      query,
      ttfb: firstTokenTime - start,
      total: end - start,
      responseLength: response ? response.length : 0
    };
  } catch (error) {
    console.error(`测试出错: ${error.message}`);
    return {
      query,
      ttfb: -1,
      total: -1,
      responseLength: 0
    };
  }
}

async function runTTFBTest() {
  console.log('=======================================');
  console.log('开始执行首字响应延迟(TTFB)测试');
  console.log('=======================================');
  
  // 初始化助手
  console.log('初始化助手...');
  await assistant.initialize(true);
  
  // 预热
  console.log('预热中...');
  await measureTTFB('你好');
  
  // 正式测试
  console.log('\n正式测试开始...');
  const results = [];
  
  for (const q of testQueries) {
    console.log(`\n测试查询: ${q}`);
    const result = await measureTTFB(q);
    results.push(result);
    console.log(`结果: TTFB=${result.ttfb.toFixed(2)}ms, 总耗时=${result.total.toFixed(2)}ms, 响应长度=${result.responseLength}`);
  }
  
  // 计算统计值
  const validResults = results.filter(r => r.ttfb > 0);
  if (validResults.length > 0) {
    const avgTTFB = validResults.reduce((a, b) => a + b.ttfb, 0) / validResults.length;
    const maxTTFB = Math.max(...validResults.map(r => r.ttfb));
    const minTTFB = Math.min(...validResults.map(r => r.ttfb));
    
    console.log('\n=======================================');
    console.log('测试结果统计');
    console.log('=======================================');
    console.log(`平均TTFB: ${avgTTFB.toFixed(2)}ms`);
    console.log(`最大TTFB: ${maxTTFB.toFixed(2)}ms`);
    console.log(`最小TTFB: ${minTTFB.toFixed(2)}ms`);
    
    // 检查是否达到目标值
    if (avgTTFB <= 300) {
      console.log('✅ 平均TTFB达到目标要求（≤ 300ms）');
    } else {
      console.log('❌ 平均TTFB未达到目标要求（≤ 300ms）');
    }
    
    if (maxTTFB <= 500) {
      console.log('✅ 最大TTFB达到目标要求（≤ 500ms）');
    } else {
      console.log('❌ 最大TTFB未达到目标要求（≤ 500ms）');
    }
  } else {
    console.log('\n❌ 没有有效测试结果');
  }
  
  // 输出性能报告
  perfMonitor.outputReport();
  
  // 关闭助手
  await assistant.shutdown();
  
  console.log('\n=======================================');
  console.log('TTFB测试完成');
  console.log('=======================================');
}

// 执行测试
runTTFBTest().catch(console.error);
