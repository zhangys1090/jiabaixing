/**
 * TrajectoryDatabase — 重导出壳 (Re-export Shell)
 *
 * §0.1 模块归属: 轨迹持久化核心已迁移至 Python
 * (`python/agent/persistence/trajectory.py` + `python/agent/api/trajectory.py`)。
 *
 * 本文件不含任何 `class` 实现，仅将 `TrajectoryDatabaseBridge` 以 `TrajectoryDatabase`
 * 之名重导出，使既有 `import { TrajectoryDatabase }` / `new TrajectoryDatabase()` 调用
 * 零改动解析到桥接回退实现。所有记录类型契约 (ExecutionRecord 等) 一并透传。
 *
 * @deprecated 生产路径应经 `PythonAgentBridge` 桥接 Python 后端；此类仅为本地回退。
 */

export * from './TrajectoryDatabaseBridge';
export { TrajectoryDatabaseBridge as TrajectoryDatabase } from './TrajectoryDatabaseBridge';
