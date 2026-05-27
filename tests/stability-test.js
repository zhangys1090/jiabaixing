/**
 * 稳定性与性能测试脚本
 * 测试目标：验证系统长期稳定运行，性能符合要求
 */

const fetch = require('node-fetch');

async function runStabilityTests() {
  console.log('⚡ 开始稳定性与性能测试...');
  console.log('============================================================\n');

  const apiUrl = 'http://localhost:3001/api/process';
  let passedTests = 0;
  let totalTests = 0;

  // 测试1: 响应延迟测试
  console.log('1. 响应延迟测试');
  console.log('   测试目标：用户输入后，首次响应延迟<500ms');
  totalTests++;
  try {
    const startTime = Date.now();
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ 
        input: '你好，测试响应速度'
      })
    });
    const data = await response.json();
    const endTime = Date.now();
    const latency = endTime - startTime;
    console.log(`   响应延迟: ${latency}ms`);
    console.log('   响应:', data.response);
    if (latency < 500) {
      console.log('   ✅ 测试通过：响应延迟符合要求');
      passedTests++;
    } else {
      console.log('   ❌ 测试失败：响应延迟超过500ms');
    }
  } catch (error) {
    console.log('   ❌ 测试失败：', error.message);
  }
  console.log('');

  // 测试2: 并发任务测试
  console.log('2. 并发任务测试');
  console.log('   测试目标：同时执行5个并行任务，所有任务正常完成，无阻塞、无报错');
  totalTests++;
  try {
    const tasks = [];
    for (let i = 0; i < 5; i++) {
      tasks.push(
        fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ 
            input: `并发测试任务 ${i+1}`
          })
        })
      );
    }
    
    const startTime = Date.now();
    const responses = await Promise.all(tasks);
    const endTime = Date.now();
    
    console.log(`   并发执行5个任务，总耗时: ${endTime - startTime}ms`);
    
    let allSuccess = true;
    for (let i = 0; i < responses.length; i++) {
      const response = responses[i];
      if (!response.ok) {
        console.log(`   ❌ 任务 ${i+1} 失败，状态码: ${response.status}`);
        allSuccess = false;
      } else {
        const data = await response.json();
        console.log(`   ✅ 任务 ${i+1} 成功`);
      }
    }
    
    if (allSuccess) {
      console.log('   ✅ 测试通过：所有并发任务正常完成');
      passedTests++;
    } else {
      console.log('   ❌ 测试失败：部分并发任务失败');
    }
  } catch (error) {
    console.log('   ❌ 测试失败：', error.message);
  }
  console.log('');

  // 测试3: 重复请求测试
  console.log('3. 重复请求测试');
  console.log('   测试目标：连续发送10个请求，系统无崩溃、无性能下降');
  totalTests++;
  try {
    const responseTimes = [];
    
    for (let i = 0; i < 10; i++) {
      const startTime = Date.now();
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 
          input: `重复测试请求 ${i+1}`
        })
      });
      const data = await response.json();
      const endTime = Date.now();
      const latency = endTime - startTime;
      responseTimes.push(latency);
      console.log(`   请求 ${i+1} 耗时: ${latency}ms`);
    }
    
    // 计算平均响应时间和最大响应时间
    const avgLatency = responseTimes.reduce((sum, time) => sum + time, 0) / responseTimes.length;
    const maxLatency = Math.max(...responseTimes);
    
    console.log(`   平均响应时间: ${avgLatency.toFixed(2)}ms`);
    console.log(`   最大响应时间: ${maxLatency}ms`);
    
    if (maxLatency < 1000) {
      console.log('   ✅ 测试通过：系统在重复请求下表现稳定');
      passedTests++;
    } else {
      console.log('   ❌ 测试失败：系统在重复请求下性能下降');
    }
  } catch (error) {
    console.log('   ❌ 测试失败：', error.message);
  }
  console.log('');

  // 测试结果汇总
  console.log('============================================================');
  console.log('⚡ 稳定性与性能测试结果');
  console.log(`总测试数: ${totalTests}`);
  console.log(`通过测试数: ${passedTests}`);
  console.log(`通过率: ${((passedTests / totalTests) * 100).toFixed(2)}%`);
  
  if (passedTests === totalTests) {
    console.log('🎉 所有稳定性与性能测试用例通过！');
  } else {
    console.log('⚠️  部分测试用例失败，需要进一步检查和优化');
  }
  console.log('============================================================');
}

// 执行测试
runStabilityTests();