#!/usr/bin/env bash
# =============================================================================
# 家百星 P2-3 E2E Smoke Test — Python 后端模式闭环验证
# -----------------------------------------------------------------------------
# 用途：在「联调 / K8s」环境中验证 AGENT_BACKEND=python 模式下的端到端链路：
#   1. TS 网关健康          GET  {TS_GW}/api/health
#   2. Python 后端健康       GET  {PY_BACKEND}/health
#   3. 进化状态委派          GET  {TS_GW}/api/evolution/status   (python 委派)
#   4. 触发进化委派          POST {TS_GW}/api/orchestrator/optimize (python 委派)
#   5. 对话委派（尽力）      POST {TS_GW}/api/chat                (需 LLM 密钥)
#
# 设计原则：python 模式下 TS 不得独立运行 LLM / 进化核心，所有调用须经
#           PythonAgentBridge 委派到 Python 后端。本脚本验证委派链路可达。
#
# 用法：
#   TS_GW=http://127.0.0.1:3111 PY_BACKEND=http://127.0.0.1:3112 \
#     bash scripts/e2e_smoke_python_backend.sh
#
# 退出码：0 = 全部必需项通过；1 = 有必需项失败。
# =============================================================================
set -uo pipefail

TS_GW="${TS_GW:-http://127.0.0.1:3111}"
PY_BACKEND="${PY_BACKEND:-http://127.0.0.1:3112}"
CURL_OPTS=(--silent --show-error --max-time 10 -H "Content-Type: application/json")

PASS=0
FAIL=0
WARN=0

ok()   { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad()  { echo "  [FAIL] $1 :: $2"; FAIL=$((FAIL+1)); }
warn() { echo "  [WARN] $1 :: $2"; WARN=$((WARN+1)); }

echo "== 家百星 python 模式 E2E smoke =="
echo "   TS_GW=${TS_GW}"
echo "   PY_BACKEND=${PY_BACKEND}"
echo

# ---------------------------------------------------------------------------
echo "[1] TS 网关健康  GET ${TS_GW}/api/health"
code=$(curl "${CURL_OPTS[@]}" -o /tmp/ts_health.json -w '%{http_code}' "${TS_GW}/api/health" 2>/tmp/ts_health.err) || {
  bad "TS 网关不可达" "$(cat /tmp/ts_health.err)"; }
if [ "$code" = "200" ]; then ok "TS /api/health -> 200"; else bad "TS /api/health" "HTTP $code"; fi

# ---------------------------------------------------------------------------
echo "[2] Python 后端健康  GET ${PY_BACKEND}/health"
code=$(curl "${CURL_OPTS[@]}" -o /tmp/py_health.json -w '%{http_code}' "${PY_BACKEND}/health" 2>/tmp/py_health.err) || {
  bad "Python 后端不可达" "$(cat /tmp/py_health.err)"; }
if [ "$code" = "200" ]; then ok "PY /health -> 200"; else bad "PY /health" "HTTP $code"; fi

# ---------------------------------------------------------------------------
echo "[3] 进化状态委派  GET ${TS_GW}/api/evolution/status"
code=$(curl "${CURL_OPTS[@]}" -o /tmp/ev_status.json -w '%{http_code}' "${TS_GW}/api/evolution/status" 2>/tmp/ev_status.err) || {
  bad "进化状态请求失败" "$(cat /tmp/ev_status.err)"; }
if [ "$code" = "200" ]; then ok "TS /api/evolution/status -> 200 (委派 python)"; else bad "TS /api/evolution/status" "HTTP $code"; fi

# ---------------------------------------------------------------------------
echo "[4] 触发进化委派  POST ${TS_GW}/api/orchestrator/optimize"
code=$(curl "${CURL_OPTS[@]}" -X POST -d '{"reason":"e2e-smoke"}' \
  -o /tmp/ev_opt.json -w '%{http_code}' "${TS_GW}/api/orchestrator/optimize" 2>/tmp/ev_opt.err) || {
  bad "触发进化请求失败" "$(cat /tmp/ev_opt.err)"; }
if [ "$code" = "200" ]; then ok "TS /api/orchestrator/optimize -> 200 (委派 python)"; else bad "TS /api/orchestrator/optimize" "HTTP $code"; fi

# ---------------------------------------------------------------------------
echo "[5] 对话委派（尽力，需 LLM 密钥）  POST ${TS_GW}/api/chat"
code=$(curl "${CURL_OPTS[@]}" -X POST -d '{"message":"ping"}' \
  -o /tmp/chat.json -w '%{http_code}' "${TS_GW}/api/chat" 2>/tmp/chat.err) || {
  warn "对话请求异常" "$(cat /tmp/chat.err)"; }
if [ "$code" = "200" ]; then
  txt=$(grep -o '"text"[^,]*' /tmp/chat.json | head -1)
  if [ -n "$txt" ]; then ok "TS /api/chat -> 200 且返回文本"; else warn "TS /api/chat" "200 但无 text 字段"; fi
else
  warn "TS /api/chat" "HTTP $code（可能因未配置 LLM 密钥，非阻塞）"
fi

# ---------------------------------------------------------------------------
echo
echo "==================== 结果 ===================="
echo "  PASS=${PASS}  FAIL=${FAIL}  WARN=${WARN}"
if [ "$FAIL" -gt 0 ]; then
  echo "  >>> 闭环未通过：存在必需项失败"
  exit 1
else
  echo "  >>> 闭环通过：python 模式委派链路可达"
  exit 0
fi
