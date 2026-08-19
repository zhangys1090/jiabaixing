# 家百星桌面端轻量版设计方案

> **版本**: V1.0  
> **日期**: 2026-07-06  
> **设计原则**: 轻量化、原生体验、无缝集成  
> **参考范例**: Hermes Desktop

---

## 一、设计概述

### 1.1 设计目标

基于jiabaixing现有架构，设计一个**轻量化桌面端应用**，实现：

1. **极速启动**：冷启动 < 2秒，热启动 < 500ms
2. **低资源占用**：内存 < 150MB，CPU < 5%（空闲时）
3. **原生桌面体验**：系统托盘、全局快捷键、原生通知
4. **无缝集成**：与现有Web版功能完全兼容
5. **跨平台支持**：Windows、macOS、Linux

### 1.2 技术选型

| 组件         | 选择                  | 理由                     |
| ------------ | --------------------- | ------------------------ |
| **桌面框架** | Electron 41.x         | 已集成，成熟稳定，跨平台 |
| **前端框架** | React 18 + TypeScript | 现有代码复用             |
| **状态管理** | Zustand               | 轻量、已有集成           |
| **构建工具** | electron-builder      | 打包优化，自动更新       |
| **后端通信** | WebSocket + HTTP      | 现有架构复用             |
| **系统集成** | nut.js                | 已有依赖，桌面自动化     |

### 1.3 架构图

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

## 二、核心功能设计

### 2.1 轻量UI设计

#### 2.1.1 主界面布局

```
┌─────────────────────────────────────────────────────────┐
│ 🏠 家百星 - 轻量版                    ─  □  ×          │
├─────────────────────────────────────────────────────────┤
│ [💬] [⚡] [🧠] [📊] [⚙️]                               │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │                  对话区域                        │   │
│  │  用户: 帮我分析一下这个文件                      │   │
│  │  AI: 正在分析...                                │   │
│  │                                                 │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  [📎] [🎤] [📷]  输入消息...        [发送]      │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
├─────────────────────────────────────────────────────────┤
│ 状态: 已连接 │ 模型: deepseek-chat │ 内存: 45MB        │
└─────────────────────────────────────────────────────────┘
```

#### 2.1.2 轻量面板设计

| 面板       | 功能         | 轻量化处理         |
| ---------- | ------------ | ------------------ |
| **对话**   | 核心对话界面 | 保留，优化性能     |
| **Hermes** | 增强功能     | 精简为常用工具     |
| **记忆**   | 记忆管理     | 只显示关键统计     |
| **监控**   | 系统监控     | 简化图表，实时数据 |
| **设置**   | 配置管理     | 精简常用设置       |

#### 2.1.3 性能优化策略

1. **虚拟滚动**：长对话列表使用虚拟滚动
2. **懒加载**：非核心面板按需加载
3. **内存优化**：对话历史分页加载
4. **渲染优化**：使用React.memo减少重渲染

### 2.2 系统集成功能

#### 2.2.1 系统托盘

```javascript
// 托盘功能设计
const trayFeatures = {
  icon: 'tray-icon.png',
  tooltip: '家百星 AI 助手',
  menu: [
    { label: '打开主窗口', action: 'showMainWindow' },
    { label: '快速对话', action: 'quickChat' },
    { type: 'separator' },
    { label: '模型状态', action: 'showModelStatus' },
    { label: '系统监控', action: 'showMonitor' },
    { type: 'separator' },
    { label: '设置', action: 'showSettings' },
    { label: '退出', action: 'quit' },
  ],
  notifications: {
    proactive: true, // 主动消息通知
    errors: true, // 错误通知
    completion: true, // 任务完成通知
  },
};
```

#### 2.2.2 全局快捷键

| 快捷键             | 功能     | 说明             |
| ------------------ | -------- | ---------------- |
| `Ctrl+Shift+Space` | 快速对话 | 弹出迷你对话框   |
| `Ctrl+Shift+S`     | 截图分析 | 截图后自动分析   |
| `Ctrl+Shift+F`     | 文件分析 | 选择文件进行分析 |
| `Ctrl+Shift+M`     | 记忆搜索 | 快速搜索记忆     |
| `Ctrl+Shift+Q`     | 快速退出 | 最小化到托盘     |

#### 2.2.3 原生通知系统

