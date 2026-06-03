#!/bin/bash
# Jiabaixing V5.0 - WSL 启动脚本
# ================================
# 在 WSL 环境中一键启动家百星
# 使用: ./run.sh [--no-frontend] [--port PORT]

# 确保 PATH 完整（WSL background 模式容易丢失 PATH）
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:$PATH"

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

NO_FRONTEND=false
PORT=${PORT:-3111}
FRONTEND_PORT=3100

# 解析参数
for arg in "$@"; do
  case "$arg" in
    --no-frontend) NO_FRONTEND=true ;;
    --port=*) PORT="${arg#*=}" ;;
    --help|-h)
      echo "家百星 V5.0 - WSL 启动脚本"
      echo ""
      echo "用法: ./run.sh [选项]"
      echo ""
      echo "选项:"
      echo "  --no-frontend     仅启动后端，不启动前端开发服务器"
      echo "  --port=PORT       指定后端端口（默认: 3111）"
      echo "  --help, -h        显示帮助"
      exit 0
      ;;
  esac
done

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

cleanup() {
  echo ""
  echo -e "${YELLOW}⏹  正在关闭服务...${NC}"
  if [ -n "$BACKEND_PID" ]; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
  if [ -n "$FRONTEND_PID" ]; then
    kill "$FRONTEND_PID" 2>/dev/null || true
  fi
  # 清理 node 进程
  pkill -f "ts-node.*main.ts" 2>/dev/null || true
  pkill -f "react-scripts" 2>/dev/null || true
  echo -e "${GREEN}✅ 已关闭${NC}"
  exit 0
}

trap cleanup SIGINT SIGTERM

# Banner
echo ""
echo -e "${CYAN}  ╔══════════════════════════════════════╗${NC}"
echo -e "${CYAN}  ║${NC}                                      ${CYAN}║${NC}"
echo -e "${CYAN}  ║${NC}  ${MAGENTA}✦${NC} ${BOLD}家百星${NC} · ${DIM}V5.0 Harness${NC}         ${CYAN}║${NC}"
echo -e "${CYAN}  ║${NC}      ${DIM}御姐秘书 · 本地 AI 智能体${NC}       ${CYAN}║${NC}"
echo -e "${CYAN}  ║${NC}                                      ${CYAN}║${NC}"
echo -e "${CYAN}  ╚══════════════════════════════════════╝${NC}"
echo ""

# 检查 Node.js
if ! command -v node &>/dev/null; then
  echo -e "${RED}❌ 未找到 Node.js，请先安装 Node.js >= 20.x${NC}"
  exit 1
fi

NODE_VER=$(node --version)
echo -e "  ${DIM}Node.js${NC}   ${NODE_VER}"

# 检查 .env 和 Provider 配置
HAS_PROVIDER=false
if [ -f .env ]; then
  for key_var in DEEPSEEK_API_KEY XIAOMI_API_KEY OPENAI_API_KEY; do
    val=$(grep "^${key_var}=" .env 2>/dev/null | head -1 | cut -d= -f2-)
    if [ -n "$val" ] && [ "$val" != "your_*" ] && [ "$val" != "***" ] && [ "$val" != "" ]; then
      HAS_PROVIDER=true
      break
    fi
  done
fi

if [ "$HAS_PROVIDER" = false ]; then
  echo -e "${YELLOW}⚠️  未检测到 LLM 配置${NC}"
  echo ""
  echo -e "  首次使用需要先配置 AI 模型:"
  echo -e "  ${CYAN}▶${NC}  ${DIM}npm run setup${NC}    交互式配置向导"
  echo -e "  ${CYAN}▶${NC}  ${DIM}bash install.sh${NC}  一键安装（含配置）"
  echo ""
  echo -e "  ${YELLOW}是否现在打开配置向导? (y/n)${NC} "
  echo -ne "  "
  read -r DO_SETUP
  if [ "$DO_SETUP" = "y" ] || [ "$DO_SETUP" = "Y" ]; then
    npx tsx --env-file=.env src/config/setup.ts
  fi
  echo ""
fi

# 检查 better-sqlite3 原生模块
if ! node -e "require('better-sqlite3')" 2>/dev/null; then
  echo -e "${YELLOW}⚠️  better-sqlite3 需要重新编译...${NC}"
  npm rebuild better-sqlite3 2>/dev/null || {
    echo -e "${RED}❌ better-sqlite3 编译失败，尝试: npm run fix:native${NC}"
    npm run fix:native 2>/dev/null || {
      echo -e "${RED}❌ 请在 jiabaixing 目录执行: npm rebuild better-sqlite3${NC}"
      exit 1
    }
  }
  echo -e "${GREEN}✅ better-sqlite3 编译完成${NC}"
fi

echo ""

# 启动后端
export PORT=$PORT
echo -e "  ${GREEN}▶${NC} 启动后端服务 (端口 ${PORT})..."
npx tsx --env-file=.env src/main.ts &
BACKEND_PID=$!

# 等后端就绪
echo -ne "  ${DIM}等待服务就绪...${NC}"
for i in $(seq 1 30); do
  if curl -s "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
    echo -e "\r  ${GREEN}✅${NC} 后端服务就绪 (${PORT})"
    HEALTH=$(curl -s "http://localhost:$PORT/api/health" 2>/dev/null)
    MODEL=$(echo "$HEALTH" | node -pe "try{JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).model}catch(e){}" 2>/dev/null || echo "deepseek-chat")
    LLM_STATUS=$(echo "$HEALTH" | node -pe "try{JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).llm.available?'✅':'❌'}catch(e){}" 2>/dev/null || echo "?")
    echo -e "  ${DIM}模型${NC}      ${MODEL}  ${LLM_STATUS}"
    break
  fi
  echo -n "."
  sleep 1
done

# 如果后端没就绪，报错退出
if ! curl -s "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
  echo -e "\r${RED}❌ 后端启动超时，请检查日志${NC}"
  kill $BACKEND_PID 2>/dev/null || true
  exit 1
fi

echo ""

# 构建前端静态文件（如果不存在则构建）
if [ "$NO_FRONTEND" = false ]; then
  if [ ! -d "src/frontend/build" ]; then
    echo -e "  ${YELLOW}▶${NC} 构建前端..."
    cd src/frontend
    npm run build:fast 2>/dev/null | grep -E "Compiled|error"
    cd "$SCRIPT_DIR"
    echo -e "  ${GREEN}✅${NC} 前端构建完成"
    echo ""
  fi

  # 输出访问信息
  echo ""
  echo -e "  ┌────────────────────────────────────────────────────┐"
  echo -e "  │ ${BOLD}家百星 · V5.0 Harness${NC}  已就绪                    │"
  echo -e "  ├────────────────────────────────────────────────────┤"
  echo -e "  │ ${CYAN}API${NC}        http://localhost:${PORT}                    │"
  echo -e "  │ ${CYAN}前端${NC}       http://localhost:${PORT}/                    │"
  echo -e "  │ ${CYAN}WebSocket${NC}  ws://localhost:${PORT}                    │"
  echo -e "  │                                                    │"
  echo -e "  │ ${DIM}快速测试:${NC}                                                │"
  echo -e "  │ ${DIM}curl http://localhost:${PORT}/api/health${NC}                │"
  echo -e "  └────────────────────────────────────────────────────┘"
  echo ""
  echo -e "  ${DIM}按 Ctrl+C 停止服务${NC}"
  echo ""
fi

# 等待后端
wait $BACKEND_PID
