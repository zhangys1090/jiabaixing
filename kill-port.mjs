// npm start 前置脚本：自动杀死旧后端端口占用
// 放在项目根目录，package.json 中 "start": "node kill-port.mjs && ..."

import { execSync } from 'child_process';

const PORT = '3111';

try {
  const result = execSync(`netstat -ano | findstr ":${PORT}"`, {
    encoding: 'utf-8',
    timeout: 3000,
  });

  const lines = result.trim().split('\n').filter(l => l.includes('LISTENING'));
  
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    const pid = parts[parts.length - 1];
    if (pid && pid !== '0') {
      try {
        execSync(`taskkill /F /PID ${pid}`, { encoding: 'utf-8', timeout: 2000 });
        console.log(`[kill-port] 旧后端 PID ${pid} 已杀死`);
      } catch {
        // 可能已经没了
      }
    }
  }
} catch {
  // 端口未被占用，无需操作
}
