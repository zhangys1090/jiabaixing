# 桌面端轻量版快速启动指南

> **基于设计方案的快速实施指南**
> **目标**: 10分钟内了解核心架构，1小时内搭建开发环境

---

## 一、架构概览

```
┌─────────────────────────────────────────────────────────┐
│                    桌面应用层                              │
├─────────────────────────────────────────────────────────┤
│  系统托盘  │  全局快捷键  │  原生通知  │  自动更新       │
├─────────────────────────────────────────────────────────┤
│                    Electron 主进程                        │
├─────────────────────────────────────────────────────────┤
│  窗口管理  │  IPC通信  │  菜单栏  │  协议处理           │
├─────────────────────────────────────────────────────────┤
│                    渲染进程（React）                      │
├─────────────────────────────────────────────────────────┤
│  轻量UI  │  核心功能  │  桌面增强  │  离线缓存           │
├─────────────────────────────────────────────────────────┤
│                    后端服务层                              │
├─────────────────────────────────────────────────────────┤
│  WebSocket  │  HTTP API  │  本地服务  │  系统集成         │
└─────────────────────────────────────────────────────────┘
```

---

## 二、快速开始

### 2.1 环境准备

```bash
# 1. 安装Node.js 20+
node --version  # 需要 >= 20.x

# 2. 克隆项目
git clone https://github.com/jiabaixing/desktop.git
cd desktop

# 3. 安装依赖
npm install

# 4. 安装前端依赖
cd src/frontend && npm install && cd ../..
```

### 2.2 开发环境搭建

```bash
# 1. 启动后端服务
npm run start:backend

# 2. 启动前端开发服务器（新终端）
npm run start:frontend

# 3. 启动Electron应用（新终端）
npm run electron:dev
```

### 2.3 项目结构

```
jiabaixing-desktop/
├── src/
│   ├── frontend/                    # 前端代码
│   │   ├── electron/               # Electron主进程
│   │   │   ├── main.js            # 主进程入口
│   │   │   ├── preload.js         # 预加载脚本
│   │   │   ├── tray/              # 系统托盘
│   │   │   ├── windows/           # 窗口管理
│   │   │   ├── ipc/               # IPC通信
│   │   │   ├── shortcuts/         # 快捷键
│   │   │   ├── notifications/     # 通知系统
│   │   │   └── auto-update/       # 自动更新
│   │   ├── src/
│   │   │   ├── components/        # React组件
│   │   │   │   ├── lightweight/   # 轻量组件
│   │   │   │   │   ├── LightweightChat/
│   │   │   │   │   ├── VirtualList/
│   │   │   │   │   ├── MessageBubble/
│   │   │   │   │   ├── QuickChat/
│   │   │   │   │   ├── DragDrop/
│   │   │   │   │   └── PerformanceMonitor/
│   │   │   │   └── ...           # 其他组件
│   │   │   ├── utils/             # 工具函数
│   │   │   │   ├── MemoryOptimizer.ts
│   │   │   │   ├── RenderOptimizer.ts
│   │   │   │   ├── NetworkOptimizer.ts
│   │   │   │   ├── ClipboardManager.ts
│   │   │   │   └── LazyLoader.ts
│   │   │   ├── api/               # API服务
│   │   │   ├── stores/            # 状态管理
│   │   │   └── hooks/             # React hooks
│   │   └── package.json
│   └── backend/                    # 后端代码（现有）
├── tests/
│   ├── desktop/
│   │   ├── e2e/                   # E2E测试
│   │   └── performance/           # 性能测试
│   └── ...
├── assets/
│   ├── icons/                     # 应用图标
│   └── ...
├── electron-builder.json          # 构建配置
├── package.json
└── README.md
```

---

## 三、核心功能实现

### 3.1 Electron主进程

**文件**: `src/frontend/electron/main.js`

