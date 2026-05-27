#!/usr/bin/env node

/**
 * 内存稳定性监控脚本
 * 监控Node.js进程长时间运行的内存占用曲线，防止OOM
 */

import { performance } from 'perf_hooks';
import { JiaBaiXing } from '../../src/index.js';
import { PerformanceMonitor } from '../../src/utils/PerformanceMonitor.js';

const assistant = new JiaBaiXing();
const perfMonitor = PerformanceMonitor.getInstance();

// 测试配置
const TEST_DURATION = 3600000; // 1小时（毫秒）
const CHECK_INTERVAL = 10000; // 10秒检查一次
const TEST_QUERIES = [
  '帮我写一个简单的TypeScript函数',
  '我有点累了',
  '把刚才的对话总结一下',
  '帮我搜索一下相关信息',
  '计算1+1等于多少'
];

// 内存使用记录
const memoryRecords = [];

// 记录当前内存使用情况
function recordMemoryUsage() {
  const memory = process.memoryUsage();
  const heapUsed = (memory.heapUsed / 1024 / 1024).toFixed(2);
  const heapTotal = (memory.heapTotal / 1024 / 1024).toFixed(2);
  const rss = (memory.rss / 1024 / 1024).toFixed(2);
  
  const record = {
    timestamp: Date.now(),
    heapUsed: parseFloat(heapUsed),
    heapTotal: parseFloat(heapTotal),
    rss: parseFloat(rss)
  };
  
  memoryRecords.push(record);
  perfMonitor.recordMemoryUsage();
  
  console.log(`内存使用: ${heapUsed}MB / ${heapTotal}MB (RSS: ${rss}MB)`);
  
  return record;
}

// 分析内存使用趋势
function analyzeMemoryTrend() {
  if (memoryRecords.length < 2) {
    return {
      trend: 'insufficient_data',
      growthRate: 0
    };
  }
  
  const firstRecord = memoryRecords[0];
  const lastRecord = memoryRecords[memoryRecords.length - 1];
  const timeDiff = (lastRecord.timestamp - firstRecord.timestamp) / 1000 / 60; // 分钟
  const heapGrowth = lastRecord.heapUsed - firstRecord.heapUsed;
  const growthRate = heapGrowth / timeDiff; // MB/分钟
  
  console.log(`内存增长趋势: ${growthRate.toFixed(2)} MB/分钟`);
  
  return {
    trend: growthRate > 1 ? 'growing' : 'stable',
    growthRate
  };
}

// 执行测试查询
async function executeTestQueries() {
  console.log('执行测试查询...');
  
  for (const query of TEST_QUERIES) {
    try {
      await assistant.processInput(query, 'default');
      console.log(`✅ 执行查询: ${query}`);
    } catch (error) {
      console.error(`❌ 执行查询失败: ${error.message}`);
    }
  }
}

async function runMemoryStabilityTest() {
  console.log('=======================================');
  console.log('开始执行内存稳定性监控测试');
  console.log('=======================================');
  console.log(`测试持续时间: ${TEST_DURATION / 1000 / 60} 分钟`);
  console.log(`检查间隔: ${CHECK_INTERVAL / 1000} 秒`);
  
  // 初始化助手
  console.log('\n初始化助手...');
  await assistant.initialize(true);
  
  // 初始内存记录
  console.log('\n初始内存状态:');
  recordMemoryUsage();
  
  const startTime = Date.now();
  let lastQueryTime = Date.now();
  
  console.log('\n开始监控内存使用...');
  
  while (Date.now() - startTime < TEST_DURATION) {
    // 定期执行测试查询
    if (Date.now() - lastQueryTime > 60000) { // 每60秒执行一次查询
      await executeTestQueries();
      lastQueryTime = Date.now();
    }
    
    // 记录内存使用
    recordMemoryUsage();
    
    // 分析内存趋势
    const trend = analyzeMemoryTrend();
    
    // 检查是否有内存泄漏
    if (trend.growthRate > 10) { // 超过10MB/分钟视为内存泄漏
      console.log('⚠️  检测到可能的内存泄漏！');
      console.log(`内存增长速度: ${trend.growthRate.toFixed(2)} MB/分钟`);
    }
    
    // 等待下一次检查
    await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL));
  }
  
  // 测试结束
  console.log('\n=======================================');
  console.log('内存稳定性测试完成');
  console.log('=======================================');
  
  // 分析最终内存状态
  const finalTrend = analyzeMemoryTrend();
  const firstRecord = memoryRecords[0];
  const lastRecord = memoryRecords[memoryRecords.length - 1];
  const totalGrowth = lastRecord.heapUsed - firstRecord.heapUsed;
  
  console.log('\n测试结果:');
  console.log(`初始堆内存: ${firstRecord.heapUsed.toFixed(2)} MB`);
  console.log(`最终堆内存: ${lastRecord.heapUsed.toFixed(2)} MB`);
  console.log(`总内存增长: ${totalGrowth.toFixed(2)} MB`);
  console.log(`平均增长速度: ${finalTrend.growthRate.toFixed(2)} MB/分钟`);
  
  // 检查是否达到目标要求
  if (finalTrend.growthRate <= 0.167) { // 10MB/小时 = 0.167MB/分钟
    console.log('✅ 内存增长符合目标要求（≤ 10MB/小时）');
  } else {
    console.log('❌ 内存增长超过目标要求（≤ 10MB/小时）');
    console.log('建议：检查内存泄漏，优化内存使用');
  }
  
  // 检查内存占用是否在合理范围内
  if (lastRecord.heapUsed <= 800) {
    console.log('✅ 内存占用在合理范围内（≤ 800MB）');
  } else {
    console.log('❌ 内存占用超过合理范围（≤ 800MB）');
    console.log('建议：优化内存使用，考虑使用内存缓存策略');
  }
  
  // 输出性能报告
  perfMonitor.outputReport();
  
  // 生成内存使用趋势报告
  console.log('\n=======================================');
  console.log('内存使用趋势报告');
  console.log('=======================================');
  memoryRecords.forEach((record, index) => {
    if (index % 6 === 0) { // 每6个记录输出一次（1分钟）
      const time = new Date(record.timestamp).toLocaleTimeString();
      console.log(`${time}: ${record.heapUsed.toFixed(2)}MB`);
    }
  });
  
  // 关闭助手
  await assistant.shutdown();
  
  console.log('\n=======================================');
  console.log('内存稳定性测试完成');
  console.log('=======================================');
}

// 执行测试
runMemoryStabilityTest().catch(console.error);
