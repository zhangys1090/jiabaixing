# 环境搭建指南

本文档详细描述了jiabaixing项目的开发环境搭建步骤，帮助开发者快速搭建本地开发环境。

## 目录

1. [环境要求](#环境要求)
2. [安装Node.js](#安装nodejs)
3. [安装Git](#安装git)
4. [克隆代码](#克隆代码)
5. [安装依赖](#安装依赖)
6. [配置环境变量](#配置环境变量)
7. [验证安装](#验证安装)
8. [常见问题](#常见问题)

## 环境要求

### 硬件要求

| 项目 | 最低要求 | 推荐配置 |
|------|----------|----------|
| CPU | 4核心 | 8核心或以上 |
| 内存 | 8GB | 16GB或以上 |
| 硬盘 | 10GB可用空间 | 20GB或以上 SSD |

### 软件要求

| 软件 | 版本要求 | 说明 |
|------|----------|------|
| Node.js | 18.x 或以上 | 后端运行环境 |
| npm | 9.x 或以上 | 包管理器 |
| Git | 2.x 或以上 | 版本控制 |
| VS Code | 最新版 | 推荐编辑器 |

## 安装Node.js

### Windows系统

1. 访问 [Node.js官网](https://nodejs.org/)
2. 下载LTS版本（建议18.x或以上）
3. 运行安装程序，一路Next即可
4. 验证安装：

```bash
node -v
npm -v
```

### macOS系统

使用Homebrew安装：

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node@18
```

验证安装：

```bash
node -v
npm -v
```

### Linux系统

使用NodeSource安装：

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

验证安装：

```bash
node -v
npm -v
```

## 安装Git

### Windows系统

1. 访问 [Git官网](https://git-scm.com/)
2. 下载Windows版本
3. 运行安装程序，建议选项：
   - 选择VS Code作为默认编辑器
   - 勾选 "Use Git from Git Bash only"
   - 勾选 "Enable Git Credential Manager"
   - 选择 "Checkout as-is, commit as-is"

### macOS系统

```bash
brew install git
```

### Linux系统

```bash
sudo apt-get install git
```

验证安装：

```bash
git --version
```

## 克隆代码

1. 打开终端/命令行
2. 进入工作目录：

```bash
cd ~/workspace
```

3. 克隆代码仓库：

```bash
git clone https://github.com/example/jiabaixing.git
```

4. 进入项目目录：

```bash
cd jiabaixing
```

## 安装依赖

### 安装后端依赖

```bash
npm install
```

### 安装前端依赖

```bash
cd src/frontend
npm install
cd ../..
```

### 安装开发工具

```bash
npm install -g typescript ts-node
```

## 配置环境变量

1. 复制环境变量模板：

```bash
cp .env.example .env
```

2. 编辑环境变量文件：

```bash
# 后端服务配置
PORT=3101
NODE_ENV=development

# Ollama配置
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5-3b-instruct-q4_k_m.gguf

# 数据库配置
CHROMA_HOST=localhost
CHROMA_PORT=8000
```

3. 配置前端环境变量（在 `src/frontend/` 目录下）：

```bash
cd src/frontend
cp .env.example .env
```

## 验证安装

### 启动后端服务

```bash
npm run start
```

应该看到类似输出：

```
🚀 启动jiabaixing智能助手系统...
📡 服务器配置：0.0.0.0:3101
🧠 初始化智能助手核心引擎...
✅ 智能助手核心引擎初始化完成
🚀 后端API服务器已启动，监听 0.0.0.0:3101
```

### 启动前端开发服务器

```bash
cd src/frontend
npm start
```

应该看到类似输出：

```
Compiled successfully!

You can now view frontend in the browser.

Local: http://localhost:3000
```

### 访问应用

打开浏览器访问：

- 前端应用：http://localhost:3000
- API健康检查：http://localhost:3101/api/health

## 常见问题

### 问题1：npm install失败

**症状**：安装依赖时报错

**解决方案**：

1. 清除npm缓存：

```bash
npm cache clean --force
```

2. 删除node_modules目录：

```bash
rm -rf node_modules
```

3. 重新安装：

```bash
npm install
```

### 问题2：端口被占用

**症状**：启动服务时报错 "Port already in use"

**解决方案**：

1. 查找占用端口的进程：

```bash
# Windows
netstat -ano | findstr :3101

# macOS/Linux
lsof -i :3101
```

2. 结束占用进程或修改端口

### 问题3：TypeScript编译错误

**症状**：TypeScript类型检查失败

**解决方案**：

1. 确保安装了TypeScript：

```bash
npm install -g typescript
```

2. 编译检查：

```bash
npx tsc --noEmit
```

### 问题4：Git提交失败

**症状**：Git提交时报错

**解决方案**：

1. 配置Git用户信息：

```bash
git config --global user.name "Your Name"
git config --global user.email "your.email@example.com"
```

2. 确保已添加远程仓库：

```bash
git remote -v
```

## 下一步

环境搭建完成后，建议继续阅读：

- [快速开始](./quick-start.md) - 快速上手项目开发
- [开发流程](../development/development-workflow.md) - 开发流程指南
- [代码规范](../development/code-standards.md) - 代码编写规范
