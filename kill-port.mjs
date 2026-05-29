// npm start 前置脚本：杀死旧后端+旧前端端口占用
import { execSync } from 'child_process';

const PORTS = ['3111', '3100'];

for (const port of PORTS) {
  try {
    const result = execSync(`netstat -ano | findstr ":${port}"`, {
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
          console.log(`[kill-port] 端口${port} 旧进程 PID ${pid} 已杀死`);
        } catch {}
      }
    }
  } catch {}
}
