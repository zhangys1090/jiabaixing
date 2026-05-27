# jiabaixing 智能助手前端界面

## 项目介绍

这是jiabaixing智能助手的前端界面，基于React + TypeScript开发，提供了一个美观、易用的聊天界面，用于与后端智能助手进行交互。

## 技术栈

- React 18
- TypeScript
- CSS3
- Fetch API

## 项目结构

```
src/frontend/
├── public/
│   ├── favicon.ico          # 网站图标
│   ├── index.html           # HTML模板
│   ├── logo192.png          # 小尺寸Logo
│   ├── logo512.png          # 大尺寸Logo
│   ├── manifest.json        # PWA配置
│   └── robots.txt           # 爬虫配置
├── src/
│   ├── App.css              # 应用样式
│   ├── App.test.tsx         # 应用测试
│   ├── App.tsx              # 应用主组件
│   ├── index.css            # 全局样式
│   ├── index.tsx            # 应用入口
│   ├── logo.svg             # Logo图标
│   ├── react-app-env.d.ts   # React环境声明
│   ├── reportWebVitals.ts   # 性能报告
│   └── setupTests.ts        # 测试设置
├── .gitignore               # Git忽略文件
├── README.md                # 项目说明
├── package-lock.json        # 依赖锁定
├── package.json             # 项目配置
└── tsconfig.json            # TypeScript配置
```

## 功能特点

### 1. 聊天界面
- 支持用户和助手的消息展示
- 消息按时间顺序排列
- 区分用户消息和助手消息的样式
- 显示消息发送时间

### 2. 输入功能
- 文本输入框支持多行输入
- 支持Enter键发送消息（Shift+Enter换行）
- 发送按钮状态根据输入内容动态变化

### 3. 交互反馈
- 发送消息时显示加载状态
- 加载状态显示打字动画
- 网络错误时显示错误提示

### 4. 响应式设计
- 适配不同屏幕尺寸
- 在移动设备上有良好的显示效果

## 安装和运行

### 1. 安装依赖

```bash
cd src/frontend
npm install
```

### 2. 运行开发服务器

```bash
npm start
```

这将启动前端开发服务器，默认监听3000端口。

### 3. 构建生产版本

```bash
npm run build
```

这将在`build`目录下生成生产版本的代码。

## API配置

前端界面默认连接到`http://localhost:3001/api/process`接口，用于发送用户输入并接收助手响应。如果后端服务器的地址或端口不同，可以在`App.tsx`文件中修改API地址。

## 开发指南

### 1. 修改API地址

在`App.tsx`文件中，找到以下代码并修改：

```typescript
const response = await fetch('http://localhost:3001/api/process', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ input: inputText })
});
```

### 2. 自定义样式

所有样式都定义在`App.css`文件中，可以根据需要修改颜色、字体、布局等。

### 3. 添加新功能

如果需要添加新功能，可以在`App.tsx`文件中添加新的组件和逻辑。

## 测试

```bash
npm test
```

这将运行前端项目的测试用例。

## 常见问题

### 1. 前端无法连接到后端

请确保：
- 后端服务器正在运行
- 后端服务器的地址和端口与前端配置一致
- 没有防火墙或网络问题阻止连接

### 2. 消息发送失败

请检查：
- 网络连接是否正常
- 后端服务器是否正常响应
- 输入内容是否符合要求

### 3. 界面显示异常

请尝试：
- 刷新页面
- 清除浏览器缓存
- 检查浏览器控制台是否有错误信息

## 联系方式

如有任何问题或建议，欢迎随时反馈。

---

**jiabaixing 智能助手** - 家百星 · 你的私人御姐秘书 — 28岁，成熟、专业、温暖