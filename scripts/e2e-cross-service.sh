#!/usr/bin/env bash
# =============================================================================
# jiabaixing 跨服务端到端（E2E）验证脚本
# -----------------------------------------------------------------------------
# 通过 docker compose 启动「网关(TS) + Python 后端(离线 Mock LLM)」完整链路，
# 验证「用户输入 → 网关 → Python → 最终输出」端到端贯通，且任一环节失败即退出非零。
#
# 不依赖任何真实 LLM API 密钥（python-backend 启用 AGENT_MOCK_LLM=1）。
# 由 CI 的 service-e2e job 调用；也可本地手动运行：
#   bash scripts/e2e-cross-service.sh
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

COMPOSE="docker compose -f docker-compose.yml -f docker-compose.e2e.yml"
GATEWAY_URL="http://localhost:3111"
PYTHON_URL="http://localhost:8765"

echo "==> [cross-service-e2e] 构建镜像"
$COMPOSE build

echo "==> [cross-service-e2e] 启动服务"
$COMPOSE up -d

# 无论如何退出都清理容器
cleanup() {
  echo "==> [cross-service-e2e] 清理容器"
  $COMPOSE down -v --remove-orphans || true
}
trap cleanup EXIT

# 等待某个 URL 返回 2xx
wait_for() {
  local url="$1" name="$2" tries=60 i=0
  echo "==> 等待 $name ($url)"
  until curl -fsS "$url" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -ge "$tries" ]; then
      echo "TIMEOUT: 等待 $name 超时"
      $COMPOSE logs --tail=50 python-backend gateway || true
      exit 1
    fi
    sleep 2
  done
  echo "    $name 已就绪"
}

wait_for "$GATEWAY_URL/api/health" "gateway(3111)"
wait_for "$PYTHON_URL/health" "python-backend(8765)"

# ---- 测试 1：网关健康检查 ----
echo "==> [T1] 网关健康检查 /api/health"
GW_HEALTH="$(curl -fsS "$GATEWAY_URL/api/health")"
echo "    $GW_HEALTH"
echo "$GW_HEALTH" | grep -q '"status"' || { echo "FAIL: 网关健康检查缺少 status 字段"; exit 1; }

# ---- 测试 2：Python 后端直接对话（离线 Mock LLM 端到端） ----
echo "==> [T2] Python /v1/chat（直接，验证后端完整链路）"
PY_RESP="$(curl -fsS -X POST "$PYTHON_URL/v1/chat" \
  -H 'Content-Type: application/json' \
  -d '{"message":"你好，家百星","session_id":"e2e-py"}')"
echo "    $PY_RESP"
echo "$PY_RESP" | grep -q '"content"' || { echo "FAIL: Python 对话响应缺少 content"; exit 1; }

# ---- 测试 3：网关 → Python 跨服务链路（核心验证） ----
echo "==> [T3] 网关 /api/chat（完整链路 网关→Python→输出）"
GW_RESP="$(curl -fsS -X POST "$GATEWAY_URL/api/chat" \
  -H 'Content-Type: application/json' \
  -d '{"message":"你好，家百星","session_id":"e2e-gw"}')"
echo "    $GW_RESP"
echo "$GW_RESP" | grep -q '"content"' || { echo "FAIL: 网关对话响应缺少 content（跨服务链路中断）"; exit 1; }

echo ""
echo "==> ✅ 全部跨服务 E2E 检查通过（用户输入 → 网关 → Python → 输出 完整链路贯通）"
