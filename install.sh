#!/bin/bash
# Jiabaixing V5.0 — 一键安装脚本
# ====================================
# 用法:
#   curl -fsSL https://jiabaixing.ai/install.sh | bash
#   或: bash install.sh
#
# 自动完成: 检查依赖 → 安装 → npm install → 配置向导 → 验证启动

set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; MAGENTA='\033[0;35m'; DIM='\033[2m'; BOLD='\033[1m'; NC='\033[0m'

echo ""
echo -e "${CYAN}  ╔══════════════════════════════════════╗${NC}"
echo -e "${CYAN}  ║${NC}                                      ${CYAN}║${NC}"
echo -e "${CYAN}  ║${NC}  ${MAGENTA}✦${NC} ${BOLD}家百星${NC} · ${DIM}V5.0 Harness${NC}         ${CYAN}║${NC}"
echo -e "${CYAN}  ║${NC}      ${DIM}一键安装 · AI Agent Framework${NC}   ${CYAN}║${NC}"
echo -e "${CYAN}  ║${NC}                                      ${CYAN}║${NC}"
echo -e "${CYAN}  ╚══════════════════════════════════════╝${NC}"
echo ""

# ─── 步骤1: 检查环境 ───
echo -e "  ${BOLD}步骤 1/4: 检查运行环境${NC}"

if ! command -v node &>/dev/null; then
  echo -e "  ${RED}❌ 未安装 Node.js${NC}"
  echo -e "  请先安装 Node.js >= 20.x"
  echo -e "  推荐: https://nodejs.org 或 nvm"
  exit 1
fi

NODE_VER=$(node --version 2>/dev/null)
NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
echo -e "  ${GREEN}✅${NC} Node.js ${NODE_VER}"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo -e "  ${YELLOW}⚠️  需要 Node.js >= 20.x${NC}"; exit 1
fi

if ! command -v npm &>/dev/null; then
  echo -e "  ${RED}❌ 未安装 npm${NC}"; exit 1
fi
echo -e "  ${GREEN}✅${NC} npm $(npm --version)"

if ! command -v make &>/dev/null || ! command -v gcc &>/dev/null; then
  echo -e "  ${YELLOW}⚠️  缺少编译工具链，better-sqlite3 可能编译失败${NC}"
  echo -e "  ${DIM}Ubuntu: sudo apt install build-essential python3${NC}"
fi

echo ""

# ─── 步骤2: 定位项目 ───
echo -e "  ${BOLD}步骤 2/4: 定位项目${NC}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR"

if [ ! -f "$PROJECT_DIR/package.json" ]; then
  if [ -f "./package.json" ] && grep -q "jiabaixing" "./package.json" 2>/dev/null; then
    PROJECT_DIR=$(pwd)
  else
    echo -e "  ${YELLOW}⚠️  请在 jiabaixing 项目目录运行${NC}"
    exit 1
  fi
fi

echo -e "  ${GREEN}✅${NC} 项目目录: ${DIM}$PROJECT_DIR${NC}"
cd "$PROJECT_DIR"
echo ""

# ─── 步骤3: 安装依赖 ───
echo -e "  ${BOLD}步骤 3/4: 安装 npm 依赖${NC}"

if [ -d "node_modules" ]; then
  echo -e "  ${GREEN}✅${NC} node_modules 已存在"
  if ! node -e "require('better-sqlite3')" 2>/dev/null; then
    echo -e "  ${YELLOW}▶  重新编译 better-sqlite3...${NC}"
    npm rebuild better-sqlite3 2>&1 | tail -1
  fi
else
  echo -e "  ${YELLOW}▶  安装依赖（可能需要 1-2 分钟）...${NC}"
  npm install 2>&1 | tail -5
fi
echo -e "  ${GREEN}✅${NC} 依赖就绪"
echo ""

# ─── 步骤4: 配置向导 + 验证 ───
echo -e "  ${BOLD}步骤 4/4: 配置 LLM 模型${NC}"

# 先检测是否有已配置的 Key
HAS_KEY=false
if [ -f .env ]; then
  for key_var in DEEPSEEK_API_KEY XIAOMI_API_KEY OPENAI_API_KEY; do
    val=$(grep "^${key_var}=" .env 2>/dev/null | head -1 | cut -d= -f2-)
    if [ -n "$val" ] && [ "$val" != "your_*" ] && [ "$val" != "***" ] && [ "$val" != "" ]; then
      HAS_KEY=true
      break
    fi
  done
