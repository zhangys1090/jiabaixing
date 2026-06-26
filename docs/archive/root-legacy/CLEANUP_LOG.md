# Workflows 清理日志

**日期**: 2026-06-08
**操作**: 归档从未运行的工作流 JSON 文件

---

## 清理前

| 指标                            | 数值 |
| ------------------------------- | ---- |
| workflows/ 总文件数             | 854  |
| 有运行记录的文件 (有 lastRunAt) | 488  |
| 从未运行的文件 (无 lastRunAt)   | 366  |

## 清理操作

1. 创建归档目录: `.jiabaixing/workflows-archive/`
2. 将 366 个从未运行的工作流 JSON 文件从 `.jiabaixing/workflows/` 移动到 `.jiabaixing/workflows-archive/`
3. 源代码分析: 无硬编码的工作流 ID 引用，加载方式是动态扫描目录下所有 `.json` 文件

## 清理后

| 指标                        | 数值    |
| --------------------------- | ------- |
| workflows/ 剩余文件         | 488     |
| workflows-archive/ 归档文件 | 366     |
| 磁盘节省                    | ~837 KB |

## 源代码引用检查

- `src/desktop/DesktopWorkflowRecorder.ts` 的 `loadWorkflows()` 方法动态读取 `WORKFLOW_DIR` 下所有 `.json` 文件（第 961-989 行）
- 无硬编码的 `wf_` 工作流 ID 引用
- `src/routes/system.ts` 中的 API 路由通过 `DesktopWorkflowRecorder` 实例操作，不直接引用文件路径
- 移除未运行的工作流文件不会影响系统功能

## 构建检查

- `npm run build` 结果: 构建有预存在的错误（与 workflow 清理无关）
  - `src/security/SecurityManager.ts` — `./SecurityCore` 模块引用错误（已有）
  - `src/frontend/...` — 前端相关错误（已有）
  - 以上错误在清理前即存在，非本次操作导致

## 归档文件分组

所有 366 个归档文件均为 `wf_TIMESTAMP_RANDOM.json` 格式，创建时间戳范围涵盖 2026-05-21 ~ 2026-06-08，均为桌面工作流录制器自动导出，从未被执行过。