```typescript
// 通知类型设计
interface NotificationTypes {
  proactive: {
    title: '主动消息';
    icon: '📢';
    actions: ['查看', '忽略', '稍后提醒'];
  };
  taskComplete: {
    title: '任务完成';
    icon: '✅';
    actions: ['查看结果', '继续任务'];
  };
  error: {
    title: '系统错误';
    icon: '❌';
    actions: ['查看错误', '重试', '报告问题'];
  };
  modelStatus: {
    title: '模型状态';
    icon: '🤖';
    actions: ['切换模型', '查看状态'];
  };
}
```

### 2.3 桌面增强功能

#### 2.3.1 文件拖拽支持

```typescript
// 拖拽处理
const dragDropHandlers = {
  files: {
    accept: '.txt,.md,.pdf,.doc,.docx,.xls,.xlsx',
    action: 'analyzeFile',
    feedback: '正在分析文件...',
  },
  images: {
    accept: '.png,.jpg,.jpeg,.gif,.webp',
    action: 'analyzeImage',
    feedback: '正在分析图片...',
  },
  text: {
    accept: 'text/plain',
    action: 'processText',
    feedback: '正在处理文本...',
  },
};
```

#### 2.3.2 剪贴板集成

```typescript
// 剪贴板功能
const clipboardFeatures = {
  monitor: true, // 监控剪贴板变化
  quickAnalyze: true, // 快速分析剪贴板内容
  smartPaste: true, // 智能粘贴（根据内容类型）
  history: true, // 剪贴板历史记录
  shortcuts: {
    'Ctrl+Shift+C': '分析剪贴板内容',
    'Ctrl+Shift+V': '粘贴并分析',
  },
};
```

#### 2.3.3 语音交互

```typescript
// 语音功能
const voiceFeatures = {
  wakeWord: '嘿百星', // 唤醒词
  continuous: true, // 连续对话模式
  pushToTalk: true, // 按键说话
  noiseReduction: true, // 降噪
  language: 'zh-CN', // 中文支持
  offline: true, // 离线语音识别
};
```

---

## 三、技术实现方案

### 3.1 Electron主进程设计

#### 3.1.1 主进程架构

```
src/frontend/electron/
├── main.js                    # 主进程入口
├── preload.js                 # 预加载脚本
├── tray/                      # 系统托盘
│   ├── TrayManager.js
│   └── tray-menu.js
├── windows/                   # 窗口管理
│   ├── MainWindow.js
│   ├── QuickChatWindow.js
│   └── SettingsWindow.js
├── ipc/                       # IPC通信
│   ├── ipcHandlers.js
│   └── channels.js
├── shortcuts/                 # 快捷键
│   └── GlobalShortcuts.js
├── notifications/             # 通知系统
│   └── NotificationManager.js
└── auto-update/               # 自动更新
    └── Updater.js
```

#### 3.1.2 主进程核心代码

