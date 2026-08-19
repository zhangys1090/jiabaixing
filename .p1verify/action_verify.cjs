// Runtime verification for P1-2 unified Action abstraction.
// Stubs heavy real modules (Logger, bridgeRegistry, DesktopActionExecutor)
// via Module._load, then exercises the transpiled action package.
const path = require('path');
const Module = require('module');

const OUT = path.resolve('.p1out');

// ---- stub heavy modules referenced at runtime by the action package ----
function FakeExecutor() {}
FakeExecutor.prototype.executeAction = async function (action) {
  return { success: true, action, output: 'desktop-ok', observation: null };
};
FakeExecutor.getInstance = function () {
  return new FakeExecutor();
};

const stubMap = {
  'utils/Logger': function () {
    class Logger {
      static info() {}
      static warn() {}
      static error() {}
      static debug() {}
    }
    return { Logger };
  },
  'ide/bridgeRegistry': function () {
    return { getActivePythonBridge: function () { return global.__bridge || null; } };
  },
  'desktop/DesktopActionExecutor': function () {
    return { DesktopActionExecutor: FakeExecutor };
  },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request && request.startsWith('.')) {
    const resolved = path.resolve(path.dirname(parent.filename), request);
    const rel = path.relative(OUT, resolved).replace(/\\/g, '/').replace(/\.js$/, '');
    if (rel in stubMap) return stubMap[rel]();
  }
  return origLoad.apply(this, arguments);
};

// ---- load the transpiled package ----
const action = require(path.join(OUT, 'harness/action/index.js'));
const {
  getActionDispatcher,
  configureActionDispatcher,
  ToolChannel,
  DesktopChannel,
  McpChannel,
  PythonVerificationBridge,
  LocalVerificationBridge,
} = action;

// ---- tiny assert harness ----
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + msg);
  } else {
    failed++;
    console.log('  ✗ ' + msg);
  }
}

async function main() {
  console.log('P1-2 runtime verification');

  // 1) ToolChannel via dispatcher (real-ish fake registry)
  const fakeRegistry = {
    execute: async (name, params, ctx) => {
      if (name === 'fail') return { success: false, output: null, error: 'boom', duration: 3, validated: false };
      return { success: true, output: 'out:' + name, duration: 4, validated: true, metadata: { k: 1 } };
    },
  };
  const d = configureActionDispatcher({ toolRegistry: fakeRegistry });

  const r1 = await d.dispatch({ channel: 'tool', tool: 'shell_exec', params: { cmd: 'ls' } });
  ok(r1.channel === 'tool' && r1.success === true, 'tool channel dispatches registered tool');
  ok(r1.output === 'out:shell_exec', 'tool result output normalized');
  ok(r1.metadata && r1.metadata.k === 1, 'tool result metadata preserved');

  const r1b = await d.dispatch({ channel: 'tool', tool: 'fail' });
  ok(r1b.success === false && r1b.error === 'boom', 'tool channel surfaces tool failure');

  const r1c = await d.dispatch({ channel: 'tool' });
  ok(r1c.success === false && /request.tool/.test(r1c.error || ''), 'tool channel rejects missing tool');

  // 2) DesktopChannel + verification bridge (闭环)
  const fakeVerifier = {
    mode: 'local',
    verify: async (req) => ({ success: true, confidence: 0.7, evidence: 'verified:' + req.description, retrySuggested: false, method: 'local', diffRatio: 0.0 }),
  };
  d.useVerifier(fakeVerifier);
  const r2 = await d.dispatch({
    channel: 'desktop',
    desktopAction: { type: 'click', params: { x: 10, y: 20 } },
    verify: { description: 'click ok button' },
  });
  ok(r2.channel === 'desktop' && r2.success === true, 'desktop channel executes action');
  ok(r2.verification && r2.verification.method === 'local' && r2.verification.confidence === 0.7, 'desktop action 接回 verifier (verification attached)');

  const r2b = await d.dispatch({ channel: 'desktop' });
  ok(r2b.success === false && /desktopAction/.test(r2b.error || ''), 'desktop channel rejects missing action');

  // 3) McpChannel (no bridge -> error; with bridge -> ok)
  const r3 = await d.dispatch({ channel: 'mcp', tool: 'mcp_browser_navigate', params: { url: 'x' } });
  ok(r3.success === false && /MCP 后端未连接/.test(r3.error || ''), 'mcp channel errors when bridge absent');

  global.__bridge = {
    callMcpTool: async (server, name, params) => ({ server, name, params, ok: true }),
  };
  const r3b = await d.dispatch({ channel: 'mcp', tool: 'mcp_browser_navigate', params: { url: 'https://x' } });
  ok(r3b.success === true && /browser/.test(r3b.output), 'mcp channel parses mcp_{server}_{tool} and calls bridge');

  // 4) dispatcher routing sanity
  ok(d.getChannel('tool') instanceof ToolChannel, 'dispatcher has tool channel');
  ok(d.getChannel('desktop') instanceof DesktopChannel, 'dispatcher has desktop channel');
  ok(d.getChannel('mcp') instanceof McpChannel, 'dispatcher has mcp channel');
  const r4 = await d.dispatch({ channel: 'unknown' });
  ok(r4.success === false && /未注册/.test(r4.error || ''), 'dispatcher rejects unknown channel');

  // 5) PythonVerificationBridge normalization (stub fetch)
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ success: true, confidence: 0.9, evidence: 'changed', retry_suggested: false, method: 'pixel', diff_ratio: 0.2 }),
  });
  const vb = new PythonVerificationBridge('http://localhost:9999');
  const vo = await vb.verify({ description: 'click', prePath: 'a.png', postPath: 'b.png' });
  ok(vb.mode === 'python' && vo.method === 'pixel' && vo.confidence === 0.9 && vo.diffRatio === 0.2, 'PythonVerificationBridge normalizes HTTP response');

  // 5b) PythonVerificationBridge error path -> graceful
  global.fetch = async () => { throw new Error('network down'); };
  const voErr = await vb.verify({ description: 'x' });
  ok(voErr.success === false && voErr.method === 'python_error', 'PythonVerificationBridge degrades gracefully on fetch error');

  ok(LocalVerificationBridge && new LocalVerificationBridge().mode === 'local', 'LocalVerificationBridge available as fallback');

  console.log('\nResult: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
