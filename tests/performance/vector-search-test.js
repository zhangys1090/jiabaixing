#!/usr/bin/env node

/**
 * 向量检索延迟测试脚本
 * 测量ChromaDB在不同记忆规模下的语义搜索速度
 */

import { performance } from 'perf_hooks';
import { JiaBaiXing } from '../../src/index.js';
import { PerformanceMonitor } from '../../src/utils/PerformanceMonitor.js';

const assistant = new JiaBaiXing();
const perfMonitor = PerformanceMonitor.getInstance();

// 测试规模
const testScales = [
  { name: '小规模', count: 1000 },
  { name: '中规模', count: 5000 },
  { name: '大规模', count: 10000 }
];

// 测试查询
const testQueries = [
  '帮我写一个TypeScript函数',
  '我想学习React',
  '如何优化代码性能',
  '今天天气怎么样',
  '帮我设置一个提醒'
];

// 生成测试记忆内容
function generateTestMemoryContent(index) {
  const topics = [
    '编程', '技术', '学习', '生活', '工作',
    '健康', '娱乐', '旅行', '美食', '运动'
  ];
  const topic = topics[index % topics.length];
  
  return `这是关于${topic}的测试记忆 ${index}，包含一些相关信息和内容。`;
}

async function generateTestMemories(count) {
  console.log(`生成 ${count} 条测试记忆...`);
  
  for (let i = 0; i < count; i++) {
    const content = generateTestMemoryContent(i);
    await assistant.processInput(content, 'default');
    
    if ((i + 1) % 1000 === 0) {
      console.log(`已生成 ${i + 1} 条记忆`);
    }
  }
  
  console.log(`✅ 完成生成 ${count} 条测试记忆`);
}

async function measureVectorSearchLatency(query) {
  const start = performance.now();
  
  try {
    // 调用processInput来触发记忆检索
    await assistant.processInput(query, 'default');
    
    const end = performance.now();
    const latency = end - start;
    
    // 记录向量检索延迟
    perfMonitor.recordVectorSearchLatency(latency);
    
    console.log(`[${query}] 向量检索延迟: ${latency.toFixed(2)}ms`);
    
    return latency;
  } catch (error) {
    console.error(`测试出错: ${error.message}`);
    return -1;
  }
}

async function runVectorSearchTest() {
  console.log('=======================================');
  console.log('开始执行向量检索延迟测试');
  console.log('=======================================');
  
  // 初始化助手
  console.log('初始化助手...');
  await assistant.initialize(true);
  
  for (const scale of testScales) {
    console.log(`\n=======================================`);
    console.log(`测试 ${scale.name} (${scale.count} 条记忆)`);
    console.log(`=======================================`);
    
    // 生成测试记忆
    await generateTestMemories(scale.count);
    
    // 测试查询
    console.log('\n执行向量检索测试...');
    const latencies = [];
    
    for (const query of testQueries) {
      console.log(`\n测试查询: ${query}`);
      const latency = await measureVectorSearchLatency(query);
      if (latency > 0) {
        latencies.push(latency);
      }
    }
    
    // 计算统计值
    if (latencies.length > 0) {
      const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      const maxLatency = Math.max(...latencies);
      const minLatency = Math.min(...latencies);
      
      console.log('\n=======================================');
      console.log(`${scale.name} 测试结果`);
      console.log('=======================================');
      console.log(`平均检索延迟: ${avgLatency.toFixed(2)}ms`);
      console.log(`最大检索延迟: ${maxLatency.toFixed(2)}ms`);
      console.log(`最小检索延迟: ${minLatency.toFixed(2)}ms`);
      
      // 检查是否达到目标值
      if (avgLatency <= 150) {
        console.log('✅ 平均检索延迟达到目标要求（≤ 150ms）');
      } else {
        console.log('❌ 平均检索延迟未达到目标要求（≤ 150ms）');
        console.log('建议：启用HNSW索引参数调优，或考虑使用更高效的向量数据库');
      }
    } else {
      console.log('\n❌ 没有有效测试结果');
    }
  }
  
  // 输出性能报告
  perfMonitor.outputReport();
  
  // 关闭助手
  await assistant.shutdown();
  
  console.log('\n=======================================');
  console.log('向量检索延迟测试完成');
  console.log('=======================================');
}

// 执行测试
runVectorSearchTest().catch(console.error);
