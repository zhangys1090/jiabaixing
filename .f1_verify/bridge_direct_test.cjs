// Direct runtime test for PythonAgentBridge.toolsetExecuteRaw
// Transpiles the real bridge source and exercises both code paths.
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const Module = require('module');

const BRIDGE_SRC = path.resolve('src/ide/PythonAgentBridge.ts');
const OUT = path.resolve('.f1_verify/PythonAgentBridge.cjs');

// 1) Transpile real source -> CJS (syntax + per-file transforms only)
const src = fs.readFileSync(BRIDGE_SRC, 'utf8');
const { outputText } = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true, allowSyntheticDefaultImports: true },
  fileName: BRIDGE_SRC,
});
fs.writeFileSync(OUT, outputText, 'utf8');

// 2) Fake axios client + require hook to stub heavy/optional deps
const fakeClient = {
  interceptors: { response: { use: () => {} } },
  post: null, // set per-case
  get: async () => ({ data: {} }),
};
const fakeAxios = { create: () => fakeClient };

const stubs = {
  'axios': fakeAxios,
  '../utils/Logger': { Logger: { error() {}, warn() {}, debug() {}, info() {} } },
  '../shared/EventBus': { JiabaixingEventBus: class {} },
  './ACPActivityTracker': { ACPActivityTracker: class {} },
  'ws': class WebSocket {},
};

const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  // match by basename for relative; exact for bare
  if (req === 'axios' || stubs[req]) return stubs[req] || fakeAxios;
  const base = path.basename(req).replace(/\.[^.]+$/, '');
  for (const key of Object.keys(stubs)) {
    if (key.startsWith('.') && path.basename(key).replace(/\.[^.]+$/, '') === base) {
      return stubs[key];
    }
  }
  return origLoad.apply(this, arguments);
};

const { PythonAgentBridge } = require(OUT);

// 3) Run cases
let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

(async () => {
  const bridge = new PythonAgentBridge({ baseUrl: 'http://localhost:9999', timeout: 1000 });

  // Case 1: success path — post resolves, data returned directly (no throw)
  fakeClient.post = async () => ({ data: { success: true, output: 'PYOUT', metadata: { backend: 'python' } } });
  try {
    const r = await bridge.toolsetExecuteRaw('shell_exec', { command: 'echo hi' });
    check('成功路径返回原始 data (success=true)', r && r.success === true && r.output === 'PYOUT');
  } catch (e) {
    check('成功路径不应抛异常', false);
  }

  // Case 2: logical failure (success=false) — returned honestly, NOT thrown
  fakeClient.post = async () => ({ data: { success: false, error: 'blocked', metadata: { security_violation: true } } });
  try {
    const r = await bridge.toolsetExecuteRaw('shell_exec', { command: 'rm -rf /' });
    check('逻辑拒绝被诚实返回 (success=false, 不抛)', r && r.success === false && r.error === 'blocked');
  } catch (e) {
    check('逻辑拒绝不应抛异常(只能传输层抛)', false);
  }

  // Case 3: transport failure — post rejects, method re-throws
  fakeClient.post = async () => { throw new Error('ECONNREFUSED'); };
  try {
    await bridge.toolsetExecuteRaw('shell_exec', { command: 'echo hi' });
    check('传输失败应抛异常', false);
  } catch (e) {
    check('传输失败抛出 (消息含 ECONNREFUSED)', e && /ECONNREFUSED/.test(e.message));
  }

  console.log('\ntoolsetExecuteRaw direct: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})();
