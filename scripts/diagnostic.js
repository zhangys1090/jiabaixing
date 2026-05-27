/**
 * 端到端诊断脚本
 * 测试完整链路：WebSocket -> EventBus -> Scheduler -> CoreEngine -> LLM -> 回复
 */

const WebSocket = require('ws');
const http = require('http');

const BACKEND_WS = 'ws://localhost:3111';
const BACKEND_HTTP = 'http://localhost:3111';

console.log('🔍 开始端到端链路诊断...\n');

// Step 1: 检查后端HTTP API
function testHttpApi() {
  return new Promise((resolve) => {
    http.get(`${BACKEND_HTTP}/api/health`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          console.log('✅ [1/5] HTTP健康检查通过');
          console.log(`   状态: ${json.status}`);
          console.log(`   模型: ${json.model}`);
          console.log(`   任务队列: ${json.taskQueueLength}\n`);
          resolve(true);
        } catch {
          console.log('⚠️  [1/5] HTTP健康检查响应异常\n');
          resolve(false);
        }
      });
    }).on('error', (err) => {
      console.log(`❌ [1/5] HTTP健康检查失败: ${err.message}\n`);
      resolve(false);
    });
  });
}

// Step 2: 检查WebSocket连接
function testWebSocket() {
  return new Promise((resolve) => {
    const ws = new WebSocket(BACKEND_WS);
    const timeout = setTimeout(() => {
      console.log('❌ [2/5] WebSocket连接超时\n');
      ws.close();
      resolve(false);
    }, 5000);

    ws.on('open', () => {
      clearTimeout(timeout);
      console.log('✅ [2/5] WebSocket连接成功\n');
      resolve(ws);
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      console.log(`❌ [2/5] WebSocket连接失败: ${err.message}\n`);
      resolve(false);
    });
  });
}

// Step 3: 发送消息并接收回复
function testMessageFlow(ws) {
  return new Promise((resolve) => {
    const testMessage = '你好';
    let received = false;

    const timeout = setTimeout(() => {
      if (!received) {
        console.log('⚠️  [3/5] 发送消息后10秒未收到回复');
        console.log('   可能堵点：LLM调用超时 或 任务队列阻塞\n');
        resolve(false);
      }
    }, 15000);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'response' || msg.data?.response) {
          received = true;
          clearTimeout(timeout);
          const response = msg.data?.response || msg.payload?.response || msg.response;
          console.log('✅ [3/5] 收到后端回复！');
          console.log(`   回复内容: ${String(response).substring(0, 100)}\n`);
          resolve(true);
        } else if (msg.type === 'error') {
          received = true;
          clearTimeout(timeout);
          console.log('⚠️  [3/5] 收到错误响应');
          console.log(`   错误信息: ${JSON.stringify(msg.data)}\n`);
          resolve(false);
        }
      } catch {
        // 忽略解析错误的消息
      }
    });

    console.log('📤 [3/5] 发送测试消息:', testMessage);
    ws.send(JSON.stringify({
      type: 'user_input',
      data: {
        input: testMessage,
        userId: 'diagnostic_test'
      }
    }));
  });
}

// Step 4: 检查Qwen服务可用性
function testQwenService() {
  return new Promise((resolve) => {
    const options = {
      hostname: '127.0.0.1',
      port: 8001,
      path: '/v1/models',
      method: 'GET',
      timeout: 5000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const modelName = json.models?.[0]?.name || '未知';
          console.log('✅ [4/5] Qwen服务可用');
          console.log(`   模型名称: ${modelName}\n`);
          resolve(true);
        } catch {
          console.log('⚠️  [4/5] Qwen服务响应异常\n');
          resolve(false);
        }
      });
    });

    req.on('error', (err) => {
      console.log(`❌ [4/5] Qwen服务不可达: ${err.message}\n`);
      resolve(false);
    });

    req.on('timeout', () => {
      req.destroy();
      console.log('❌ [4/5] Qwen服务超时\n');
      resolve(false);
    });

    req.end();
  });
}

// Step 5: 检查SSE日志端点
function testSseEndpoint() {
  return new Promise((resolve) => {
    http.get(`${BACKEND_HTTP}/api/logs`, (res) => {
      const contentType = res.headers['content-type'] || '';
      if (contentType.includes('text/event-stream')) {
        console.log('✅ [5/5] SSE日志端点正常\n');
        res.destroy();
        resolve(true);
      } else {
        console.log('⚠️  [5/5] SSE日志端点响应类型不正确\n');
        resolve(false);
      }
    }).on('error', () => {
      console.log('❌ [5/5] SSE日志端点不可达\n');
      resolve(false);
    });
  });
}

// 运行诊断
async function runDiagnostics() {
  try {
    const httpOk = await testHttpApi();
    if (!httpOk) {
      console.log('🛑 后端未启动，中止诊断');
      process.exit(1);
    }

    const wsOrFalse = await testWebSocket();
    if (!wsOrFalse) {
      console.log('🛑 WebSocket连接失败，中止诊断');
      process.exit(1);
    }

    const ws = wsOrFalse;
    const messageOk = await testMessageFlow(ws);
    
    await testQwenService();
    await testSseEndpoint();

    console.log('═══════════════════════════════════════');
    console.log('📊 诊断结果汇总');
    console.log('═══════════════════════════════════════');
    console.log(`HTTP API: ${httpOk ? '✅ 正常' : '❌ 异常'}`);
    console.log(`WebSocket: ${ws ? '✅ 正常' : '❌ 异常'}`);
    console.log(`消息流程: ${messageOk ? '✅ 正常' : '⚠️  有问题'}`);
    console.log('═══════════════════════════════════════');
    
    if (messageOk) {
      console.log('🎉 端到端链路已完全打通！');
    } else {
      console.log('⚠️  链路存在问题，请检查上方日志');
    }

    if (ws && typeof ws.close === 'function') {
      ws.close();
    }
    process.exit(0);
  } catch (err) {
    console.error('诊断异常:', err);
    process.exit(1);
  }
}

runDiagnostics();
