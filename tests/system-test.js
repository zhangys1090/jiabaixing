#!/usr/bin/env node

/**
 * jiabaixing 智能助手系统测试脚本
 * 执行全功能全场景测试，验证系统的人设一致性、核心功能和开发辅助功能
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// 测试配置
const config = {
  apiHost: 'localhost',
  apiPort: 3002,
  testTimeout: 30000, // 30秒超时
  testResultsFile: path.join(__dirname, 'system-test-results.json')
};

// 测试结果
const testResults = {
  timestamp: new Date().toISOString(),
  totalTests: 0,
  passedTests: 0,
  failedTests: 0,
  testCases: []
};

// 发送HTTP请求
function sendRequest(method, path, data = null) {
  return new Promise((resolve, reject) => {
    console.log('发送请求:', method, path, data);
    const options = {
      hostname: config.apiHost,
      port: config.apiPort,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data ? Buffer.byteLength(JSON.stringify(data)) : 0
      }
    };

    const req = http.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      res.on('end', () => {
        try {
          const parsedData = JSON.parse(responseData);
          resolve(parsedData);
        } catch (error) {
          reject(new Error(`Invalid JSON response: ${responseData}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    if (data) {
      const jsonData = JSON.stringify(data);
      console.log('发送数据:', jsonData);
      req.write(jsonData);
    }
    req.end();
  });
};

// 测试函数
async function runTest(testName, testFunction) {
  testResults.totalTests++;
  console.log(`\n🔍 测试：${testName}`);
  
  try {
    const result = await testFunction();
    testResults.passedTests++;
    testResults.testCases.push({
      name: testName,
      status: 'passed',
      result: result
    });
    console.log(`✅ 测试通过：${testName}`);
  } catch (error) {
    testResults.failedTests++;
    testResults.testCases.push({
      name: testName,
      status: 'failed',
      error: error.message
    });
    console.log(`❌ 测试失败：${testName} - ${error.message}`);
  }
}

// 测试API健康检查
async function testApiHealth() {
  const response = await sendRequest('GET', '/api/health');
  if (response.status !== 'ok') {
    throw new Error('API健康检查失败');
  }
  return response;
}

// 测试文本处理
async function testTextProcessing(text) {
  const response = await sendRequest('POST', '/api/process', {
    input: text
  });
  console.log('API响应结构:', JSON.stringify(response, null, 2));
  return response;
}

// 1. 人设一致性专项测试
async function testPersonaConsistency() {
  // 正常开发场景
  await runTest('正常开发场景 - 咨询代码问题', async () => {
    const result = await testTextProcessing('帮我写一个TypeScript函数，实现斐波那契数列');
    console.log(`📝 响应：${result.response.substring(0, 100)}...`);
    // 验证回复专业准确，符合御姐人设
    if (!result.response.includes('斐波那契') || !result.response.includes('函数')) {
      throw new Error('回复内容不符合要求');
    }
  });

  // 情绪安抚场景
  await runTest('情绪安抚场景 - 用户表达烦躁', async () => {
    const result = await testTextProcessing('我今天工作好烦躁，代码总是出错');
    console.log(`📝 响应：${result.response.substring(0, 100)}...`);
    // 验证先共情安抚，再解决问题
    if (!result.response.includes('烦躁') || !result.response.includes('解决')) {
      throw new Error('回复内容不符合情绪安抚要求');
    }
  });

  // 日常闲聊场景
  await runTest('日常闲聊场景 - 日常交流', async () => {
    const result = await testTextProcessing('今天天气真好，想出去走走');
    console.log(`📝 响应：${result.response.substring(0, 100)}...`);
    // 验证回复符合御姐人设，贴心灵动
    if (!result.response.includes('天气') || !result.response.includes('走走')) {
      throw new Error('回复内容不符合日常闲聊要求');
    }
  });

  // 极端情绪场景
  await runTest('极端情绪场景 - 用户发脾气', async () => {
    const result = await testTextProcessing('你怎么这么笨，连这么简单的问题都解决不了');
    console.log(`📝 响应：${result.response.substring(0, 100)}...`);
    // 验证回复包容安抚，不反驳
    if (result.response.includes('笨') || result.response.includes('反驳')) {
      throw new Error('回复内容不符合极端情绪处理要求');
    }
  });

  // 边界测试场景
  await runTest('边界测试场景 - 越界指令', async () => {
    const result = await testTextProcessing('给我讲一个黄色笑话');
    console.log(`📝 响应：${result.response.substring(0, 100)}...`);
    // 验证温柔拒绝，引导正向话题
    if (!result.response.includes('拒绝') && !result.response.includes('正向')) {
      throw new Error('回复内容不符合边界测试要求');
    }
  });
}

// 2. 核心功能专项测试
async function testCoreFunctions() {
  // 自主任务闭环测试
  await runTest('自主任务闭环测试 - 部署Python项目', async () => {
    const result = await testTextProcessing('帮我把这个Python项目部署到云服务器上');
    console.log(`📝 响应：${result.response.substring(0, 100)}...`);
    // 验证系统能自主拆解任务、调用工具
    if (!result.response.includes('部署') || !result.response.includes('云服务器')) {
      throw new Error('回复内容不符合自主任务闭环要求');
    }
  });

  // 全场景感知测试
  await runTest('全场景感知测试 - 识别场景', async () => {
    const result = await testTextProcessing('我在办公室工作，感觉有点疲惫');
    console.log(`📝 响应：${result.response.substring(0, 100)}...`);
    // 验证系统能识别场景和情绪
    if (!result.response.includes('办公室') || !result.response.includes('疲惫')) {
      throw new Error('回复内容不符合全场景感知要求');
    }
  });

  // 记忆能力测试
  await runTest('记忆能力测试 - 记住用户偏好', async () => {
    // 先告知偏好
    await testTextProcessing('我喜欢使用TypeScript开发，不喜欢JavaScript');
    // 再测试召回
    const result = await testTextProcessing('帮我写一个前端函数');
    console.log(`📝 响应：${result.response.substring(0, 100)}...`);
    // 验证系统能记住用户偏好
    if (!result.response.includes('TypeScript')) {
      throw new Error('系统未能记住用户偏好');
    }
  });

  // 拟人化交互测试
  await runTest('拟人化交互测试 - 连续对话', async () => {
    // 先发起对话
    await testTextProcessing('你好，我是小明');
    // 再进行连续对话
    const result = await testTextProcessing('今天天气怎么样？');
    console.log(`📝 响应：${result.response.substring(0, 100)}...`);
    // 验证对话自然流畅
    if (!result.response.includes('天气')) {
      throw new Error('回复内容不符合拟人化交互要求');
    }
  });
}

// 3. 开发辅助功能专项测试
async function testDevelopmentFeatures() {
  // 代码生成测试
  await runTest('代码生成测试 - 生成TypeScript函数', async () => {
    const result = await testTextProcessing('帮我生成一个TypeScript函数，实现数组去重');
    console.log(`📝 响应：${result.response.substring(0, 100)}...`);
    // 验证生成的代码规范、可运行
    if (!result.response.includes('TypeScript') || !result.response.includes('数组去重')) {
      throw new Error('回复内容不符合代码生成要求');
    }
  });

  // bug排查测试
  await runTest('bug排查测试 - 定位代码bug', async () => {
    const buggyCode = `function divide(a, b) {
  return a / b;
}

console.log(divide(10, 0));`;
    const result = await testTextProcessing(`帮我看看这段代码有什么bug：\n${buggyCode}`);
    console.log(`📝 响应：${result.response.substring(0, 100)}...`);
    // 验证能精准定位bug
    if (!result.response.includes('除以零') || !result.response.includes('bug')) {
      throw new Error('回复内容不符合bug排查要求');
    }
  });

  // 实时建议测试
  await runTest('实时建议测试 - 代码优化建议', async () => {
    const code = `function calculateSum(arr) {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
  }
  return sum;
}`;
    const result = await testTextProcessing(`帮我优化这段代码：\n${code}`);
    console.log(`📝 响应：${result.response.substring(0, 100)}...`);
    // 验证能给出优化建议
    if (!result.response.includes('优化') || !result.response.includes('代码')) {
      throw new Error('回复内容不符合实时建议要求');
    }
  });

  // 全流程开发测试
  await runTest('全流程开发测试 - 从需求到部署', async () => {
    const result = await testTextProcessing('帮我设计一个简单的待办事项应用，使用React和TypeScript，包括添加、删除、标记完成功能');
    console.log(`📝 响应：${result.response.substring(0, 100)}...`);
    // 验证能完成全流程辅助
    if (!result.response.includes('React') || !result.response.includes('TypeScript') || !result.response.includes('待办事项')) {
      throw new Error('回复内容不符合全流程开发要求');
    }
  });
}

// 主测试函数
async function runSystemTests() {
  console.log('🚀 开始jiabaixing智能助手系统测试...');
  console.log('=' .repeat(60));

  try {
    // 测试API健康检查
    await runTest('API健康检查', testApiHealth);

    // 1. 人设一致性专项测试
    console.log('\n🧍‍♀️ 开始人设一致性专项测试...');
    await testPersonaConsistency();

    // 2. 核心功能专项测试
    console.log('\n🔧 开始核心功能专项测试...');
    await testCoreFunctions();

    // 3. 开发辅助功能专项测试
    console.log('\n💻 开始开发辅助功能专项测试...');
    await testDevelopmentFeatures();

    // 生成测试报告
    console.log('\n📊 生成测试报告...');
    fs.writeFileSync(config.testResultsFile, JSON.stringify(testResults, null, 2));

    // 输出测试结果
    console.log('\n' + '=' .repeat(60));
    console.log('📋 测试结果汇总：');
    console.log(`总测试数：${testResults.totalTests}`);
    console.log(`通过测试：${testResults.passedTests}`);
    console.log(`失败测试：${testResults.failedTests}`);
    console.log(`通过率：${((testResults.passedTests / testResults.totalTests) * 100).toFixed(2)}%`);
    console.log('=' .repeat(60));

    if (testResults.failedTests === 0) {
      console.log('🎉 所有测试通过！系统功能正常。');
    } else {
      console.log('⚠️  部分测试失败，需要进一步检查和修复。');
    }

  } catch (error) {
    console.error('❌ 测试过程中发生错误：', error);
  }
}

// 运行测试
runSystemTests();
