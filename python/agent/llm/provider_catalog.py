"""Provider 目录（Provider Catalog）。

对标 Hermes 的 Provider 目录广度：把"已知可接入的 LLM 提供商"与"运行时已配置
的凭据"解耦。静态元数据中心化管理，运行时只关心哪些已配置/已启用。

解决的问题（原差距④）：
  - 此前 providers.json 仅 deepseek 1 家实配，且无 Provider 元数据（传输类型、
    模型清单、鉴权方式、是否支持 OAuth）。
  - 本模块声明一组主流 Provider 的元数据（含 Vertex / Gemini / Bedrock / Azure
    等 OAuth-capable 厂商），并支持从 providers.json 合并出"已配置"集合。

设计（对齐 AGENTS.md §0.1，Python 主实现；§0.3 "已完成"标准）：
  - 纯元数据 + 纯函数，不依赖网络/文件系统（加载器单独注入路径）。
  - 默认不开辟 OAuth 流程（仅元数据标注 oauth_supported），避免本轮回做完整
    OAuth 握手；但目录为将来 onboarding 预留字段。
  - 与既有 ProviderManager（读 providers.json）互补：catalog 负责"能接谁"，
    manager 负责"当前接了谁"。

Usage:
    cat = ProviderCatalog()                       # 内置主流厂商目录
    cat.known_provider_ids()                       # ['openai','anthropic', ...]
    loaded = ProviderCatalog.from_providers_json(path)  # 合并运行时配置
    loaded.available_providers()                  # 目录已知且已配置凭据
    loaded.configured_with_oauth()                # 已配置且支持 OAuth 的厂商
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("provider_catalog")

#: 通过该环境变量声明额外 Provider 元数据 JSON 目录（可选扩展）。
PROVIDER_CATALOG_ENV = "AGENT_PROVIDER_CATALOG"


class ProviderAuth(str, Enum):
    """鉴权方式。"""

    API_KEY = "api_key"
    OAUTH = "oauth"
    NONE = "none"


@dataclass
class ProviderSpec:
    """单个 Provider 的静态元数据。

    Attributes:
        id: 稳定标识（与 providers.json 中 provider.name 对齐的"规范名"）。
        display_name: 展示名。
        transport: 适配的传输类型（对应 transports.TransportType 取值）。
        default_base_url: 默认 API base（openai_compatible 类可用）。
        auth: 鉴权方式。
        oauth_supported: 是否支持 OAuth onboarding（仅元数据标注，本轮回做握手）。
        supports_streaming: 是否支持流式。
        default_models: 代表性模型清单（用于前端/路由预填）。
        notes: 备注（如"需 Vertex 项目/region"）。
    """

    id: str
    display_name: str
    transport: str = "openai_compatible"
    default_base_url: str = ""
    auth: ProviderAuth = ProviderAuth.API_KEY
    oauth_supported: bool = False
    supports_streaming: bool = True
    default_models: list[str] = field(default_factory=list)
    notes: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "display_name": self.display_name,
            "transport": self.transport,
            "default_base_url": self.default_base_url,
            "auth": self.auth.value,
            "oauth_supported": self.oauth_supported,
            "supports_streaming": self.supports_streaming,
            "default_models": list(self.default_models),
            "notes": self.notes,
        }


def _known_catalog() -> list[ProviderSpec]:
    """内置主流 Provider 元数据目录（声明式、可审计、可扩展）。

    涵盖：美国主流（OpenAI/Anthropic/Gemini/Vertex/Bedrock/Azure）、
    国内主流（DeepSeek/智谱/ Kimi/通义/百川/豆包/阶跃）、本地兼容端点。
    """
    return [
        ProviderSpec(
            id="openai",
            display_name="OpenAI",
            transport="openai_compatible",
            default_base_url="https://api.openai.com/v1",
            auth=ProviderAuth.API_KEY,
            oauth_supported=True,
            default_models=["gpt-4o", "gpt-4o-mini", "o1", "o3-mini"],
            notes="支持 Azure AD OAuth（企业租户）",
        ),
        ProviderSpec(
            id="anthropic",
            display_name="Anthropic Claude",
            transport="anthropic",
            default_base_url="https://api.anthropic.com/v1",
            auth=ProviderAuth.API_KEY,
            oauth_supported=True,
            default_models=["claude-3-5-sonnet", "claude-3-opus", "claude-3-haiku"],
            notes="支持 Claude OAuth（claude.ai/account/keys）",
        ),
        ProviderSpec(
            id="gemini",
            display_name="Google Gemini",
            transport="gemini",
            default_base_url="https://generativelanguage.googleapis.com/v1beta",
            auth=ProviderAuth.API_KEY,
            oauth_supported=True,
            default_models=["gemini-1.5-pro", "gemini-1.5-flash", "gemini-2.0-flash"],
            notes="Google AI Studio API Key / ADC",
        ),
        ProviderSpec(
            id="vertex",
            display_name="Google Vertex AI",
            transport="gemini",
            default_base_url="",
            auth=ProviderAuth.OAUTH,
            oauth_supported=True,
            default_models=["gemini-1.5-pro", "gemini-1.5-flash"],
            notes="需 GCP 项目 + region，使用 ADC/服务账号 OAuth，无静态 Key",
        ),
        ProviderSpec(
            id="bedrock",
            display_name="AWS Bedrock",
            transport="bedrock",
            default_base_url="",
            auth=ProviderAuth.OAUTH,
            oauth_supported=True,
            default_models=["anthropic.claude-v2", "amazon.titan-text"],
            notes="需 AWS SigV4 / IAM 角色，OAuth 等价 IAM 凭证",
        ),
        ProviderSpec(
            id="azure",
            display_name="Azure OpenAI",
            transport="openai_compatible",
            default_base_url="https://{resource}.openai.azure.com",
            auth=ProviderAuth.API_KEY,
            oauth_supported=True,
            default_models=["gpt-4o", "gpt-4"],
            notes="支持 Entra ID OAuth",
        ),
        ProviderSpec(
            id="deepseek",
            display_name="DeepSeek",
            transport="openai_compatible",
            default_base_url="https://api.deepseek.com/v1",
            auth=ProviderAuth.API_KEY,
            oauth_supported=False,
            default_models=["deepseek-chat", "deepseek-reasoner"],
        ),
        ProviderSpec(
            id="zhipu",
            display_name="智谱 GLM",
            transport="openai_compatible",
            default_base_url="https://open.bigmodel.cn/api/paas/v4",
            auth=ProviderAuth.API_KEY,
            oauth_supported=False,
            default_models=["glm-4-plus", "glm-4-air", "glm-4-flash"],
        ),
        ProviderSpec(
            id="moonshot",
            display_name="Moonshot Kimi",
            transport="openai_compatible",
            default_base_url="https://api.moonshot.cn/v1",
            auth=ProviderAuth.API_KEY,
            oauth_supported=False,
            default_models=["moonshot-v1-8k", "moonshot-v1-32k"],
        ),
        ProviderSpec(
            id="qwen",
            display_name="阿里通义千问",
            transport="openai_compatible",
            default_base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
            auth=ProviderAuth.API_KEY,
            oauth_supported=False,
            default_models=["qwen-max", "qwen-plus", "qwen-turbo"],
        ),
        ProviderSpec(
            id="baichuan",
            display_name="百川智能",
            transport="openai_compatible",
            default_base_url="https://api.baichuan-ai.com/v1",
            auth=ProviderAuth.API_KEY,
            oauth_supported=False,
            default_models=["baichuan4", "baichuan3-turbo"],
        ),
        ProviderSpec(
            id="doubao",
            display_name="字节豆包",
            transport="openai_compatible",
            default_base_url="https://ark.cn-beijing.volces.com/api/v3",
            auth=ProviderAuth.API_KEY,
            oauth_supported=False,
            default_models=["doubao-pro", "doubao-lite"],
        ),
        ProviderSpec(
            id="stepfun",
            display_name="阶跃星辰",
            transport="openai_compatible",
            default_base_url="https://api.stepfun.com/v1",
            auth=ProviderAuth.API_KEY,
            oauth_supported=False,
            default_models=["step-1v", "step-2"],
        ),
        ProviderSpec(
            id="xiaomi",
            display_name="小米 MiMo",
            transport="openai_compatible",
            default_base_url="https://api.xiaomimimo.com/v1",
            auth=ProviderAuth.API_KEY,
            oauth_supported=False,
            default_models=["mimo-v2.5-pro"],
        ),
        ProviderSpec(
            id="local",
            display_name="本地 LLM（OpenAI 兼容）",
            transport="openai_compatible",
            default_base_url="http://127.0.0.1:8001/v1",
            auth=ProviderAuth.NONE,
            oauth_supported=False,
            default_models=["local-model"],
            notes="vLLM / Ollama / LM Studio 等本地端点",
        ),
    ]


class ProviderCatalog:
    """Provider 元数据目录 + 运行时配置合并。

    两层分离：
      - 目录（catalog）："能接谁"——静态元数据，来自内置 _known_catalog + 可选扩展 JSON。
      - 配置（configured）："当前接了谁"——来自 providers.json 的 provider.name 集合。
    """

    def __init__(self, specs: list[ProviderSpec] | None = None) -> None:
        self._specs: dict[str, ProviderSpec] = {}
        for s in specs if specs is not None else _known_catalog():
            self._specs[s.id] = s
        self._configured: set[str] = set()

    # ─── 目录（catalog） ───

    def known_provider_ids(self) -> list[str]:
        return list(self._specs.keys())

    def get_spec(self, provider_id: str) -> ProviderSpec | None:
        return self._specs.get(provider_id)

    def all_specs(self) -> list[ProviderSpec]:
        return list(self._specs.values())

    def oauth_capable_ids(self) -> list[str]:
        return [pid for pid, s in self._specs.items() if s.oauth_supported]

    def add_spec(self, spec: ProviderSpec) -> None:
        self._specs[spec.id] = spec

    # ─── 运行时配置合并（configured） ───

    def mark_configured(self, provider_ids: list[str]) -> None:
        """标记一批 provider 为"已配置凭据"（来自 providers.json 等）。"""
        for pid in provider_ids:
            self._configured.add(pid)

    def configured_ids(self) -> list[str]:
        """已配置凭据的 provider（仅保留目录已知的，过滤掉未知名）。"""
        return [pid for pid in self._configured if pid in self._specs]

    def unknown_configured_ids(self) -> list[str]:
        """已配置但目录未知的 provider（便于审计/补全元数据）。"""
        return [pid for pid in self._configured if pid not in self._specs]

    def available_providers(self) -> list[ProviderSpec]:
        """目录已知 且 已配置凭据 的 provider（可立即使用）。"""
        return [self._specs[pid] for pid in self.configured_ids()]

    def configured_with_oauth(self) -> list[ProviderSpec]:
        """已配置 且 支持 OAuth 的 provider（onboarding 候选）。"""
        return [
            s
            for s in self.available_providers()
            if s.oauth_supported and s.auth in (ProviderAuth.OAUTH, ProviderAuth.API_KEY)
        ]

    def unconfigured_catalog(self) -> list[ProviderSpec]:
        """目录已知 但 尚未配置凭据 的 provider（可发现、待接入）。"""
        return [s for pid, s in self._specs.items() if pid not in self._configured]

    # ─── 构建器 ───

    @classmethod
    def from_providers_json(
        cls,
        path: str | Path,
        extra_specs: list[ProviderSpec] | None = None,
    ) -> "ProviderCatalog":
        """从 providers.json 构建目录，并把其中声明的 provider.name 标记为已配置。

        Args:
            path: providers.json 路径（TS 或 Python 形态皆可，兼容 name/displayName 等）。
            extra_specs: 额外 Provider 元数据（覆盖/补充内置目录）。

        Returns:
            ProviderCatalog: 已合并运行时配置的目录。
        """
        cat = cls(specs=extra_specs)
        try:
            data = json.loads(Path(path).read_text(encoding="utf-8"))
        except FileNotFoundError:
            log.warning("providers.json 不存在，使用纯目录", path=str(path))
            return cat
        except Exception as e:
            log.warning("providers.json 解析失败", path=str(path), error=str(e))
            return cat

        providers = data.get("providers", []) if isinstance(data, dict) else []
        configured: list[str] = []
        for p in providers:
            # 兼容 TS 形态(name) 与 Python 形态(name)
            pid = p.get("name")
            if pid:
                configured.append(pid)
        cat.mark_configured(configured)
        return cat

    def to_manifest(self) -> dict[str, Any]:
        """输出可审计的目录清单（含配置状态）。"""
        return {
            "known_count": len(self._specs),
            "configured_count": len(self.configured_ids()),
            "oauth_capable": self.oauth_capable_ids(),
            "providers": [
                {**s.to_dict(), "configured": s.id in self._configured}
                for s in self._specs.values()
            ],
        }
