from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from agent.core.logger import log_ignored


@dataclass
class CodingContext:
    """编码上下文信息。

    Attributes:
        project_type: 项目类型标识，如 "python"、"react"、"go" 等。
        languages: 检测到的编程语言列表。
        frameworks: 检测到的框架列表。
        toolsets: 推荐的工具集列表。
        working_dir: 工作目录路径。
    """

    project_type: str
    languages: list[str]
    frameworks: list[str]
    toolsets: list[str]
    working_dir: str


class CodingContextDetector:
    """检测当前是否在编码环境中，并识别项目类型、语言和框架。

    通过分析工作目录中的配置文件来推断编码上下文，
    不依赖 LLM，完全基于文件系统特征检测。

    Usage:
        detector = CodingContextDetector()
        ctx = detector.detect("/path/to/project")
        if ctx:
            print(ctx.project_type, ctx.languages, ctx.toolsets)
    """

    # 项目类型检测规则：(文件名, 包含关键词或 None, 项目类型标识)
    _PROJECT_RULES: list[tuple[str, str | None, str]] = [
        ("setup.py", None, "python"),
        ("pyproject.toml", None, "python"),
        ("requirements.txt", None, "python"),
        ("Pipfile", None, "python"),
        ("tsconfig.json", None, "typescript"),
        ("go.mod", None, "go"),
        ("Cargo.toml", None, "rust"),
        ("pom.xml", None, "java"),
        ("build.gradle", None, "java"),
        ("build.gradle.kts", None, "java"),
        ("CMakeLists.txt", None, "cpp"),
        ("Makefile", None, "cpp"),
        (".git", None, "generic"),
    ]

    # package.json 中框架检测关键词
    _FRAMEWORK_KEYWORDS: dict[str, list[str]] = {
        "react": ["react", "react-dom"],
        "next.js": ["next"],
        "vue": ["vue"],
        "angular": ["@angular/core"],
        "svelte": ["svelte"],
        "fastapi": ["fastapi"],
        "django": ["django"],
        "flask": ["flask"],
        "express": ["express"],
        "nestjs": ["@nestjs/core"],
    }

    def detect(self, working_dir: str | None = None) -> CodingContext | None:
        """检测编码上下文。

        Args:
            working_dir: 工作目录路径，为 None 时使用当前目录。

        Returns:
            CodingContext | None: 检测到编码上下文时返回，否则返回 None。
        """
        target = Path(working_dir) if working_dir else Path.cwd()
        if not target.is_dir():
            return None

        project_type = self._detect_project_type(target)
        if project_type is None:
            return None

        languages = self._detect_language(target)
        frameworks = self._detect_framework(target)
        toolsets = self._get_toolset_recommendation(project_type, languages)

        return CodingContext(
            project_type=project_type,
            languages=languages,
            frameworks=frameworks,
            toolsets=toolsets,
            working_dir=str(target),
        )

    def _detect_project_type(self, working_dir: Path) -> str | None:
        """检测项目类型。

        按规则优先级顺序扫描工作目录中的特征文件。

        Args:
            working_dir: 工作目录路径。

        Returns:
            str | None: 项目类型标识，无法识别时返回 None。
        """
        for filename, keyword, project_type in self._PROJECT_RULES:
            candidate = working_dir / filename
            if candidate.exists():
                # package.json 特殊处理：需要额外判断才归为 typescript
                if filename == "package.json" and project_type == "typescript":
                    if self._package_json_has_typescript(working_dir):
                        return project_type
                    continue
                return project_type

        # 单独检测 package.json + typescript 组合
        pkg_path = working_dir / "package.json"
        if pkg_path.exists() and self._package_json_has_typescript(working_dir):
            return "typescript"

        return None

    def _package_json_has_typescript(self, working_dir: Path) -> bool:
        """检查 package.json 是否包含 typescript 依赖。

        Args:
            working_dir: 工作目录路径。

        Returns:
            bool: 包含 typescript 依赖时返回 True。
        """
        pkg_path = working_dir / "package.json"
        if not pkg_path.exists():
            return False
        try:
            data = json.loads(pkg_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return False
        deps = {**data.get("dependencies", {}), **data.get("devDependencies", {})}
        return "typescript" in deps

    def _detect_language(self, working_dir: Path) -> list[str]:
        """检测编程语言。

        根据特征文件和扩展名推断使用的编程语言。

        Args:
            working_dir: 工作目录路径。

        Returns:
            list[str]: 检测到的编程语言列表。
        """
        languages: list[str] = []
        language_markers: dict[str, list[str]] = {
            "python": ["setup.py", "pyproject.toml", "requirements.txt", "Pipfile", "manage.py"],
            "typescript": ["tsconfig.json"],
            "javascript": ["package.json"],
            "go": ["go.mod", "go.sum"],
            "rust": ["Cargo.toml", "Cargo.lock"],
            "java": ["pom.xml", "build.gradle", "build.gradle.kts"],
            "cpp": ["CMakeLists.txt", "Makefile"],
            "csharp": [".csproj", "Directory.Build.props"],
        }

        for lang, markers in language_markers.items():
            for marker in markers:
                if (working_dir / marker).exists():
                    if lang not in languages:
                        languages.append(lang)
                    break

        # 通过扩展名补充检测
        ext_languages: dict[str, str] = {
            ".py": "python",
            ".ts": "typescript",
            ".tsx": "typescript",
            ".js": "javascript",
            ".jsx": "javascript",
            ".go": "go",
            ".rs": "rust",
            ".java": "java",
            ".cpp": "cpp",
            ".c": "c",
            ".cs": "csharp",
        }
        try:
            for child in working_dir.iterdir():
                if child.is_file():
                    lang = ext_languages.get(child.suffix.lower())
                    if lang and lang not in languages:
                        languages.append(lang)
        except OSError as _exc:
            log_ignored(None, "coding_context.CodingContextDetector._detect_language", _exc)

        return languages

    def _detect_framework(self, working_dir: Path) -> list[str]:
        """检测框架。

        主要通过 package.json 依赖和 Python 配置文件推断。

        Args:
            working_dir: 工作目录路径。

        Returns:
            list[str]: 检测到的框架列表。
        """
        frameworks: list[str] = []

        # package.json 依赖检测
        pkg_path = working_dir / "package.json"
        if pkg_path.exists():
            try:
                data = json.loads(pkg_path.read_text(encoding="utf-8"))
                deps = {**data.get("dependencies", {}), **data.get("devDependencies", {})}
                for fw_name, keywords in self._FRAMEWORK_KEYWORDS.items():
                    if any(kw in deps for kw in keywords):
                        frameworks.append(fw_name)
            except (json.JSONDecodeError, OSError) as _exc:
                log_ignored(None, "coding_context.CodingContextDetector._detect_framework", _exc)

        # Python 框架检测
        requirements_path = working_dir / "requirements.txt"
        if requirements_path.exists():
            try:
                content = requirements_path.read_text(encoding="utf-8").lower()
                for fw_name, keywords in self._FRAMEWORK_KEYWORDS.items():
                    if fw_name in ("fastapi", "django", "flask"):
                        if any(kw in content for kw in keywords):
                            if fw_name not in frameworks:
                                frameworks.append(fw_name)
            except OSError as _exc:
                log_ignored(None, "coding_context.CodingContextDetector._detect_framework", _exc)

        pyproject_path = working_dir / "pyproject.toml"
        if pyproject_path.exists():
            try:
                content = pyproject_path.read_text(encoding="utf-8").lower()
                for fw_name in ("fastapi", "django", "flask"):
                    if fw_name in content and fw_name not in frameworks:
                        frameworks.append(fw_name)
            except OSError as _exc:
                log_ignored(None, "coding_context.CodingContextDetector._detect_framework", _exc)

        return frameworks

    def _get_toolset_recommendation(
        self, project_type: str, languages: list[str]
    ) -> list[str]:
        """根据项目类型和语言推荐工具集。

        Args:
            project_type: 项目类型标识。
            languages: 检测到的编程语言列表。

        Returns:
            list[str]: 推荐的工具集列表。
        """
        toolsets: list[str] = []

        language_tools: dict[str, list[str]] = {
            "python": ["python_repl", "pip_install", "pytest_runner"],
            "typescript": ["node_runner", "npm_install", "tsc_checker"],
            "javascript": ["node_runner", "npm_install"],
            "go": ["go_build", "go_test", "go_fmt"],
            "rust": ["cargo_build", "cargo_test", "cargo_fmt"],
            "java": ["maven_build", "gradle_build", "junit_runner"],
            "cpp": ["cmake_build", "make_build"],
            "csharp": ["dotnet_build", "dotnet_test"],
        }

        for lang in languages:
            tools = language_tools.get(lang, [])
            for tool in tools:
                if tool not in toolsets:
                    toolsets.append(tool)

        # 通用工具
        if project_type == "generic":
            if "git_cli" not in toolsets:
                toolsets.append("git_cli")

        return toolsets