```javascript
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  ipcMain,
} = require('electron');
const path = require('path');

class JiabaixingDesktop {
  constructor() {
    this.mainWindow = null;
    this.tray = null;
    this.isQuitting = false;
  }

  async init() {
    // 单实例锁
    const gotTheLock = app.requestSingleInstanceLock();
    if (!gotTheLock) {
      app.quit();
      return;
    }

    app.on('second-instance', () => {
      if (this.mainWindow) {
        if (this.mainWindow.isMinimized()) this.mainWindow.restore();
        this.mainWindow.focus();
      }
    });

    // 创建主窗口
    await this.createMainWindow();

    // 创建系统托盘
    this.createTray();

    // 注册全局快捷键
    this.registerShortcuts();

    // 设置IPC通信
    this.setupIPC();
  }

  async createMainWindow() {
    this.mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 800,
      minHeight: 600,
      title: '家百星 - 轻量版',
      icon: path.join(__dirname, '../assets/icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
      show: false,
      frame: false,
      titleBarStyle: 'hidden',
    });

    const startUrl =
      process.env.ELECTRON_START_URL ||
      `file://${path.join(__dirname, '../build/index.html')}`;

    await this.mainWindow.loadURL(startUrl);

    this.mainWindow.once('ready-to-show', () => {
      this.mainWindow.show();
    });

    this.mainWindow.on('close', (event) => {
      if (!this.isQuitting) {
        event.preventDefault();
        this.mainWindow.hide();
      }
    });
  }

  createTray() {
    this.tray = new Tray(path.join(__dirname, '../assets/tray-icon.png'));

    const contextMenu = Menu.buildFromTemplate([
      { label: '打开主窗口', click: () => this.mainWindow.show() },
      { label: '快速对话', click: () => this.showQuickChat() },
      { type: 'separator' },
      { label: '设置', click: () => this.showSettings() },
      { label: '退出', click: () => this.quit() },
    ]);

    this.tray.setToolTip('家百星 AI 助手');
    this.tray.setContextMenu(contextMenu);

    this.tray.on('double-click', () => {
      this.mainWindow.show();
    });
  }

  registerShortcuts() {
    globalShortcut.register('CommandOrControl+Shift+Space', () => {
      this.showQuickChat();
    });

    globalShortcut.register('CommandOrControl+Shift+Q', () => {
      this.mainWindow.hide();
    });
  }

  setupIPC() {
    ipcMain.on('window:minimize', () => {
      this.mainWindow.minimize();
    });

    ipcMain.on('window:maximize', () => {
      if (this.mainWindow.isMaximized()) {
        this.mainWindow.unmaximize();
      } else {
        this.mainWindow.maximize();
      }
    });

    ipcMain.on('window:close', () => {
      this.mainWindow.close();
    });

    ipcMain.on('window:hide', () => {
      this.mainWindow.hide();
    });

    ipcMain.on('window:show', () => {
      this.mainWindow.show();
    });
  }

  quit() {
    this.isQuitting = true;
    globalShortcut.unregisterAll();
    app.quit();
  }
}

// 启动应用
app.whenReady().then(() => {
  new JiabaixingDesktop().init();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
```

### 3.2 预加载脚本

**文件**: `src/frontend/electron/preload.js`

```javascript
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    hide: () => ipcRenderer.send('window:hide'),
    show: () => ipcRenderer.send('window:show'),
  },

  send: (channel, data) => {
    const validChannels = [
      'message:send',
      'file:analyze',
      'image:analyze',
      'clipboard:analyze',
      'notification:show',
      'tray:update',
    ];

    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },

  on: (channel, callback) => {
    const validChannels = [
      'message:receive',
      'file:result',
      'image:result',
      'clipboard:result',
      'notification:click',
      'tray:menu-click',
    ];

    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (event, ...args) => callback(...args));
    }
  },

  system: {
    getInfo: () => ipcRenderer.invoke('system:info'),
    getMemory: () => ipcRenderer.invoke('system:memory'),
    getCPU: () => ipcRenderer.invoke('system:cpu'),
  },

  shortcuts: {
    register: (shortcut, action) => {
      ipcRenderer.send('shortcut:register', { shortcut, action });
    },
    unregister: (shortcut) => {
      ipcRenderer.send('shortcut:unregister', shortcut);
    },
  },

  notification: {
    show: (data) => {
      ipcRenderer.send('notification:show', data);
    },
    clear: (id) => {
      ipcRenderer.send('notification:clear', id);
    },
  },
});
```

### 3.3 轻量聊天组件

**文件**: `src/frontend/src/components/lightweight/LightweightChat/LightweightChat.tsx`

```tsx
import React, { memo, useCallback, useMemo, useRef, useEffect } from 'react';
import { useAgentStore } from '../../../stores/useAgentStore';
import { useConnectionStore } from '../../../stores/useConnectionStore';
import { VirtualList } from '../VirtualList/VirtualList';
import { MessageBubble } from '../MessageBubble/MessageBubble';
import { InputArea } from '../InputArea/InputArea';
import './LightweightChat.css';