```javascript
// electron/main.js 重构
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  ipcMain,
  Notification,
} = require('electron');
const path = require('path');

class JiabaixingDesktop {
  constructor() {
    this.mainWindow = null;
    this.tray = null;
    this.quickChatWindow = null;
    this.isQuitting = false;

    this.init();
  }

  async init() {
    // 1. 单实例锁
    this.setupSingleInstance();

    // 2. 创建主窗口
    await this.createMainWindow();

    // 3. 创建系统托盘
    this.createTray();

    // 4. 注册全局快捷键
    this.registerShortcuts();

    // 5. 设置IPC通信
    this.setupIPC();

    // 6. 检查更新
    this.checkForUpdates();
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
      frame: false, // 无边框窗口
      titleBarStyle: 'hidden',
    });

    // 加载应用
    const startUrl =
      process.env.ELECTRON_START_URL ||
      `file://${path.join(__dirname, '../build/index.html')}`;

    await this.mainWindow.loadURL(startUrl);

    // 窗口准备好后显示
    this.mainWindow.once('ready-to-show', () => {
      this.mainWindow.show();
    });

    // 最小化到托盘
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
      { label: '模型状态', click: () => this.showModelStatus() },
      { label: '系统监控', click: () => this.showMonitor() },
      { type: 'separator' },
      { label: '设置', click: () => this.showSettings() },
      { label: '退出', click: () => this.quit() },
    ]);

    this.tray.setToolTip('家百星 AI 助手');
    this.tray.setContextMenu(contextMenu);

    // 双击托盘图标
    this.tray.on('double-click', () => {
      this.mainWindow.show();
    });
  }

  registerShortcuts() {
    // 快速对话
    globalShortcut.register('CommandOrControl+Shift+Space', () => {
      this.showQuickChat();
    });

    // 截图分析
    globalShortcut.register('CommandOrControl+Shift+S', () => {
      this.captureAndAnalyze();
    });

    // 文件分析
    globalShortcut.register('CommandOrControl+Shift+F', () => {
      this.analyzeFile();
    });

    // 快速退出
    globalShortcut.register('CommandOrControl+Shift+Q', () => {
      this.mainWindow.hide();
    });
  }

  showQuickChat() {
    if (this.quickChatWindow) {
      this.quickChatWindow.show();
      return;
    }

    this.quickChatWindow = new BrowserWindow({
      width: 400,
      height: 200,
      frame: false,
      alwaysOnTop: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
      },
    });

    this.quickChatWindow.loadURL(
      `file://${path.join(__dirname, '../build/quick-chat.html')}`
    );
  }

  setupIPC() {
    // 处理来自主窗口的消息
    ipcMain.on('main-window:hide', () => {
      this.mainWindow.hide();
    });

    ipcMain.on('main-window:show', () => {
      this.mainWindow.show();
    });

    // 处理通知
    ipcMain.on('notification:show', (event, data) => {
      this.showNotification(data);
    });

    // 处理托盘更新
    ipcMain.on('tray:update', (event, data) => {
      this.updateTray(data);
    });
  }

  showNotification(data) {
    const notification = new Notification({
      title: data.title,
      body: data.body,
      icon: data.icon || path.join(__dirname, '../assets/icon.png'),
      actions: data.actions || [],
    });

    notification.show();
  }

  quit() {
    this.isQuitting = true;
    globalShortcut.unregisterAll();
    app.quit();
  }
}

