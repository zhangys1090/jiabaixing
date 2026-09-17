"""LLM provider 配置一致性校验 —— 启动期发现"两套配置源互相覆盖"。

为什么需要它（R-2，2026-09-17 真实故障）:
    项目有**两套** LLM 配置源：
      1. `.env` → `agent.config`（LLM_MODEL / LLM_BASE_URL / LLM_API_KEY）
      2. `python/data/providers.json` → `ProviderManager`（providers[] + primary）
    `LLMProvider.__init__` 会用 `providers.json` 的 primary **覆盖** `.env`。

    当 `providers.json` 里残留一个测试 provider 且被设为 primary 时，
    `.env` 的配置被静默覆盖 —— 表现为"每次 LLM 调用都失败"，
    排查成本极高（本次花了十余轮插桩才定位）。

    本模块在 provider 构造后立即做一致性校验，把"静默覆盖"变成"显式告警"。

设计:
    - 纯函数 + 结构化 Finding，便于脚本 / CI / 健康检查复用。
    - 只读，不修改任何配置（校验不越权）。
    - 密钥一律掩码输出，不落明文。

用法::

    from agent.llm.provider_consistency import check_provider_consistency

    for f in check_provider_consistency():
        print(f.severity, f.code, f.message)
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("provider_consistency")

SEVERITY_INFO = "info"
SEVERITY_WARNING = "warning"
SEVERITY_ERROR = "error"

#: 明显是占位/测试用的 key 特征。
_PLACEHOLDER_KEY_PATTERNS = (
    "sk-test", "test-key", "testkey", "your_", "your-", "changeme",
    "placeholder", "dummy", "example", "xxxx", "todo",
)
#: 真实 sk- 类密钥的长度下限（低于此值大概率是占位）
_MIN_REALISTIC_KEY_LEN = 20


@dataclass
class Finding:
    """一条配置一致性发现。

    Attributes:
        severity: info / warning / error。
        code: 稳定的机读标识（便于 CI 白名单与文档索引）。
        message: 人读说明。
        hint: 建议动作。
        details: 掩码后的对比细节。
    """

    severity: str
    code: str
    message: str
    hint: str = ""
    details: dict[str, Any] = field(default_factory=dict)


def _mask(secret: str | None) -> str:
    """密钥掩码，永不出明文。"""
    if not secret:
        return "<empty>"
    if len(secret) <= 8:
        return f"<set len={len(secret)}>"
    return f"{secret[:3]}***{secret[-2:]} (len={len(secret)})"


def _looks_like_placeholder(key: str | None) -> bool:
    """判断 key 是否像占位/测试值。"""
    if not key:
        return False
    low = key.strip().lower()
    if any(p in low for p in _PLACEHOLDER_KEY_PATTERNS):
        return True
    # sk- 开头但长度明显不足 → 疑似占位
    if low.startswith("sk-") and len(key.strip()) < _MIN_REALISTIC_KEY_LEN:
        return True
    return False


def _normalize_for_compare(url: str | None) -> str:
    """归一化 base_url 以便比较（去尾斜杠、小写 host）。"""
    if not url:
        return ""
    return re.sub(r"/+$", "", url.strip()).lower()


def _try_normalize(model: str) -> str:
    """尝试调用 provider 的模型名归一化；不可用时返回空串。

    刻意复用 `LLMProvider._normalize_model` 而不是重写一份 ——
    校验器的判断必须与运行时**完全一致**，否则校验结论会与真实行为脱节。
    """
    try:
        from agent.llm.provider import LLMProvider

        return LLMProvider._normalize_model(model)
    except Exception:
        return ""


def check_provider_consistency(data_dir: Any = None) -> list[Finding]:
    """校验 `.env` 与 `providers.json` 的一致性。

    在 `LLMProvider` 构造完成后调用。所有异常都被吞掉并转为 Finding，
    保证**校验本身永不阻断启动**。

    Args:
        data_dir: providers.json 所在目录；None 时用默认 data 目录。
            仅用于测试注入，生产路径不要传。

    Returns:
        Finding 列表；无问题时为空列表。
    """
    findings: list[Finding] = []
    try:
        from agent.config import LLM_API_KEY, LLM_BASE_URL, LLM_MODEL
    except Exception as exc:  # pragma: no cover - 配置模块不可用
        return [Finding(
            severity=SEVERITY_WARNING,
            code="config_unavailable",
            message=f"无法读取 agent.config，跳过一致性校验：{exc}",
        )]

    try:
        from agent.llm.router import ProviderManager

        manager = ProviderManager(data_dir=data_dir) if data_dir else ProviderManager()
        primary = manager.get_primary()
    except Exception as exc:  # pragma: no cover
        return [Finding(
            severity=SEVERITY_WARNING,
            code="provider_manager_unavailable",
            message=f"无法读取 ProviderManager，跳过一致性校验：{exc}",
        )]

    # ── 无 primary：不会覆盖 .env，属正常（纯 .env 模式）──
    if primary is None:
        findings.append(Finding(
            severity=SEVERITY_INFO,
            code="no_primary_provider",
            message="providers.json 无可用 primary，LLM 配置完全来自 .env",
            details={"env_model": LLM_MODEL, "env_base_url": LLM_BASE_URL},
        ))
        return findings

    # ── primary 被禁用却仍被选中（配置自相矛盾）──
    if not getattr(primary, "enabled", True):
        findings.append(Finding(
            severity=SEVERITY_ERROR,
            code="primary_disabled",
            message=f"primary provider {primary.name!r} 处于 disabled 状态却被选中 —— 配置自相矛盾",
            hint="检查 providers.json 的 primary 字段与 enabled 标记",
            details={"primary": primary.name},
        ))

    # ── 模型名缺 provider 前缀 ──
    # 分级依据：`_normalize_model()` 能否补上前缀。
    #   能补 → INFO（已被归一化覆盖，可见但不告警，避免制造告警疲劳）
    #   补不上 → ERROR（真的会走到 litellm 并抛 BadRequestError）
    model = getattr(primary, "model", "") or ""
    if model and "/" not in model:
        normalized = _try_normalize(model)
        if normalized and "/" in normalized:
            findings.append(Finding(
                severity=SEVERITY_INFO,
                code="model_prefix_auto_added",
                message=(
                    f"primary.model={model!r} 未写 provider 前缀，"
                    f"运行时会自动归一化为 {normalized!r}"
                ),
                details={"primary": primary.name, "model": model, "normalized": normalized},
            ))
        else:
            findings.append(Finding(
                severity=SEVERITY_ERROR,
                code="unprefixed_model",
                message=(
                    f"primary.model={model!r} 缺 provider 前缀且无法自动归一化 —— "
                    "litellm 会抛 BadRequestError('LLM Provider NOT provided')"
                ),
                hint="在 providers.json 中写成 <provider>/<model>，或配置 base_url 以便推断",
                details={"primary": primary.name, "model": model},
            ))

    # ── 占位密钥（本次故障的直接特征）──
    if _looks_like_placeholder(getattr(primary, "api_key", "")):
        findings.append(Finding(
            severity=SEVERITY_ERROR,
            code="placeholder_api_key",
            message=(
                f"primary provider {primary.name!r} 的 api_key 疑似占位/测试值 "
                "—— 所有 LLM 调用都会认证失败"
            ),
            hint="从 providers.json 移除该测试 provider，或改 primary 指向真实 provider",
            details={
                "primary": primary.name,
                "api_key": _mask(getattr(primary, "api_key", "")),
                "base_url": getattr(primary, "base_url", ""),
            },
        ))

    # ── 与 .env 的三项不一致（覆盖是合法的，但必须显式可见）──
    mismatches: dict[str, Any] = {}

    if LLM_MODEL and model:
        # 比较时忽略 provider 前缀（normalize 会补前缀，不构成真实差异）
        env_bare = LLM_MODEL.split("/")[-1]
        primary_bare = model.split("/")[-1]
        if env_bare != primary_bare:
            mismatches["model"] = {"env": LLM_MODEL, "primary": model}

    if LLM_BASE_URL and getattr(primary, "base_url", ""):
        if _normalize_for_compare(LLM_BASE_URL) != _normalize_for_compare(primary.base_url):
            mismatches["base_url"] = {
                "env": LLM_BASE_URL,
                "primary": primary.base_url,
            }

    if LLM_API_KEY and getattr(primary, "api_key", ""):
        if LLM_API_KEY.strip() != primary.api_key.strip():
            mismatches["api_key"] = {
                "env": _mask(LLM_API_KEY),
                "primary": _mask(primary.api_key),
            }

    if mismatches:
        findings.append(Finding(
            severity=SEVERITY_WARNING,
            code="env_overridden_by_primary",
            message=(
                f"providers.json 的 primary={primary.name!r} 正在**覆盖** .env 中的 "
                f"{'/'.join(sorted(mismatches))} —— 实际生效的是 primary 的值"
            ),
            hint=(
                "确认是否有意为之；若非本意，改 providers.json 的 primary "
                "或删除残留 provider"
            ),
            details={"primary": primary.name, **mismatches},
        ))
    else:
        findings.append(Finding(
            severity=SEVERITY_INFO,
            code="consistent",
            message="providers.json 的 primary 与 .env 配置一致",
            details={"primary": primary.name},
        ))

    return findings


def log_findings(findings: list[Finding]) -> None:
    """把校验结果写入日志。error 级用 error，warning 级用 warning。"""
    for f in findings:
        if f.severity == SEVERITY_ERROR:
            log.error(f"provider 配置校验: {f.message}", code=f.code, hint=f.hint)
        elif f.severity == SEVERITY_WARNING:
            log.warning(f"provider 配置校验: {f.message}", code=f.code, hint=f.hint)
        else:
            log.debug(f"provider 配置校验: {f.message}", code=f.code)


def has_error(findings: list[Finding]) -> bool:
    """是否存在 error 级发现（供 preflight 决定退出码）。"""
    return any(f.severity == SEVERITY_ERROR for f in findings)