export const LightweightChat: React.FC = memo(() => {
  const messages = useAgentStore((state) => state.messages);
  const connectionStatus = useConnectionStore(
    (state) => state.connectionStatus
  );
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const virtualListConfig = useMemo(
    () => ({
      itemHeight: 80,
      overscan: 5,
      threshold: 100,
    }),
    []
  );

  const handleSend = useCallback((message: string) => {
    if (!message.trim()) return;

    window.electron?.send('message:send', {
      content: message,
      timestamp: Date.now(),
    });

    if (inputRef.current) {
      inputRef.current.value = '';
    }
  }, []);

  return (
    <div className="lightweight-chat">
      <div className="lightweight-chat__status">
        <span className={`status-indicator status-${connectionStatus}`}>
          {connectionStatus === 'connected' ? '🟢' : '🔴'}
        </span>
        <span className="status-text">
          {connectionStatus === 'connected' ? '已连接' : '连接中...'}
        </span>
      </div>

      <div className="lightweight-chat__messages">
        <VirtualList
          items={messages}
          itemHeight={virtualListConfig.itemHeight}
          overscan={virtualListConfig.overscan}
          renderItem={(message) => (
            <MessageBubble
              key={message.id}
              message={message}
              isUser={message.role === 'user'}
            />
          )}
        />
      </div>

      <InputArea
        ref={inputRef}
        onSend={handleSend}
        placeholder="输入消息..."
        disabled={connectionStatus !== 'connected'}
      />
    </div>
  );
});

LightweightChat.displayName = 'LightweightChat';
```

---

## 四、开发命令速查

### 4.1 开发命令

```bash
# 开发环境
npm run electron:dev          # 启动开发环境
npm run start:backend         # 启动后端服务
npm run start:frontend        # 启动前端开发服务器

# 测试
npm test                      # 运行所有测试
npm run test:coverage         # 运行测试并生成覆盖率报告
npm run test:e2e              # 运行E2E测试

# 构建
npm run electron:build        # 构建当前平台
npm run electron:build:win    # 构建Windows版本
npm run electron:build:mac    # 构建macOS版本
npm run electron:build:linux  # 构建Linux版本
npm run electron:build:all    # 构建所有平台

# 代码质量
npm run lint                  # 代码检查
npm run format                # 代码格式化
npm run check:all             # 运行所有检查
```

### 4.2 快捷键

| 快捷键             | 功能     | 说明             |
| ------------------ | -------- | ---------------- |
| `Ctrl+Shift+Space` | 快速对话 | 弹出迷你对话框   |
| `Ctrl+Shift+S`     | 截图分析 | 截图后自动分析   |
| `Ctrl+Shift+F`     | 文件分析 | 选择文件进行分析 |
| `Ctrl+Shift+M`     | 记忆搜索 | 快速搜索记忆     |
| `Ctrl+Shift+Q`     | 快速退出 | 最小化到托盘     |

---

## 五、测试指南

### 5.1 运行测试

```bash
# 单元测试
npm test

# E2E测试
npx playwright test tests/desktop/e2e/

# 性能测试
npx playwright test tests/desktop/performance/

# 生成测试报告
npx playwright show-report
```

### 5.2 测试用例示例

```typescript
// tests/desktop/e2e/desktop-app.test.ts
import { test, expect } from '@playwright/test';

test.describe('桌面应用E2E测试', () => {
  test('应用启动和窗口显示', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveTitle(/家百星/);
    await expect(page.locator('.lightweight-chat')).toBeVisible();
    await expect(page.locator('.input-area')).toBeVisible();
  });

  test('消息发送和接收', async ({ page }) => {
    await page.fill('.input-area textarea', '你好');
    await page.click('.input-area button');

    await expect(page.locator('.message-bubble')).toContainText('你好');
    await expect(page.locator('.message-bubble.ai')).toBeVisible({
      timeout: 10000,
    });
  });
});
```

---

## 六、部署指南

### 6.1 构建生产版本

```bash
# 1. 更新版本号
npm version 1.0.0

