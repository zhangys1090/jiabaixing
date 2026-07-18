from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class DirectoryHints:
    """目录提示信息。

    Attributes:
        config_files: 检测到的配置文件及其内容摘要。
        env_files: 检测到的环境文件及其状态。
        recommended_tools: 推荐的工具列表。
        constraints: 推荐的约束配置，如禁止删除的目录。
        warnings: 警告信息列表。
    """

    config_files: dict[str, Any]
    env_files: dict[str, Any]
    recommended_tools: list[str]
    constraints: dict[str, Any]
    warnings: list[str]


class SubdirectoryHints:
    """根据目录位置自动提示配置。

    扫描工作目录中的特征文件和目录，生成工具推荐、
    约束建议和安全警告。

    Usage:
        hints_provider = SubdirectoryHints()
        hints = hints_provider.get_hints("/path/to/project")
        print(hints.recommended_tools, hints.warnings)
    """

    # 特征目录 → (推荐工具, 约束)
    _DIR_RULES: dict[str, tuple[list[str], dict[str, Any]]] = {
        ".git": (
            ["git_cli", "git_diff", "git_log"],
            {"no_delete": [".git"]},
        ),
        "node_modules": (
            [],
            {"exclude_search": ["node_modules"]},
        ),
        "venv": (
            [],
            {"exclude_search": ["venv"]},
        ),
        ".venv": (
            [],
            {"exclude_search": [".venv"]},
        ),
        "__pycache__": (
            [],
            {"exclude_search": ["__pycache__"]},
        ),
        ".github": (
            ["github_actions", "ci_cd"],
            {"no_delete": [".github"]},
        ),
    }

    # 特征文件 → 推荐工具
    _FILE_RULES: dict[str, list[str]] = {
        "Dockerfile": ["docker_build", "docker_run"],
        "docker-compose.yml": ["docker_compose"],
        "docker-compose.yaml": ["docker_compose"],
        ".env": [],
        ".env.local": [],
        ".env.production": [],
    }

    def get_hints(self, working_dir: str) -> DirectoryHints:
        """获取目录提示。

        Args:
            working_dir: 工作目录路径。

        Returns:
            DirectoryHints: 包含配置文件、环境文件、推荐工具、约束和警告的提示信息。
        """
        target = Path(working_dir)
        config_files = self._check_config_files(target)
        env_files = self._check_env_files(target)
        recommended_tools = self._recommend_tools(target)
        constraints = self._recommend_constraints(target)
        warnings = self._generate_warnings(target)

        return DirectoryHints(
            config_files=config_files,
            env_files=env_files,
            recommended_tools=recommended_tools,
            constraints=constraints,
            warnings=warnings,
        )

    def _check_config_files(self, working_dir: Path) -> dict[str, Any]:
        """检查配置文件。

        扫描工作目录中常见的配置文件并记录其存在状态。

        Args:
            working_dir: 工作目录路径。

        Returns:
            dict[str, Any]: 配置文件名到其信息的映射。
        """
        config_filenames = [
            "package.json",
            "tsconfig.json",
            "pyproject.toml",
            "setup.py",
            "setup.cfg",
            "requirements.txt",
            "Pipfile",
            "go.mod",
            "Cargo.toml",
            "pom.xml",
            "build.gradle",
            "CMakeLists.txt",
            "Makefile",
            "Dockerfile",
            "docker-compose.yml",
            "docker-compose.yaml",
            ".eslintrc.js",
            ".eslintrc.json",
            ".prettierrc",
            "prettier.config.js",
            ".github",
        ]
        result: dict[str, Any] = {}
        for filename in config_filenames:
            candidate = working_dir / filename
            if candidate.exists():
                entry: dict[str, Any] = {"exists": True}
                # 对目录类型标记为 directory
                if candidate.is_dir():
                    entry["type"] = "directory"
                else:
                    entry["type"] = "file"
                    try:
                        stat = candidate.stat()
                        entry["size_bytes"] = stat.st_size
                    except OSError:
                        pass
                result[filename] = entry
        return result

    def _check_env_files(self, working_dir: Path) -> dict[str, Any]:
        """检查环境文件。

        扫描 .env 系列文件并记录其存在状态。

        Args:
            working_dir: 工作目录路径。

        Returns:
            dict[str, Any]: 环境文件名到其信息的映射。
        """
        env_filenames = [
            ".env",
            ".env.local",
            ".env.development",
            ".env.test",
            ".env.production",
            ".env.staging",
        ]
        result: dict[str, Any] = {}
        for filename in env_filenames:
            candidate = working_dir / filename
            if candidate.exists():
                entry: dict[str, Any] = {"exists": True, "sensitive": True}
                try:
                    stat = candidate.stat()
                    entry["size_bytes"] = stat.st_size
                except OSError:
                    pass
                result[filename] = entry
        return result

    def _recommend_tools(self, working_dir: Path) -> list[str]:
        """推荐工具。

        根据目录中的特征文件和子目录推荐适用的工具集。

        Args:
            working_dir: 工作目录路径。

        Returns:
            list[str]: 推荐的工具列表。
        """
        tools: list[str] = []

        # 目录规则
        try:
            for child in working_dir.iterdir():
                if child.is_dir() and child.name in self._DIR_RULES:
                    dir_tools, _ = self._DIR_RULES[child.name]
                    for tool in dir_tools:
                        if tool not in tools:
                            tools.append(tool)
        except OSError:
            pass

        # 文件规则
        for filename, file_tools in self._FILE_RULES.items():
            if (working_dir / filename).exists():
                for tool in file_tools:
                    if tool not in tools:
                        tools.append(tool)

        return tools

    def _recommend_constraints(self, working_dir: Path) -> dict[str, Any]:
        """推荐约束。

        根据目录特征生成约束建议，如禁止删除的目录和排除搜索的目录。

        Args:
            working_dir: 工作目录路径。

        Returns:
            dict[str, Any]: 约束配置，包含 no_delete 和 exclude_search 列表。
        """
        no_delete: list[str] = []
        exclude_search: list[str] = []

        try:
            for child in working_dir.iterdir():
                if child.is_dir() and child.name in self._DIR_RULES:
                    _, constraints = self._DIR_RULES[child.name]
                    no_delete.extend(constraints.get("no_delete", []))
                    exclude_search.extend(constraints.get("exclude_search", []))
        except OSError:
            pass

        return {
            "no_delete": list(dict.fromkeys(no_delete)),
            "exclude_search": list(dict.fromkeys(exclude_search)),
        }

    def _generate_warnings(self, working_dir: Path) -> list[str]:
        """生成警告信息。

        检测潜在的安全风险和注意事项并生成警告。

        Args:
            working_dir: 工作目录路径。

        Returns:
            list[str]: 警告信息列表。
        """
        warnings: list[str] = []

        # .env 文件安全警告
        env_path = working_dir / ".env"
        if env_path.exists():
            warnings.append("检测到 .env 文件，切勿将其内容泄露到日志或版本控制中")

        # 其他 .env 变体
        env_variants = [".env.local", ".env.production", ".env.staging"]
        for variant in env_variants:
            if (working_dir / variant).exists():
                warnings.append(
                    f"检测到 {variant} 文件，包含敏感配置，禁止泄露"
                )

        # node_modules 提示
        if (working_dir / "node_modules").exists():
            warnings.append("检测到 node_modules/，建议在搜索和读取操作中排除此目录")

        # venv 提示
        venv_dir = (working_dir / "venv")
        dot_venv_dir = (working_dir / ".venv")
        if venv_dir.exists() or dot_venv_dir.exists():
            name = "venv" if venv_dir.exists() else ".venv"
            warnings.append(f"检测到 {name}/，建议在搜索操作中排除此目录")

        # __pycache__ 提示
        if (working_dir / "__pycache__").exists():
            warnings.append("检测到 __pycache__/，建议在搜索操作中排除此目录")

        # .git 安全提示
        if (working_dir / ".git").exists():
            warnings.append("检测到 .git/ 目录，禁止删除或修改其中的内部文件")

        return warnings