fi

if [ "$HAS_KEY" = true ]; then
  echo -e "  ${GREEN}✅${NC} 检测到已有 API Key 配置"
else
  echo ""
  echo "  请选择一个 AI 模型提供商:"
  echo "  ${DIM}────────────────────────────────────────────${NC}"
  echo "  ${BOLD}1) DeepSeek${NC}   — 性价比之选，国内直连"
  echo "  ${BOLD}2) 小米 MiMo${NC}  — mimo-v2.5-pro, 1M上下文"
  echo "  ${BOLD}3) OpenAI${NC}     — GPT-4o / GPT-4o-mini"
  echo "  ${BOLD}4) 跳过${NC}       — 稍后通过 npm run setup 配置"
  echo "  ${DIM}────────────────────────────────────────────${NC}"
  echo ""
  echo -ne "  ${CYAN}选择 (1-4)${NC}: "
  read -r CHOICE

  case "$CHOICE" in
    1)
      echo -ne "  输入 DeepSeek API Key: "
      read -r KEY
      if [ -n "$KEY" ]; then
        echo "DEEPSEEK_API_KEY=$KEY" >> .env
        echo "OPENAI_API_KEY=$KEY" >> .env
        echo "OPENAI_API_BASE=https://api.deepseek.com" >> .env
        echo "LLM_MODEL=deepseek-chat" >> .env
        echo -e "  ${GREEN}✅ DeepSeek 已配置${NC}"
      fi
      ;;
    2)
      echo -ne "  输入小米 MiMo API Key: "
      read -r KEY
      if [ -n "$KEY" ]; then
        echo "XIAOMI_API_KEY=$KEY" >> .env
        echo "XIAOMI_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1" >> .env
        echo "XIAOMI_MODEL=mimo-v2.5-pro" >> .env
        echo -e "  ${GREEN}✅ 小米 MiMo 已配置${NC}"
      fi
      ;;
    3)
      echo -ne "  输入 OpenAI API Key: "
      read -r KEY
      if [ -n "$KEY" ]; then
        echo "OPENAI_API_KEY=$KEY" >> .env
        echo "OPENAI_API_BASE=https://api.openai.com/v1" >> .env
        echo "LLM_MODEL=gpt-4o-mini" >> .env
        echo -e "  ${GREEN}✅ OpenAI 已配置${NC}"
      fi
      ;;
    *)
      echo -e "  ${YELLOW}⏸  跳过配置，稍后可执行: npm run setup${NC}"
      ;;
  esac
fi

# 导入到 ProviderManager
if [ -f .env ] && grep -q "API_KEY" .env 2>/dev/null; then
  echo ""
  echo -e "  ${YELLOW}▶  导入配置到 ProviderManager...${NC}"
  npx tsx --env-file=.env -e "
    const { getProviderManager } = require('./src/models/ProviderManager');
    getProviderManager().importFromEnv();
    console.log('  ${GREEN}✅${NC} 配置已导入');
  " 2>/dev/null || echo -e "  ${YELLOW}⚠️  导入跳过（可稍后执行 npm run setup:list 查看）${NC}"
fi

echo ""
echo -e "  ${GREEN}${BOLD}✅  安装完成!${NC}"
echo ""
echo -e "  ${BOLD}启动方式${NC}"
echo -e "  ${DIM}────────────────────────────────────────${NC}"
echo -e "  ${CYAN}▶${NC} 一键启动:  ${DIM}./run.sh${NC}"
echo -e "  ${CYAN}▶${NC} 配置向导:  ${DIM}npm run setup${NC}"
echo -e "  ${CYAN}▶${NC} 查看配置:  ${DIM}npm run setup:list${NC}"
echo -e "  ${CYAN}▶${NC} 测试连接:  ${DIM}npm run setup:test${NC}"
echo -e "  ${DIM}────────────────────────────────────────${NC}"
echo ""
echo -e "  ${BOLD}访问${NC}"
echo -e "  ${DIM}────────────────────────────────────────${NC}"
echo -e "  ${CYAN}API${NC}        http://localhost:3111"
echo -e "  ${CYAN}前端${NC}       http://localhost:3111/"
echo -e "  ${DIM}────────────────────────────────────────${NC}"
echo ""
