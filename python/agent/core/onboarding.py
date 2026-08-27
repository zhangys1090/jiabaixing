"""首次运行向导（Onboarding Wizard）。

新用户首次启动时自动引导完成关键配置：
  1. 环境检测（Python 版本、Node.js、LLM API Key）
  2. LLM 提供商选择与 API Key 配置
  3. 推荐技能安装
  4. 快捷教程提示

设计原则：
  - 5 分钟内完成所有配置
  - 每步可跳过（不阻断启动）
  - 配置结果持久化到 .env 和 config.json
  - 已完成向导的用户不再触发（onboarding_complete 标记）

集成示例::

    from agent.core.onboarding import OnboardingWizard, OnboardingState

    wizard = OnboardingWizard()
    state = wizard.check_state()
    if not state.is_complete:
        await wizard.run_interactive()
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from agent.config import DATA_DIR, ENV_FILE, PROJECT_ROOT
from agent.core.logger import StructuredLogger, log_ignored
from agent.core.logger import StructuredLogger

log = StructuredLogger("onboarding")



class OnboardingStep(str, Enum):
    ENV_CHECK = "env_check"
    LLM_CONFIG = "llm_config"
    SKILL_RECOMMEND = "skill_recommend"
    TUTORIAL = "tutorial"


class OnboardingStatus(str, Enum):
    NOT_STARTED = "not_started"
    IN_PROGRESS = "in_progress"
    COMPLETE = "complete"
    SKIPPED = "skipped"


@dataclass
class EnvCheckResult:
    python_version: str = ""
    node_available: bool = False
    node_version: str = ""
    llm_key_set: bool = False
    llm_provider: str = ""
    redis_available: bool = False
    issues: list[str] = field(default_factory=list)

    @property
    def is_healthy(self) -> bool:
        return len(self.issues) == 0 and self.llm_key_set


@dataclass
class LLMProviderOption:
    name: str
    env_key: str
    default_model: str
    default_base_url: str = ""
    description: str = ""


@dataclass
class SkillRecommendation:
    name: str
    category: str
    reason: str
    auto_install: bool = False


@dataclass
class OnboardingState:
    current_step: OnboardingStep = OnboardingStep.ENV_CHECK
    status: OnboardingStatus = OnboardingStatus.NOT_STARTED
    completed_steps: list[str] = field(default_factory=list)
    env_result: EnvCheckResult | None = None
    selected_provider: str = ""
    installed_skills: list[str] = field(default_factory=list)

    @property
    def is_complete(self) -> bool:
        return self.status == OnboardingStatus.COMPLETE


LLM_OPTIONS: list[LLMProviderOption] = [
    LLMProviderOption(
        name="OpenAI (GPT-4o)",
        env_key="OPENAI_API_KEY",
        default_model="openai/gpt-4o-mini",
        description="OpenAI GPT 系列，最广泛使用",
    ),
    LLMProviderOption(
        name="Anthropic (Claude)",
        env_key="ANTHROPIC_API_KEY",
        default_model="anthropic/claude-sonnet-4-20250514",
        description="Anthropic Claude 系列，长上下文优秀",
    ),
    LLMProviderOption(
        name="Google (Gemini)",
        env_key="GEMINI_API_KEY",
        default_model="gemini/gemini-2.0-flash",
        description="Google Gemini 系列，多模态支持",
    ),
    LLMProviderOption(
        name="DeepSeek",
        env_key="DEEPSEEK_API_KEY",
        default_model="deepseek/deepseek-v4-flash",
        default_base_url="https://api.deepseek.com",
        description="DeepSeek，性价比高",
    ),
    LLMProviderOption(
        name="本地模型 (Ollama)",
        env_key="OLLAMA_BASE_URL",
        default_model="ollama/qwen2.5",
        default_base_url="http://localhost:11434",
        description="本地部署，隐私安全",
    ),
]

RECOMMENDED_SKILLS: list[SkillRecommendation] = [
    SkillRecommendation("web_search", "network", "网络搜索，获取最新信息", True),
    SkillRecommendation("file_read", "file", "文件读取，基础操作", True),
    SkillRecommendation("file_list", "file", "文件浏览，基础操作", True),
    SkillRecommendation("shell_exec", "system", "命令执行，开发必备", False),
    SkillRecommendation("code_search", "code", "代码搜索，开发辅助", False),
    SkillRecommendation("memory_store", "memory", "记忆存储，长期对话", True),
]


class OnboardingWizard:
    """首次运行向导。

    检测用户环境，引导配置 LLM 提供商，推荐技能安装。
    支持交互式（CLI）和自动检测两种模式。
    """

    def __init__(self) -> None:
        self._state_file = DATA_DIR / "onboarding_state.json"
        self._state = self._load_state()

    def _load_state(self) -> OnboardingState:
        if self._state_file.exists():
            try:
                import json
                data = json.loads(self._state_file.read_text(encoding="utf-8"))
                return OnboardingState(
                    current_step=OnboardingStep(data.get("current_step", "env_check")),
                    status=OnboardingStatus(data.get("status", "not_started")),
                    completed_steps=data.get("completed_steps", []),
                    selected_provider=data.get("selected_provider", ""),
                    installed_skills=data.get("installed_skills", []),
                )
            except Exception as _exc:
                log.debug("onboarding 异常处理", error=str(_exc))
                log_ignored(log, "onboarding.OnboardingWizard._load_state", _exc)
        return OnboardingState()

    def _save_state(self) -> None:
        import json
        self._state_file.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "current_step": self._state.current_step.value,
            "status": self._state.status.value,
            "completed_steps": self._state.completed_steps,
            "selected_provider": self._state.selected_provider,
            "installed_skills": self._state.installed_skills,
        }
        self._state_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    def check_state(self) -> OnboardingState:
        """检查向导状态。已完成的不再触发。"""
        return self._state

    def check_environment(self) -> EnvCheckResult:
        """Step 1: 环境检测。"""
        result = EnvCheckResult()

        result.python_version = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
        if sys.version_info < (3, 10):
            result.issues.append(f"Python 版本过低 ({result.python_version})，建议 3.10+")

        try:
            import subprocess
            node_result = subprocess.run(
                ["node", "--version"], capture_output=True, text=True, timeout=5
            )
            if node_result.returncode == 0:
                result.node_available = True
                result.node_version = node_result.stdout.strip()
        except Exception as _exc:
            log.debug("onboarding 异常处理", error=str(_exc))
            result.issues.append("Node.js 未安装，部分功能不可用")

        llm_key = os.getenv("LLM_API_KEY", "")
        llm_model = os.getenv("LLM_MODEL", "")
        if llm_key or any(os.getenv(opt.env_key, "") for opt in LLM_OPTIONS):
            result.llm_key_set = True
            result.llm_provider = llm_model or "unknown"
        else:
            result.issues.append("未配置 LLM API Key，Agent 无法调用大模型")

        try:
            import redis
            r = redis.Redis(host="localhost", port=6379, socket_timeout=2)
            r.ping()
            result.redis_available = True
        except Exception as _exc:
            log.debug("onboarding 异常处理", error=str(_exc))
            log_ignored(log, "onboarding.OnboardingWizard.check_environment", _exc)

        self._state.env_result = result
        return result

    def get_llm_options(self) -> list[LLMProviderOption]:
        """Step 2: 获取可选的 LLM 提供商列表。"""
        available = []
        for opt in LLM_OPTIONS:
            if os.getenv(opt.env_key, ""):
                available.append(opt)
        return available if available else LLM_OPTIONS

    def configure_llm(self, provider_name: str, api_key: str, model: str = "", base_url: str = "") -> bool:
        """Step 2: 配置 LLM 提供商。写入 .env 文件。"""
        opt = next((o for o in LLM_OPTIONS if o.name == provider_name), None)
        if not opt:
            log.error("未知的 LLM 提供商", provider=provider_name)
            return False

        env_lines: list[str] = []
        if ENV_FILE.exists():
            env_lines = ENV_FILE.read_text(encoding="utf-8").splitlines()

        def _set_env_line(lines: list[str], key: str, value: str) -> list[str]:
            new_lines = []
            found = False
            for line in lines:
                if line.strip().startswith(f"{key}=") or line.strip().startswith(f"{key} ="):
                    new_lines.append(f"{key}={value}")
                    found = True
                else:
                    new_lines.append(line)
            if not found:
                new_lines.append(f"{key}={value}")
            return new_lines

        env_lines = _set_env_line(env_lines, opt.env_key, api_key)
        env_lines = _set_env_line(env_lines, "LLM_MODEL", model or opt.default_model)
        if base_url or opt.default_base_url:
            env_lines = _set_env_line(env_lines, "LLM_BASE_URL", base_url or opt.default_base_url)

        ENV_FILE.write_text("\n".join(env_lines) + "\n", encoding="utf-8")

        os.environ[opt.env_key] = api_key
        os.environ["LLM_MODEL"] = model or opt.default_model
        if base_url or opt.default_base_url:
            os.environ["LLM_BASE_URL"] = base_url or opt.default_base_url

        self._state.selected_provider = provider_name
        self._state.completed_steps.append(OnboardingStep.LLM_CONFIG.value)
        self._save_state()

        log.info("LLM 提供商配置完成", provider=provider_name, model=model or opt.default_model)
        return True

    def get_recommended_skills(self) -> list[SkillRecommendation]:
        """Step 3: 获取推荐技能列表。"""
        return RECOMMENDED_SKILLS

    def mark_skill_installed(self, skill_name: str) -> None:
        """Step 3: 标记技能已安装。"""
        if skill_name not in self._state.installed_skills:
            self._state.installed_skills.append(skill_name)
            self._save_state()

    def complete_onboarding(self) -> None:
        """标记向导完成。"""
        self._state.status = OnboardingStatus.COMPLETE
        self._state.completed_steps = [s.value for s in OnboardingStep]
        self._save_state()
        log.info("首次运行向导完成")

    def skip_onboarding(self) -> None:
        """跳过向导。"""
        self._state.status = OnboardingStatus.SKIPPED
        self._save_state()
        log.info("首次运行向导已跳过")

    def reset_onboarding(self) -> None:
        """重置向导状态（重新触发）。"""
        self._state = OnboardingState()
        if self._state_file.exists():
            self._state_file.unlink()
        log.info("首次运行向导已重置")

    async def run_auto_detect(self) -> OnboardingState:
        """自动检测模式：不交互，仅检测环境并记录。

        适用于 GUI 启动时后台检测，将结果呈现给前端。
        """
        self._state.status = OnboardingStatus.IN_PROGRESS
        env = self.check_environment()

        if env.llm_key_set:
            self._state.completed_steps.append(OnboardingStep.ENV_CHECK.value)
            self._state.completed_steps.append(OnboardingStep.LLM_CONFIG.value)

        for skill in RECOMMENDED_SKILLS:
            if skill.auto_install:
                self._state.installed_skills.append(skill.name)

        self._state.completed_steps.append(OnboardingStep.SKILL_RECOMMEND.value)
        self._state.completed_steps.append(OnboardingStep.TUTORIAL.value)

        if env.is_healthy:
            self._state.status = OnboardingStatus.COMPLETE
        else:
            self._state.status = OnboardingStatus.IN_PROGRESS

        self._save_state()
        return self._state

    def get_tutorial_tips(self) -> list[dict[str, str]]:
        """Step 4: 获取快捷教程提示。"""
        return [
            {"command": "/help", "desc": "查看所有可用命令"},
            {"command": "/skill", "desc": "查看和安装技能包"},
            {"command": "/model", "desc": "切换 LLM 模型"},
            {"command": "/memory", "desc": "管理长期记忆"},
            {"command": "/config", "desc": "打开配置面板"},
            {"command": "/doctor", "desc": "运行环境诊断"},
        ]