// 启动应用
app.whenReady().then(() => {
  new JiabaixingDesktop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
```

### 3.2 渲染进程优化

#### 3.2.1 轻量UI组件

```typescript
// src/frontend/src/components/LightweightChat/LightweightChat.tsx
import React, { memo, useCallback, useMemo, useRef, useEffect } from 'react';
import { useAgentStore } from '../../stores/useAgentStore';
import { useConnectionStore } from '../../stores/useConnectionStore';
import { MessageBubble } from '../MessageBubble/MessageBubble';
import { InputArea } from '../InputArea/InputArea';
import { VirtualList } from '../VirtualList/VirtualList';
import './LightweightChat.css';

export const LightweightChat: React.FC = memo(() => {
  const messages = useAgentStore(state => state.messages);
  const connectionStatus = useConnectionStore(state => state.connectionStatus);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 虚拟滚动优化
  const virtualListConfig = useMemo(() => ({
    itemHeight: 80,
    overscan: 5,
    threshold: 100
  }), []);

  // 发送消息
  const handleSend = useCallback((message: string) => {
    if (!message.trim()) return;

    // 发送到后端
    window.electron?.send('message:send', {
      content: message,
      timestamp: Date.now()
    });

    // 清空输入框
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  }, []);

  // 监听消息
  useEffect(() => {
    const unsubscribe = window.electron?.on('message:receive', (data) => {
      // 处理接收到的消息
    });

    return () => unsubscribe?.();
  }, []);

  return (
    <div className="lightweight-chat">
      {/* 状态栏 */}
      <div className="lightweight-chat__status">
        <span className={`status-indicator status-${connectionStatus}`}>
          {connectionStatus === 'connected' ? '🟢' : '🔴'}
        </span>
        <span className="status-text">
          {connectionStatus === 'connected' ? '已连接' : '连接中...'}
        </span>
      </div>

      {/* 消息列表（虚拟滚动） */}
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

      {/* 输入区域 */}
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

#### 3.2.2 虚拟滚动组件

```typescript
// src/frontend/src/components/VirtualList/VirtualList.tsx
import React, { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import './VirtualList.css';

interface VirtualListProps<T> {
  items: T[];
  itemHeight: number;
  overscan?: number;
  renderItem: (item: T, index: number) => React.ReactNode;
  onEndReached?: () => void;
  loading?: boolean;
}

export function VirtualList<T>({
  items,
  itemHeight,
  overscan = 5,
  renderItem,
  onEndReached,
  loading
}: VirtualListProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);

  // 计算可见区域
  const visibleRange = useMemo(() => {
    const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
    const endIndex = Math.min(
      items.length,
      Math.ceil((scrollTop + containerHeight) / itemHeight) + overscan
    );
    return { startIndex, endIndex };
  }, [scrollTop, containerHeight, itemHeight, overscan, items.length]);

  // 可见项目
  const visibleItems = useMemo(() => {
    return items.slice(visibleRange.startIndex, visibleRange.endIndex);
  }, [items, visibleRange]);

  // 总高度
  const totalHeight = items.length * itemHeight;

  // 滚动偏移
  const offsetY = visibleRange.startIndex * itemHeight;

  // 处理滚动
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);

    // 检查是否到达底部
    if (onEndReached) {
      const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
      if (scrollHeight - scrollTop - clientHeight < 100) {
        onEndReached();
      }
    }
  }, [onEndReached]);

  // 监听容器大小
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      className="virtual-list"
      onScroll={handleScroll}
      style={{ overflow: 'auto' }}
    >
      <div
        className="virtual-list__spacer"
        style={{ height: totalHeight }}
      />

      <div
        className="virtual-list__content"
        style={{ transform: `translateY(${offsetY}px)` }}
      >
        {visibleItems.map((item, index) => (
          <div
            key={visibleRange.startIndex + index}
            className="virtual-list__item"
            style={{ height: itemHeight }}
          >
            {renderItem(item, visibleRange.startIndex + index)}
          </div>
        ))}
      </div>

      {loading && (
        <div className="virtual-list__loading">
          加载中...
        </div>
      )}
    </div>
  );
}
```

### 3.3 IPC通信设计

#### 3.3.1 预加载脚本

```javascript
// electron/preload.js
const { contextBridge, ipcRenderer } = require('electron');

// 暴露安全的API给渲染进程
contextBridge.exposeInMainWorld('electron', {
  // 窗口控制
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    hide: () => ipcRenderer.send('window:hide'),
    show: () => ipcRenderer.send('window:show'),
  },

  // 消息通信
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

  // 系统信息
  system: {
    getInfo: () => ipcRenderer.invoke('system:info'),
    getMemory: () => ipcRenderer.invoke('system:memory'),
    getCPU: () => ipcRenderer.invoke('system:cpu'),
  },

  // 快捷键
  shortcuts: {
    register: (shortcut, action) => {
      ipcRenderer.send('shortcut:register', { shortcut, action });
    },
    unregister: (shortcut) => {
      ipcRenderer.send('shortcut:unregister', shortcut);
    },
  },

  // 通知
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

### 3.4 性能优化实现

#### 3.4.1 内存优化

```typescript
// src/frontend/src/utils/MemoryOptimizer.ts
export class MemoryOptimizer {
  private static instance: MemoryOptimizer;
  private messageCache: Map<string, any> = new Map();
  private maxCacheSize = 1000;

  static getInstance(): MemoryOptimizer {
    if (!MemoryOptimizer.instance) {
      MemoryOptimizer.instance = new MemoryOptimizer();
    }
    return MemoryOptimizer.instance;
  }

  // 消息缓存
  cacheMessage(id: string, message: any) {
    if (this.messageCache.size >= this.maxCacheSize) {
      // 删除最旧的缓存
      const firstKey = this.messageCache.keys().next().value;
      if (firstKey) {
        this.messageCache.delete(firstKey);
      }
    }
    this.messageCache.set(id, message);
  }

  // 获取缓存消息
  getCachedMessage(id: string) {
    return this.messageCache.get(id);
  }

  // 清理缓存
  clearCache() {
    this.messageCache.clear();
  }

  // 内存监控
  monitorMemory() {
    if (typeof window !== 'undefined' && 'memory' in performance) {
      const memory = (performance as any).memory;
      return {
        usedJSHeapSize: memory.usedJSHeapSize,
        totalJSHeapSize: memory.totalJSHeapSize,
        jsHeapSizeLimit: memory.jsHeapSizeLimit,
      };
    }
    return null;
  }

  // 自动清理
  autoCleanup() {
    setInterval(() => {
      const memoryInfo = this.monitorMemory();
      if (memoryInfo && memoryInfo.usedJSHeapSize > 100 * 1024 * 1024) {
        // 内存超过100MB时清理
        this.clearCache();
        console.log('Memory cleanup triggered');
      }
    }, 30000); // 每30秒检查一次
  }
}
```

#### 3.4.2 渲染优化

```typescript
// src/frontend/src/utils/RenderOptimizer.ts
export class RenderOptimizer {
  // 防抖渲染
  static debounceRender<T extends (...args: any[]) => any>(
    renderFn: T,
    delay: number = 16
  ): T {
    let timeoutId: NodeJS.Timeout;

    return ((...args: any[]) => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => renderFn(...args), delay);
    }) as T;
  }

  // 节流渲染
  static throttleRender<T extends (...args: any[]) => any>(
    renderFn: T,
    limit: number = 16
  ): T {
    let inThrottle: boolean;

    return ((...args: any[]) => {
      if (!inThrottle) {
        renderFn(...args);
        inThrottle = true;
        setTimeout(() => (inThrottle = false), limit);
      }
    }) as T;
  }

  // 按需渲染
  static shouldRender(prevProps: any, nextProps: any, keys: string[]): boolean {
    return keys.some(key => prevProps[key] !== nextProps[key]);
  }

  // 虚拟化渲染
  static virtualize<T>(
    items: T[],
    startIndex: number,
    endIndex: number,
    renderItem: (item: T) => React.ReactNode
  ): React.ReactNode[] {
    return items.slice(startIndex, endIndex).map((item, index) => (
      <React.Fragment key={startIndex + index}>
        {renderItem(item)}
      </React.Fragment>
    ));
  }
}
```

---

## 四、构建与打包

### 4.1 优化配置

```json
// electron-builder.json
{
  "appId": "com.jiabaixing.desktop",
  "productName": "家百星桌面版",
  "directories": {
    "output": "dist-electron"
  },
  "files": ["build/**/*", "electron/**/*", "assets/**/*"],
  "mac": {
    "category": "public.app-category.productivity",
    "icon": "assets/icon.icns",
    "target": ["dmg", "zip"],
    "hardenedRuntime": true,
    "gatekeeperAssess": false
  },
  "win": {
    "icon": "assets/icon.ico",
    "target": ["nsis", "portable"],
    "requestedExecutionLevel": "asInvoker"
  },
  "linux": {
    "icon": "assets/icons",
    "target": ["AppImage", "deb", "rpm"],
    "category": "Utility"
  },
  "nsis": {
    "oneClick": false,
    "perMachine": false,
    "allowToChangeInstallationDirectory": true
  },
  "compression": "maximum",
  "asar": true,
  "asarUnpack": ["node_modules/better-sqlite3/**/*"]
}
```

### 4.2 性能优化构建

```javascript
// scripts/build-desktop.js
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class DesktopBuilder {
  constructor() {
    this.distDir = path.join(__dirname, '../dist-electron');
    this.buildDir = path.join(__dirname, '../build');
  }

  async build() {
    console.log('🚀 开始构建桌面应用...');

    // 1. 清理旧构建
    this.clean();

    // 2. 构建前端
    await this.buildFrontend();

    // 3. 优化资源
    await this.optimizeAssets();

    // 4. 打包Electron
    await this.packageElectron();

    // 5. 验证构建
    await this.verifyBuild();

    console.log('✅ 构建完成！');
  }

  clean() {
    console.log('🧹 清理旧构建...');
    if (fs.existsSync(this.distDir)) {
      fs.rmSync(this.distDir, { recursive: true });
    }
  }

  async buildFrontend() {
    console.log('🔨 构建前端...');
    execSync('cd src/frontend && npm run build:fast', {
      stdio: 'inherit',
    });
  }

  async optimizeAssets() {
    console.log('⚡ 优化资源...');

    // 压缩图片
    const assetsDir = path.join(__dirname, '../assets');
    if (fs.existsSync(assetsDir)) {
      // 这里可以集成图片压缩工具
      console.log('  图片优化完成');
    }

    // 清理不必要的文件
    const filesToDelete = [
      'build/**/*.map',
      'build/**/*.js.map',
      'build/**/*.css.map',
    ];

    filesToDelete.forEach((pattern) => {
      // 实现文件删除逻辑
    });
  }

  async packageElectron() {
    console.log('📦 打包Electron...');
    execSync('npx electron-builder --config electron-builder.json', {
      stdio: 'inherit',
    });
  }

  async verifyBuild() {
    console.log('🔍 验证构建...');

    const requiredFiles = [
      'dist-electron/家百星桌面版-Setup.exe',
      'dist-electron/家百星桌面版.dmg',
      'dist-electron/家百星桌面版.AppImage',
    ];

    requiredFiles.forEach((file) => {
      if (fs.existsSync(file)) {
        console.log(`  ✅ ${file}`);
      } else {
        console.log(`  ❌ ${file} 未生成`);
      }
    });
  }
}

// 执行构建
const builder = new DesktopBuilder();
builder.build().catch(console.error);
```

---

## 五、测试策略

### 5.1 测试计划

| 测试类型       | 工具            | 覆盖范围            | 优先级 |
| -------------- | --------------- | ------------------- | ------ |
| **单元测试**   | Jest            | 组件、工具函数      | P0     |
| **集成测试**   | Testing Library | 组件交互            | P0     |
| **E2E测试**    | Playwright      | 完整流程            | P1     |
| **性能测试**   | Lighthouse      | 性能指标            | P1     |
| **跨平台测试** | 手动 + CI       | Windows/macOS/Linux | P2     |

### 5.2 性能基准

| 指标             | 目标值  | 测量方法           |
| ---------------- | ------- | ------------------ |
| **冷启动时间**   | < 2秒   | Electron app ready |
| **热启动时间**   | < 500ms | 窗口显示时间       |
| **内存占用**     | < 150MB | 空闲状态           |
| **CPU使用率**    | < 5%    | 空闲状态           |
| **消息发送延迟** | < 100ms | 端到端延迟         |
| **UI响应时间**   | < 16ms  | 60fps渲染          |

### 5.3 测试用例

```typescript
// tests/desktop/e2e/desktop-app.test.ts
import { test, expect } from '@playwright/test';

test.describe('桌面应用E2E测试', () => {
  test('应用启动和窗口显示', async ({ page }) => {
    // 启动应用
    await page.goto('/');

    // 验证窗口标题
    await expect(page).toHaveTitle(/家百星/);

    // 验证主界面元素
    await expect(page.locator('.lightweight-chat')).toBeVisible();
    await expect(page.locator('.input-area')).toBeVisible();
  });

  test('系统托盘功能', async ({ page }) => {
    // 验证托盘图标
    await expect(page.locator('.tray-icon')).toBeVisible();

    // 点击托盘图标
    await page.click('.tray-icon');

    // 验证托盘菜单
    await expect(page.locator('.tray-menu')).toBeVisible();
    await expect(page.locator('.tray-menu-item')).toHaveCount(6);
  });

  test('全局快捷键', async ({ page }) => {
    // 测试快速对话快捷键
    await page.keyboard.press('Control+Shift+Space');

    // 验证快速对话窗口
    await expect(page.locator('.quick-chat-window')).toBeVisible();

    // 关闭快速对话窗口
    await page.keyboard.press('Escape');
    await expect(page.locator('.quick-chat-window')).not.toBeVisible();
  });

  test('消息发送和接收', async ({ page }) => {
    // 输入消息
    await page.fill('.input-area textarea', '你好');

    // 发送消息
    await page.click('.input-area button');

    // 验证消息显示
    await expect(page.locator('.message-bubble')).toContainText('你好');

    // 等待AI回复
    await expect(page.locator('.message-bubble.ai')).toBeVisible({
      timeout: 10000,
    });
  });
});
```

---

## 六、部署与分发

### 6.1 自动更新

```typescript
// electron/auto-update/Updater.ts
import { autoUpdater } from 'electron-updater';
import { app, dialog } from 'electron';

export class Updater {
  constructor() {
    this.setupUpdater();
  }

  setupUpdater() {
    // 检查更新
    autoUpdater.checkForUpdatesAndNotify();

    // 更新可用
    autoUpdater.on('update-available', (info) => {
      dialog
        .showMessageBox({
          type: 'info',
          title: '更新可用',
          message: `新版本 ${info.version} 可用`,
          buttons: ['立即更新', '稍后更新'],
        })
        .then(({ response }) => {
          if (response === 0) {
            autoUpdater.downloadUpdate();
          }
        });
    });

    // 更新下载完成
    autoUpdater.on('update-downloaded', () => {
      dialog
        .showMessageBox({
          type: 'info',
          title: '更新就绪',
          message: '更新已下载，重启应用以安装',
          buttons: ['立即重启', '稍后重启'],
        })
        .then(({ response }) => {
          if (response === 0) {
            autoUpdater.quitAndInstall();
          }
        });
    });

    // 更新错误
    autoUpdater.on('error', (error) => {
      console.error('更新错误:', error);
    });
  }
}
```

### 6.2 分发渠道

| 平台        | 分发方式                   | 文件格式              |
| ----------- | -------------------------- | --------------------- |
| **Windows** | 官网下载 + Microsoft Store | .exe (NSIS)           |
| **macOS**   | 官网下载 + Mac App Store   | .dmg                  |
| **Linux**   | 官网下载 + 包管理器        | .AppImage, .deb, .rpm |

### 6.3 安装脚本

```bash
#!/bin/bash
# install-desktop.sh

echo "🚀 安装家百星桌面版..."

# 检测操作系统
OS=$(uname -s)
case $OS in
  Darwin*)
    echo "检测到 macOS"
    PLATFORM="mac"
    ;;
  Linux*)
    echo "检测到 Linux"
    PLATFORM="linux"
    ;;
  MINGW*|CYGWIN*|MSYS*)
    echo "检测到 Windows"
    PLATFORM="win"
    ;;
  *)
    echo "不支持的操作系统: $OS"
    exit 1
    ;;