# 2. 运行测试
npm test

# 3. 构建所有平台
npm run electron:build:all

# 4. 验证构建产物
ls -la dist-electron/
```

### 6.2 发布流程

```bash
# 1. 创建GitHub Release
gh release create v1.0.0 \
  dist-electron/家百星桌面版-Setup.exe \
  dist-electron/家百星桌面版.dmg \
  dist-electron/家百星桌面版.AppImage \
  --title "家百星桌面版 V1.0" \
  --notes-file RELEASE_NOTES.md

# 2. 更新文档
git add .
git commit -m "docs: 更新发布说明"
git push
```

### 6.3 安装指南

#### Windows

1. 下载 `家百星桌面版-Setup.exe`
2. 运行安装程序
3. 按照向导完成安装

#### macOS

1. 下载 `家百星桌面版.dmg`
2. 双击打开DMG文件
3. 拖动应用到 Applications 文件夹

#### Linux

1. 下载 `家百星桌面版.AppImage`
2. 添加执行权限: `chmod +x 家百星桌面版.AppImage`
3. 运行应用: `./家百星桌面版.AppImage`

---

## 七、常见问题

### 7.1 开发环境问题

**Q: 启动Electron应用时出现白屏**
A: 确保前端开发服务器已启动，检查 `ELECTRON_START_URL` 环境变量。

**Q: 全局快捷键不响应**
A: 检查快捷键是否与其他应用冲突，尝试更换快捷键组合。

**Q: 系统托盘图标不显示**
A: 确保图标文件路径正确，检查图标文件是否存在。

### 7.2 构建问题

**Q: 构建失败，提示缺少依赖**
A: 运行 `npm install` 重新安装依赖，确保Node.js版本 >= 20。

**Q: 跨平台构建失败**
A: 确保在对应平台上构建，或使用CI/CD进行跨平台构建。

### 7.3 性能问题

**Q: 应用启动慢**
A: 检查是否有大量预加载任务，优化懒加载策略。

**Q: 内存占用高**
A: 检查是否有内存泄漏，启用自动清理功能。

---

## 八、下一步行动

### 8.1 立即行动

1. **搭建开发环境**: 按照快速开始指南搭建环境
2. **运行示例**: 运行现有代码，了解基本功能
3. **阅读文档**: 详细阅读设计方案和实施路线图

### 8.2 短期目标（1-2周）

1. **完成Phase 1**: 基础架构搭建
2. **实现核心功能**: Electron主进程、IPC通信
3. **搭建测试环境**: 配置测试框架

### 8.3 中期目标（3-6周）

1. **完成Phase 2-3**: 轻量UI和系统集成
2. **性能优化**: 内存、渲染、启动优化
3. **跨平台测试**: 验证兼容性

### 8.4 长期目标（7-10周）

1. **完成Phase 4-5**: 性能优化和测试发布
2. **发布V1.0**: 正式发布桌面端应用
3. **持续迭代**: 根据用户反馈持续优化

---

## 九、资源链接

### 9.1 文档

- [设计方案](./DESKTOP_APP_DESIGN.md)
- [实施路线图](./DESKTOP_APP_IMPLEMENTATION.md)
- [快速启动指南](./QUICK_START_GUIDE.md)

### 9.2 工具

- [Electron文档](https://www.electronjs.org/docs)
- [React文档](https://reactjs.org/docs)
- [Playwright文档](https://playwright.dev/docs)
- [electron-builder文档](https://www.electron.build/)

### 9.3 社区

- [GitHub Issues](https://github.com/jiabaixing/desktop/issues)
- [GitHub Discussions](https://github.com/jiabaixing/desktop/discussions)
- [Discord社区](https://discord.gg/jiabaixing)

---

> **提示**: 本指南基于设计方案和实施路线图编写，旨在帮助开发者快速上手桌面端开发。如有问题，请查看常见问题或提交Issue。
