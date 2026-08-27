"""多项目工作区管理——WorkspaceManager。

管理多个项目工作区的创建、切换、导入导出和上下文检测。
使用 JSON 文件存储（DATA_DIR/workspaces.json），支持工作区上下文
集成 CodingContextDetector 和 SubdirectoryHints。

Usage:
    from agent.persistence.workspace import WorkspaceManager
import logging
logger = logging.getLogger(__name__)
    manager = WorkspaceManager()
    ws = manager.create_workspace("my-project", "/path/to/project", "示例项目")
    active = manager.switch_workspace(ws.id)
    context = manager.get_workspace_context(ws.id)
"""
from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from agent.config import DATA_DIR
from agent.core.logger import log_ignored
from agent.infrastructure.safe_json import safe_json_loads


# ==================== 数据类 ====================


@dataclass
class WorkspaceConfig:
    """工作区配置。

    Attributes:
        id: 工作区唯一标识。
        name: 工作区名称。
        path: 工作区路径（项目根目录）。
        description: 工作区描述。
        created_at: 创建时间戳。
        last_active: 最后活跃时间戳。
        settings: 工作区自定义设置。
    """

    id: str = ""
    name: str = ""
    path: str = ""
    description: str = ""
    created_at: float = 0.0
    last_active: float = 0.0
    settings: dict[str, Any] = field(default_factory=dict)


# ==================== 工作区管理器 ====================


