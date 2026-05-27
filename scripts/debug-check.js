/**
 * jiabaixing 调试检查脚本
 * 由 Claude 生成，跑在 jiabaixing 项目环境里
 * 用法：node scripts/debug-check.js
 */

const http = require('http');

const BASE = 'http://localhost:3111';
const results = [];

function check(label, pass, detail) {
  results.push({ label, pass, detail });
  const icon = pass ? '✅' : '❌';
  console.log(`  ${icon} ${label}: ${detail}`);
}

function fetchUrl(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', (e) => resolve({ status: 0, data: e.message }));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve({ status: 0, data: 'TIMEOUT' });
    });
  });
}

async function main() {
  console.log('═'.repeat(48));
  console.log('  🔍 jiabaixing 调试检查');
  console.log('═'.repeat(48));
  console.log(`  时间: ${new Date().toLocaleString()}`);
  console.log('');

  // 1. 健康检查
  console.log('── 后端服务 ──');
  const health = await fetchUrl(`${BASE}/api/health`);
  check(
    'Health API',
    health.status === 200,
    `HTTP ${health.status} ${health.status === 200 ? health.data.substring(0, 80) : health.data}`
  );

  // 2. 处理 API
  console.log('── API Process ──');
  const body = JSON.stringify({ input: '你好' });
  const proc = await new Promise((resolve) => {
    const req = http.request(
      `${BASE}/api/process`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, data }));
      }
    );
    req.on('error', (e) => resolve({ status: 0, data: e.message }));
    req.setTimeout(15000, () => {
      req.destroy();
      resolve({ status: 0, data: 'TIMEOUT (15s) - LLM 可能没启动' });
    });
    req.write(body);
    req.end();
  });

  if (proc.status === 200) {
    try {
      const json = JSON.parse(proc.data);
      const response = json?.data?.response || json?.response || '(no response field)';
      check('Process API', true, `返回: "${response.substring(0, 80)}"`);
    } catch {
      check('Process API', proc.status === 200, `HTTP 200 但解析失败: ${proc.data.substring(0, 100)}`);
    }
  } else {
    check('Process API', false, `HTTP ${proc.status}: ${proc.data.substring(0, 100)}`);
  }

  // 3. 技能列表
  console.log('── 技能系统 ──');
  const skills = await fetchUrl(`${BASE}/api/skills/list`);
  if (skills.status === 200) {
    try {
      const data = JSON.parse(skills.data);
      const skillNames = data?.skills || data?.data || [];
      const count = Array.isArray(skillNames) ? skillNames.length : (typeof skillNames === 'object' ? Object.keys(skillNames).length : '?');
      check('Skill List API', true, `HTTP 200, 技能数量: ${count}`);
    } catch {
      check('Skill List API', true, `HTTP 200, 响应: ${skills.data.substring(0, 80)}`);
    }
  } else {
    check('Skill List API', false, `HTTP ${skills.status}`);
  }

  // 4. Playwright 检查
  console.log('── 依赖检查 ──');
  try {
    const pw = require('playwright');
    check('Playwright 模块', true, `版本: ${pw ? '已加载' : '未知'}`);
  } catch (e) {
    check('Playwright 模块', false, e.message.substring(0, 60));
  }

  try {
    require('node-fetch');
    check('node-fetch 模块', true, '已加载');
  } catch (e) {
    check('node-fetch 模块', false, e.message.substring(0, 60));
  }

  // 5. 总结
  console.log('');
  console.log('═'.repeat(48));
  const passed = results.filter((r) => r.pass).length;
  console.log(`  总结果: ${passed}/${results.length} 通过`);
  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.log('');
    console.log('  ❌ 失败的检查:');
    for (const f of failed) {
      console.log(`     - ${f.label}: ${f.detail}`);
    }
  }
  console.log('═'.repeat(48));
}

main().catch(console.error);
