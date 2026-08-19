// Runtime verification for P1-3 real hearing (voice_interact listen/speak).
// Stubs EventBus/Logger/fs/SpeechRecognizer via Module._load, then drives the
// transpiled voice_interact executor.
const path = require('path');
const Module = require('module');

const OUT = path.resolve('.p1out');
const events = [];

function FakeRecognizer() {}
FakeRecognizer.prototype.initialize = async function () {};
FakeRecognizer.prototype.recognize = async function (_buf) {
  const r = global.__asrResult || { text: '', confidence: 0 };
  return { text: r.text, confidence: r.confidence, language: 'zh-CN', duration: 12, timestamp: new Date() };
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
  'shared/EventBus': function () {
    return { EventBus: { emit: (t, p) => events.push({ t, p }) } };
  },
  'multimodal/SpeechRecognizer': function () {
    return { SpeechRecognizer: FakeRecognizer };
  },
};

const fsStub = {
  readFileSync: () => Buffer.from('RIFF....wav-bytes'),
  writeFileSync: () => {},
  existsSync: () => true,
  unlinkSync: () => {},
  mkdirSync: () => {},
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'fs') return fsStub;
  if (request && request.startsWith('.')) {
    const resolved = path.resolve(path.dirname(parent.filename), request);
    const rel = path.relative(OUT, resolved).replace(/\\/g, '/').replace(/\.js$/, '');
    if (rel in stubMap) return stubMap[rel]();
  }
  return origLoad.apply(this, arguments);
};

const { createVoiceInteractExecutor } = require(path.join(OUT, 'harness/tools/system/voice_interact.js'));

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.log('  ✗ ' + msg); }
}

async function main() {
  console.log('P1-3 runtime verification');

  // 1) listen with audioPath -> real ASR (mock buffer removed)
  global.__asrResult = { text: '你好世界', confidence: 0.92 };
  let exec = createVoiceInteractExecutor({});
  let r = await exec({ action: 'listen', audioPath: 'clip.wav' }, {});
  if (!r.success) console.log('  [debug] listen(audioPath) ->', JSON.stringify({ success: r.success, error: r.error }));
  ok(r.success && /你好世界/.test(r.output), 'listen(audioPath) 执行真实 ASR 并返回识别文本');
  ok(r.metadata && r.metadata.asr === true && r.metadata.text === '你好世界', 'listen 结果标记 asr 且携带文本');
  const ev = events.find((e) => e.t === 'voice_recognized');
  ok(ev && ev.p.text === '你好世界', 'ASR 结果写入感知总线 (voice_recognized 事件)');

  // 2) listen without audio source -> fail-closed (no silent mock)
  events.length = 0;
  r = await exec({ action: 'listen' }, {});
  ok(r.success === false && /未提供音频源/.test(r.error || ''), 'listen 无音频源时 fail-closed（不再静默模拟）');

  // 3) listen with injected audioCapturer -> real ASR path
  global.__asrResult = { text: '打开灯', confidence: 0.88 };
  exec = createVoiceInteractExecutor({
    audioCapturer: async () => Buffer.from('mic-bytes'),
  });
  r = await exec({ action: 'listen', language: 'zh-CN' }, {});
  ok(r.success && r.metadata.text === '打开灯', 'listen 经注入的麦克风采集器执行真实 ASR');

  // 4) speak mock backend
  exec = createVoiceInteractExecutor({});
  r = await exec({ action: 'speak', text: '你好', ttsBackend: 'mock' }, {});
  ok(r.success && r.metadata.backend === 'mock' && r.metadata.synthesized === false, 'speak(mock) 走 mock 后端');

  // 5) speak real backend but no real synth -> explicit error (fail-closed)
  r = await exec({ action: 'speak', text: '你好', ttsBackend: 'real' }, {});
  ok(r.success === false && /未配置真实 TTS 后端/.test(r.error || ''), 'speak(real) 无真实后端时显式报错（不静默降级）');

  // 6) speak real backend with real synth injected
  exec = createVoiceInteractExecutor({
    interactionEngine: {
      speechSynthesizer: {
        speak: async (text) => ({ success: true, audioData: Buffer.from('audio'), duration: 123 }),
      },
    },
  });
  r = await exec({ action: 'speak', text: '你好', ttsBackend: 'real' }, {});
  ok(r.success && r.metadata.backend === 'real' && r.metadata.synthesized === true, 'speak(real) 经注入真实合成器生成音频');

  console.log('\nResult: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