esac

# 下载最新版本
VERSION=$(curl -s https://api.github.com/repos/jiabaixing/desktop/releases/latest | grep tag_name | cut -d '"' -f 4)
echo "最新版本: $VERSION"

# 根据平台下载
case $PLATFORM in
  mac)
    URL="https://github.com/jiabaixing/desktop/releases/download/${VERSION}/家百星-${VERSION}.dmg"
    ;;
  linux)
    URL="https://github.com/jiabaixing/desktop/releases/download/${VERSION}/家百星-${VERSION}.AppImage"
    ;;
  win)
    URL="https://github.com/jiabaixing/desktop/releases/download/${VERSION}/家百星-${VERSION}.exe"
    ;;
esac

echo "下载地址: $URL"
curl -L -o "jiabaixing-desktop.${PLATFORM}" "$URL"

# 安装
case $PLATFORM in
  mac)
    echo "请拖动应用到 Applications 文件夹"
    open "jiabaixing-desktop.mac"
    ;;
  linux)
    chmod +x "jiabaixing-desktop.linux"
    ./jiabaixing-desktop.linux
    ;;
  win)
    echo "请运行安装程序"
    ./jiabaixing-desktop.exe
    ;;
esac

echo "✅ 安装完成！"
```

---

## 七、开发计划

### 7.1 里程碑

| 阶段                    | 时间     | 交付物                  | 负责人     |
| ----------------------- | -------- | ----------------------- | ---------- |
| **Phase 1: 基础架构**   | 第1-2周  | Electron主进程、IPC通信 | 前端工程师 |
| **Phase 2: 轻量UI**     | 第3-4周  | 轻量界面、虚拟滚动      | 前端工程师 |
| **Phase 3: 系统集成**   | 第5-6周  | 托盘、快捷键、通知      | 前端工程师 |
| **Phase 4: 性能优化**   | 第7-8周  | 内存优化、渲染优化      | 前端工程师 |
| **Phase 5: 测试与发布** | 第9-10周 | E2E测试、跨平台构建     | 测试工程师 |

### 7.2 资源需求

| 角色           | 人数 | 技能要求                    |
| -------------- | ---- | --------------------------- |
| **前端工程师** | 2    | Electron, React, TypeScript |
| **测试工程师** | 1    | Playwright, Jest, 性能测试  |
| **UI设计师**   | 1    | 桌面UI设计，用户体验        |
| **DevOps**     | 1    | CI/CD，跨平台构建           |

### 7.3 风险评估

| 风险                 | 影响 | 概率 | 缓解措施           |
| -------------------- | ---- | ---- | ------------------ |
| **跨平台兼容性问题** | 高   | 中   | 早期多平台测试     |
| **性能不达标**       | 高   | 中   | 性能监控，持续优化 |
| **Electron安全漏洞** | 中   | 低   | 及时更新，安全审计 |
| **用户接受度低**     | 中   | 低   | 用户调研，迭代优化 |

---

## 八、总结

本方案设计了一个**轻量化、原生体验、无缝集成**的桌面端应用，核心特点：

1. **极速启动**：通过懒加载和优化，实现冷启动 < 2秒
2. **低资源占用**：内存 < 150MB，CPU < 5%
3. **原生体验**：系统托盘、全局快捷键、原生通知
4. **无缝集成**：与现有Web版功能完全兼容
5. **跨平台支持**：Windows、macOS、Linux

通过10周的开发周期，可以交付一个高质量的桌面端应用，提升用户体验，扩大用户群体。
