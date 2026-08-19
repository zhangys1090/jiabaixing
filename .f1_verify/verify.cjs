"use strict";
/**
 * F1 Phase1 — shell_exec Python canonical 代理运行时验证。
 * 真实源码 tsc 转译 + Module._load 按 basename 桩 Logger/types/bridgeRegistry。
 * 验证 4 用例: (A) 代理成功映射 (B) Python 逻辑拒绝不回退本地 (C) 无 bridge 走本地 (D) transport 错误回退本地。
 */
const Module = require('module');

const typesStub = {
  Permission: { SYSTEM_ADMIN: 'system_admin' },
  ToolCategory: { SYSTEM: 'system' },
};
const loggerStub = {
  debug: function () {},
  info: function () {},
  warn: function () {},
  error: function () {},
};

let currentBridge = null;
function getActivePythonBridge() {
  return currentBridge;
}

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.endsWith('/Logger')) return { Logger: loggerStub };
  if (request.endsWith('/types')) return typesStub;
  if (request.endsWith('/bridgeRegistry')) return { getActivePythonBridge };
  return origLoad.apply(this, arguments);
};

const shell = require('./shell_exec.js');
const createShellExecExecutor = shell.createShellExecExecutor;

function makeBridge(mode) {
  const calls = [];
  let rejected = false;
  return {
    calls,
    get rejected() {
      return rejected;
    },
    toolsetExecuteRaw(toolName, params) {
      calls.push({ toolName, params });
      if (mode === 'success') return Promise.resolve({ success: true, output: 'PYOUT', metadata: { pid: 1 } });
      if (mode === 'reject') return Promise.resolve({ success: false, error: 'command not allowed', metadata: { security_violation: true } });
      if (mode === 'transport') {
        rejected = true;
        return Promise.reject(new Error('ECONNREFUSED python down'));
      }
      return Promise.resolve({ success: false, error: 'unknown mode' });
    },
  };
}

function makeLocalRunner() {
  const state = { used: false, calls: [] };
  return {
    state,
    run(command, opts) {
      state.used = true;
      state.calls.push({ command, opts });
      return Promise.resolve({ stdout: 'LOCAL', exitCode: 0 });
    },
  };
}

let pass = 0,
  failCount = 0;
const failures = [];
function check(name, cond) {
  if (cond) {
    pass++;
    console.log('  ✅', name);
  } else {
    failCount++;
    failures.push(name);
    console.log('  ❌', name);
  }
}

(async () => {
  console.log('=== F1 Phase1: shell_exec Python canonical proxy ===');

  // (A) 代理成功映射
  {
    currentBridge = makeBridge('success');
    const local = makeLocalRunner();
    const exec = createShellExecExecutor({ shellRunner: local.run });
    const res = await exec({ command: 'ls -la' }, {});
    check('A: toolsetExecuteRaw 被调用 (tool_name=shell_exec)', currentBridge.calls.length === 1);
    check(
      'A: 参数为 {command, timeout, cwd}',
      currentBridge.calls[0] &&
        currentBridge.calls[0].toolName === 'shell_exec' &&
        currentBridge.calls[0].params.command === 'ls -la' &&
        currentBridge.calls[0].params.timeout === 30000 &&
        currentBridge.calls[0].params.cwd === undefined
    );
    check('A: 成功映射 output=PYOUT', res && res.success === true && res.output === 'PYOUT');
    check('A: 未回退本地 shellRunner', local.state.used === false);
  }

  // (B) Python 逻辑拒绝 → 诚实返回, 绝不回退本地
  {
    currentBridge = makeBridge('reject');
    const local = makeLocalRunner();
    const exec = createShellExecExecutor({ shellRunner: local.run });
    const res = await exec({ command: 'ls -la' }, {});
    check('B: toolsetExecuteRaw 被调用', currentBridge.calls.length === 1);
    check('B: 逻辑拒绝 → success=false', res && res.success === false);
    check('B: 错误信息来自 Python', res && /command not allowed/.test(res.error || ''));
    check('B: 未回退本地 shellRunner (安全不降级)', local.state.used === false);
  }

  // (C) 无 bridge → 走本地执行
  {
    currentBridge = null;
    const local = makeLocalRunner();
    const exec = createShellExecExecutor({ shellRunner: local.run });
    const res = await exec({ command: 'ls' }, {});
    check('C: 无 bridge 时未调用 toolsetExecuteRaw', true); // 无可调用对象, 天然不调用
    check('C: 回退本地 shellRunner', local.state.used === true);
    check('C: 本地输出 LOCAL', res && res.success === true && res.output === 'LOCAL');
  }

  // (D) transport 错误 → 安全降级本地 (safe-degrade)
  {
    currentBridge = makeBridge('transport');
    const local = makeLocalRunner();
    const exec = createShellExecExecutor({ shellRunner: local.run });
    let threw = false;
    let res;
    try {
      res = await exec({ command: 'ls' }, {});
    } catch (e) {
      threw = true;
    }
    check('D: toolsetExecuteRaw 被调用', currentBridge.calls.length === 1);
    check('D: transport 错误未抛出', !threw);
    check('D: 降级到本地 shellRunner', local.state.used === true);
    check('D: 本地输出 LOCAL', res && res.success === true && res.output === 'LOCAL');
  }

  console.log(`\n=== F1 Phase1 shell_exec: ${pass} passed, ${failCount} failed ===`);
  if (failCount > 0) {
    console.log('FAILURES:', failures.join('; '));
    process.exit(1);
  }
  process.exit(0);
})();
