#!/bin/bash
# jiabaixing-dev — 家百星多Agent开发调度入口
# 用法: jiabaixing-dev <角色> <任务描述>
# 角色: architect | frontend | backend | auditor | qa | all
# 示例: jiabaixing-dev architect "评审data/目录要不要放到.gitignore"
#       jiabaixing-dev backend "添加新的LLM提供商配置热加载"
#       jiabaixing-dev all "跑一遍 check:all 然后报告结果"

set -e

JIABAIXING_DIR="/mnt/c/zy/jiabaixing"
ROLE="${1:-help}"
shift 2>/dev/null || true
TASK="${*:-}"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
NC='\033[0m'

show_help() {
  echo -e "${CYAN}Jiabaixing 多Agent开发调度${NC}"
  echo ""
  echo "用法:"
  echo "  jiabaixing-dev <角色> <任务描述>"
  echo ""
  echo "角色:"
  echo "  architect  架构师 — 系统设计/重构/技术选型"
  echo "  frontend   前端工程师 — React组件/页面"
  echo "  backend    后端工程师 — API/业务逻辑/Harness"
  echo "  auditor    代码审计师 — 质量审查/合规检查"
  echo "  qa         测试工程师 — 测试编写/回归验证"
  echo "  all        全流程 — 从架构到测试"
  echo ""
  echo "示例:"
  echo "  jiabaixing-dev architect \"评审添加MiMo新provider的方案\""
  echo "  jiabaixing-dev backend \"修复工具调用去重守卫null指针\""
  echo "  jiabaixing-dev qa \"为新增API端点写集成测试\""
  echo "  jiabaixing-dev all \"做一个穿透Demo: 分析->图表->推送\""
}

case "$ROLE" in
  help|-h|--help)
    show_help
    ;;
  architect)
    echo -e "${CYAN}🧠 架构师模式${NC}"
    echo -e "${DIM}系统设计/重构/技术选型${NC}"
    echo ""
    echo "请阅读 AGENTS.md 获取架构师职责细则"
    echo "关键文档: PROJECT.md, DEVELOPER_GUIDE.md, src/config/"
    echo ""
    echo -e "${YELLOW}任务:${NC} ${TASK:-（无具体描述）}"
    ;;
  frontend)
    echo -e "${GREEN}🔧 前端工程师模式${NC}"
    echo -e "${DIM}React/TypeScript 组件${NC}"
    echo ""
    echo "范围: src/frontend/"
    echo "测试: cd src/frontend && npm test"
    echo ""
    echo -e "${YELLOW}任务:${NC} ${TASK:-（无具体描述）}"
    ;;
  backend)
    echo -e "${BLUE}⚙️ 后端工程师模式${NC}"
    echo -e "${DIM}Express API / Harness / 业务逻辑${NC}"
    echo ""
    echo "范围: src/ 排除 src/frontend/"
    echo "测试: npm test"
    echo "类型检查: npx tsc --noEmit"
    echo ""
    echo -e "${YELLOW}任务:${NC} ${TASK:-（无具体描述）}"
    ;;
  auditor)
    echo -e "${MAGENTA}🔍 代码审计师模式${NC}"
    echo -e "${DIM}质量审查/合规检查/安全审计${NC}"
    echo ""
    echo "运行审计:"
    echo "  cd $JIABAIXING_DIR && npm run check:all"
    echo "审计清单见 AGENTS.md"
    echo ""
    echo -e "${YELLOW}任务:${NC} ${TASK:-（无具体描述）}"
    ;;
  qa)
    echo -e "${YELLOW}🧪 测试工程师模式${NC}"
    echo -e "${DIM}测试编写/回归验证${NC}"
    echo ""
    echo "运行全部测试: npm test"
    echo "单文件测试: npx jest tests/xxx -v"
    echo "覆盖率: npm run test:coverage"
    echo ""
    echo -e "${YELLOW}任务:${NC} ${TASK:-（无具体描述）}"
    ;;
  all)
    echo -e "${CYAN}🔁 全流程开发模式${NC}"
    echo "遵循 AGENTS.md 标准开发循环"
    echo "1. 架构师 → 2. 分任务 → 3. 前后端并行 → 4. QA测试 → 5. 审计审查"
    echo ""
    echo -e "${YELLOW}任务:${NC} ${TASK:-（无具体描述）}"
    ;;
  *)
    echo -e "${RED}未知角色: $ROLE${NC}"
    show_help
    exit 1
    ;;
esac
