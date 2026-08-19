#!/usr/bin/env bash
# 家百星 V5.0 一键启动 — 网关 + CLI + 前端
# 用法: ./up.sh [status|stop|restart]

set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
PY_LOG="$ROOT/.jiabaixing/python_backend.log"
PY_PID_FILE="$ROOT/.jiabaixing/python.pid"
DAEMON_DIR="$ROOT/.jiabaixing"

mkdir -p "$DAEMON_DIR"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; }
info() { echo -e "${CYAN}[INFO]${NC} $1"; }

status() {
  local PY_RUNNING=false; local TS_RUNNING=false
  if [ -f "$PY_PID_FILE" ] && kill -0 "$(cat "$PY_PID_FILE")" 2>/dev/null; then PY_RUNNING=true; fi
  if curl -s --max-time 2 http://127.0.0.1:3112/health >/dev/null 2>&1; then PY_RUNNING=true; fi
  if curl -s --max-time 2 http://127.0.0.1:3111/api/health >/dev/null 2>&1; then TS_RUNNING=true; fi
  echo ""
  echo "========================================="
  echo "  家百星 V5.0 状态"
  echo "========================================="
  if $PY_RUNNING; then ok  "Python 后端 (3112)"; else fail "Python 后端 (3112)"; fi
  if $TS_RUNNING; then ok  "TS 网关 (3111)";    else fail "TS 网关 (3111)";    fi
  if $TS_RUNNING; then
    local LLM=$(curl -s --max-time 2 http://127.0.0.1:3111/api/health 2>/dev/null | python -c "import sys,json; d=json.load(sys.stdin); print(d.get('model','?'))" 2>/dev/null || echo "?")
    echo "  模型: $LLM"
  fi
  echo "========================================="
  echo ""
}

start_python() {
  if [ -f "$PY_PID_FILE" ] && kill -0 "$(cat "$PY_PID_FILE")" 2>/dev/null; then
    warn "Python 后端已在运行 (PID $(cat "$PY_PID_FILE"))"
    return 0
  fi
  info "启动 Python 后端 (3112)..."
  cd "$ROOT/python"
  nohup "$ROOT/.venv/Scripts/python.exe" -m uvicorn agent.main:app --host 127.0.0.1 --port 3112 > "$PY_LOG" 2>&1 &
  echo $! > "$PY_PID_FILE"
  cd "$ROOT"
  # 等待就绪（最多 120s）
  local waited=0
  while [ $waited -lt 120 ]; do
    if curl -s --max-time 2 http://127.0.0.1:3112/health >/dev/null 2>&1; then
      ok "Python 后端就绪 (${waited}s)"
      return 0
    fi
    sleep 5
    waited=$((waited + 5))
  done
  fail "Python 后端启动超时 (120s) — 查看日志: $PY_LOG"
  return 1
}

start_gateway() {
  if curl -s --max-time 2 http://127.0.0.1:3111/api/health >/dev/null 2>&1; then
    warn "TS 网关已在运行"
    return 0
  fi
  info "启动 TS 网关 (3111)..."
  cd "$ROOT"
  # 清理旧 daemon 状态
  rm -f "$DAEMON_DIR/daemon.json" 2>/dev/null || true
  npm run cli daemon start 2>/dev/null
  # 等待就绪（最多 30s）
  local waited=0
  while [ $waited -lt 30 ]; do
    if curl -s --max-time 2 http://127.0.0.1:3111/api/health >/dev/null 2>&1; then
      ok "TS 网关就绪 (${waited}s)"
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  fail "TS 网关启动超时 — 查看 daemon 日志"
  return 1
}

stop_python() {
  if [ -f "$PY_PID_FILE" ]; then
    local PID=$(cat "$PY_PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID" 2>/dev/null && ok "Python 后端已停止" || warn "停止 Python 后端失败"
    fi
    rm -f "$PY_PID_FILE"
  fi
  # 也杀残留的 uvicorn 进程
  taskkill //F //IM "python.exe" //FI "WINDOWTITLE eq uvicorn*" 2>/dev/null || true
}

stop_gateway() {
  cd "$ROOT" 2>/dev/null
  npm run cli daemon stop 2>/dev/null && ok "TS 网关已停止" || warn "TS 网关停止失败"
  rm -f "$DAEMON_DIR/daemon.json" 2>/dev/null || true
}

case "${1:-up}" in
  up|start)
    echo "🚀 家百星 V5.0 启动中..."
    start_python
    start_gateway
    echo ""
    ok "全部就绪！"
    echo "  API:       http://localhost:3111"
    echo "  前端:      http://localhost:3111"
    echo "  Python:    http://127.0.0.1:3112"
    echo ""
    status
    ;;
  stop)
    echo "🛑 停止服务..."
    stop_gateway
    stop_python
    ok "已停止"
    ;;
  restart)
    echo "🔄 重启..."
    stop_gateway
    stop_python
    sleep 2
    start_python
    start_gateway
    ok "重启完成"
    status
    ;;
  status)
    status
    ;;
  *)
    echo "用法: ./up.sh [start|stop|restart|status]"
    exit 1
    ;;
esac