class WorkspaceManager:
    """多项目工作区管理器。

    管理多个项目工作区的完整生命周期，包括创建、查询、
    切换、更新、删除、导入导出和上下文检测。

    数据存储在 DATA_DIR/workspaces.json 文件中，使用标准库
    json 进行序列化和反序列化。

    切换工作区时更新 last_active 时间戳和当前 Agent 的
    working_dir 环境变量。

    Usage:
        manager = WorkspaceManager()
        ws = manager.create_workspace("demo", "/tmp/demo", "演示项目")
        context = manager.get_workspace_context(ws.id)
        logger.info(context["project_type"], context["hints"])
    """

    def __init__(self, data_dir: Path | None = None) -> None:
        self._data_dir = data_dir or DATA_DIR
        self._data_dir.mkdir(parents=True, exist_ok=True)
        self._storage_path = self._data_dir / "workspaces.json"
        self._workspaces: dict[str, WorkspaceConfig] = {}
        self._active_workspace_id: str | None = None
        self._load()

    # ==================== 公共方法 ====================

    def create_workspace(
        self,
        name: str,
        path: str,
        description: str = "",
    ) -> WorkspaceConfig:
        """创建工作区。

        创建一个新的工作区配置并持久化。如果指定路径已存在
        工作区，则返回已有工作区。

        Args:
            name: 工作区名称。
            path: 工作区路径（项目根目录）。
            description: 工作区描述，默认为空。

        Returns:
            WorkspaceConfig: 新创建的或已存在的工作区配置。
        """
        existing = self.get_workspace_by_path(path)
        if existing is not None:
            return existing

        now = time.time()
        workspace = WorkspaceConfig(
            id=uuid.uuid4().hex[:12],
            name=name,
            path=os.path.normpath(path),
            description=description,
            created_at=now,
            last_active=now,
            settings={},
        )
        self._workspaces[workspace.id] = workspace
        self._save()
        return workspace

    def get_workspace(self, workspace_id: str) -> WorkspaceConfig | None:
        """获取工作区。

        Args:
            workspace_id: 工作区唯一标识。

        Returns:
            WorkspaceConfig | None: 工作区配置，不存在时返回 None。
        """
        return self._workspaces.get(workspace_id)

    def get_workspace_by_path(self, path: str) -> WorkspaceConfig | None:
        """按路径查找工作区。

        Args:
            path: 工作区路径。

        Returns:
            WorkspaceConfig | None: 匹配的工作区配置，未找到时返回 None。
        """
        normalized = os.path.normpath(path)
        for ws in self._workspaces.values():
            if os.path.normpath(ws.path) == normalized:
                return ws
        return None

    def list_workspaces(self) -> list[WorkspaceConfig]:
        """列出所有工作区。

        Returns:
            list[WorkspaceConfig]: 按 last_active 降序排列的工作区列表。
        """
        return sorted(
            self._workspaces.values(),
            key=lambda ws: ws.last_active,
            reverse=True,
        )

    def switch_workspace(self, workspace_id: str) -> WorkspaceConfig | None:
        """切换工作区。

        切换当前活跃工作区，更新 last_active 时间戳和
        Agent 的 working_dir 环境变量。

        Args:
            workspace_id: 目标工作区唯一标识。

        Returns:
            WorkspaceConfig | None: 切换后的工作区配置，不存在时返回 None。
        """
        workspace = self._workspaces.get(workspace_id)
        if workspace is None:
            return None

        workspace.last_active = time.time()
        self._active_workspace_id = workspace_id

        # 更新 Agent 工作目录
        if os.path.isdir(workspace.path):
            os.environ["WORKING_DIR"] = workspace.path

        self._save()
        return workspace

    def get_active_workspace(self) -> WorkspaceConfig | None:
        """获取当前活跃工作区。

        Returns:
            WorkspaceConfig | None: 当前活跃的工作区配置，无活跃工作区时返回 None。
        """
        if self._active_workspace_id is None:
            return None
        return self._workspaces.get(self._active_workspace_id)

    def update_workspace(
        self, workspace_id: str, **kwargs: Any
    ) -> WorkspaceConfig | None:
        """更新工作区。

        更新工作区的指定字段并持久化。不允许修改 id 和 created_at。

        Args:
            workspace_id: 工作区唯一标识。
            **kwargs: 需要更新的字段键值对。

        Returns:
            WorkspaceConfig | None: 更新后的工作区配置，不存在时返回 None。
        """
        workspace = self._workspaces.get(workspace_id)
        if workspace is None:
            return None

        protected_fields = {"id", "created_at"}
        for key, value in kwargs.items():
            if key in protected_fields:
                continue
            if hasattr(workspace, key):
                setattr(workspace, key, value)

        self._save()
        return workspace

    def delete_workspace(self, workspace_id: str) -> bool:
        """删除工作区。

        Args:
            workspace_id: 工作区唯一标识。

        Returns:
            bool: 删除成功返回 True，工作区不存在返回 False。
        """
        if workspace_id not in self._workspaces:
            return False

        del self._workspaces[workspace_id]

        if self._active_workspace_id == workspace_id:
            self._active_workspace_id = None

        self._save()
        return True

    def export_workspace(self, workspace_id: str) -> dict[str, Any]:
        """导出工作区配置。

        将工作区配置导出为可序列化的字典，可用于
        跨系统迁移或备份。

        Args:
            workspace_id: 工作区唯一标识。

        Returns:
            dict[str, Any]: 工作区配置字典，不存在时返回空字典。
        """
        workspace = self._workspaces.get(workspace_id)
        if workspace is None:
            return {}

        return asdict(workspace)

    def import_workspace(self, data: dict[str, Any]) -> WorkspaceConfig:
        """导入工作区配置。

        从字典导入工作区配置。如果导入的路径已存在工作区，
        则更新已有工作区。

        Args:
            data: 工作区配置字典，需包含 name 和 path 字段。

        Returns:
            WorkspaceConfig: 导入后的工作区配置。
        """
        # 检查路径是否已有工作区
        path = data.get("path", "")
        existing = self.get_workspace_by_path(path) if path else None

        if existing is not None:
            # 更新已有工作区
            for key, value in data.items():
                if key in {"id", "created_at"}:
                    continue
                if hasattr(existing, key):
                    setattr(existing, key, value)
            self._save()
            return existing

        # 创建新工作区
        workspace_id = data.get("id", uuid.uuid4().hex[:12])
        workspace = WorkspaceConfig(
            id=workspace_id,
            name=data.get("name", "导入的工作区"),
            path=os.path.normpath(data.get("path", "")),
            description=data.get("description", ""),
            created_at=data.get("created_at", time.time()),
            last_active=data.get("last_active", time.time()),
            settings=data.get("settings", {}),
        )
        self._workspaces[workspace.id] = workspace
        self._save()
        return workspace

    def get_workspace_context(self, workspace_id: str) -> dict[str, Any]:
        """获取工作区上下文。

        包括项目类型检测、目录提示和推荐工具集。
        集成 CodingContextDetector 和 SubdirectoryHints。

        Args:
            workspace_id: 工作区唯一标识。

        Returns:
            dict[str, Any]: 工作区上下文信息，包含：
                - workspace: 工作区配置
                - project_type: 项目类型（如 "python"、"typescript"）
                - languages: 检测到的编程语言
                - frameworks: 检测到的框架
                - toolsets: 推荐的工具集
                - hints: 目录提示信息
                - path_exists: 路径是否存在
        """
        workspace = self._workspaces.get(workspace_id)
        if workspace is None:
            return {"error": f"工作区 {workspace_id} 不存在"}

        path_exists = os.path.isdir(workspace.path)
        context: dict[str, Any] = {
            "workspace": asdict(workspace),
            "path_exists": path_exists,
            "project_type": None,
            "languages": [],
            "frameworks": [],
            "toolsets": [],
            "hints": None,
        }

        if not path_exists:
            return context

        # 集成 CodingContextDetector
        try:
            from agent.context.coding_context import CodingContextDetector
            detector = CodingContextDetector()
            coding_ctx = detector.detect(workspace.path)
            if coding_ctx is not None:
                context["project_type"] = coding_ctx.project_type
                context["languages"] = coding_ctx.languages
                context["frameworks"] = coding_ctx.frameworks
                context["toolsets"] = coding_ctx.toolsets
        except Exception as _exc:
            logger.warning("workspace 异常处理", error=str(_exc))
            log_ignored(None, "workspace.WorkspaceManager.get_workspace_context", _exc)

        # 集成 SubdirectoryHints
        try:
            from agent.context.subdirectory_hints import SubdirectoryHints
            hints_provider = SubdirectoryHints()
            hints = hints_provider.get_hints(workspace.path)
            context["hints"] = {
                "config_files": hints.config_files,
                "env_files": hints.env_files,
                "recommended_tools": hints.recommended_tools,
                "constraints": hints.constraints,
                "warnings": hints.warnings,
            }
        except Exception as _exc:
            logger.warning("workspace 异常处理", error=str(_exc))
            log_ignored(None, "workspace.WorkspaceManager.get_workspace_context", _exc)

        return context

    def auto_detect_workspace(self, path: str) -> WorkspaceConfig | None:
        """自动检测并创建工作区。

        扫描指定路径的特征文件，如果检测到可识别的项目类型，
        则自动创建工作区。如果路径不存在或无法识别项目类型，
        返回 None。

        Args:
            path: 待检测的项目路径。

        Returns:
            WorkspaceConfig | None: 自动创建的工作区配置，无法识别时返回 None。
        """
        if not os.path.isdir(path):
            return None

        # 使用 CodingContextDetector 检测项目类型
        project_type: str | None = None
        try:
            from agent.context.coding_context import CodingContextDetector
            detector = CodingContextDetector()
            coding_ctx = detector.detect(path)
            if coding_ctx is not None:
                project_type = coding_ctx.project_type
        except Exception as _exc:
            logger.warning("workspace 异常处理", error=str(_exc))
            log_ignored(None, "workspace.WorkspaceManager.auto_detect_workspace", _exc)

        if project_type is None:
            # 降级：检测基本特征文件
            basic_markers = [
                ".git", "package.json", "pyproject.toml", "setup.py",
                "go.mod", "Cargo.toml", "pom.xml", "CMakeLists.txt",
            ]
            for marker in basic_markers:
                if os.path.exists(os.path.join(path, marker)):
                    project_type = "generic"
                    break

        if project_type is None:
            return None

        # 从路径提取名称
        dir_name = os.path.basename(os.path.normpath(path))
        description = f"自动检测的 {project_type} 项目"

        return self.create_workspace(
            name=dir_name,
            path=path,
            description=description,
        )

    # ==================== 私有方法 ====================

    def _load(self) -> None:
        """从 JSON 文件加载工作区数据。"""
        if not self._storage_path.exists():
            return

        try:
            content = self._storage_path.read_text(encoding="utf-8")
            data = safe_json_loads(content, {}, context="workspace.load")
        except (json.JSONDecodeError, OSError):
            return
        if not isinstance(data, dict):
            # workspaces.json 顶层被覆盖为非 dict（数组/标量）时，旧的 data.get(...)
            # 会抛 AttributeError 逃逸构造器 → WorkspaceManager() 崩溃。
            return

        workspaces_data = data.get("workspaces", {})
        for ws_id, ws_data in workspaces_data.items():
            self._workspaces[ws_id] = WorkspaceConfig(
                id=ws_data.get("id", ws_id),
                name=ws_data.get("name", ""),
                path=ws_data.get("path", ""),
                description=ws_data.get("description", ""),
                created_at=ws_data.get("created_at", 0.0),
                last_active=ws_data.get("last_active", 0.0),
                settings=ws_data.get("settings", {}),
            )

        self._active_workspace_id = data.get("active_workspace_id")

    def _save(self) -> None:
        """持久化工作区数据到 JSON 文件。"""
        data: dict[str, Any] = {
            "workspaces": {
                ws_id: asdict(ws) for ws_id, ws in self._workspaces.items()
            },
            "active_workspace_id": self._active_workspace_id,
        }

        try:
            self._storage_path.write_text(
                json.dumps(data, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except OSError as _exc:
            log_ignored(None, "workspace.WorkspaceManager._save", _exc)