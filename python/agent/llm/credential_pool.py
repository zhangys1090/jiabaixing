from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from agent.config import DATA_DIR


class RotationStrategy(str, Enum):
    FILL_FIRST = "fill_first"
    ROUND_ROBIN = "round_robin"
    LEAST_USED = "least_used"
    RANDOM = "random"


@dataclass
class CredentialEntry:
    key: str
    weight: float = 1.0
    label: str = ""

    @property
    def masked(self) -> str:
        if len(self.key) <= 8:
            return "***"
        return self.key[:4] + "..." + self.key[-4:]


@dataclass
class CredentialState:
    entry: CredentialEntry
    failure_count: int = 0
    rate_limited_until: float = 0.0
    total_requests: int = 0
    last_used: float = 0.0

    @property
    def is_available(self) -> bool:
        if self.failure_count >= 3:
            return False
        if self.rate_limited_until > time.time():
            return False
        return True


class CredentialPool:
    """凭据池，管理多个 API Key 的轮换、故障隔离和用量追踪。

    支持四种轮换策略：填满优先、轮询、最少使用、随机权重。
    内置健康检查、用量统计和自动恢复能力。

    Attributes:
        provider_name: 提供商名称。
        _usage_stats: 每个凭据的用量统计字典。
    """

    def __init__(
        self,
        provider_name: str,
        entries: list[CredentialEntry],
        strategy: RotationStrategy = RotationStrategy.FILL_FIRST,
    ) -> None:
        self.provider_name = provider_name
        self._strategy = strategy
        self._states: list[CredentialState] = [
            CredentialState(entry=e) for e in entries
        ]
        self._round_robin_index: int = 0
        self._usage_stats: dict[str, dict[str, Any]] = {
            s.entry.label or s.entry.masked: {
                "tokens_used": 0,
                "cost_usd": 0.0,
                "request_count": 0,
            }
            for s in self._states
        }

    def get_next(self) -> CredentialEntry:
        available = self._get_available()
        if not available:
            self._force_reset()
            available = self._states

        if self._strategy == RotationStrategy.ROUND_ROBIN:
            return self._select_round_robin(available)
        elif self._strategy == RotationStrategy.LEAST_USED:
            return self._select_least_used(available)
        elif self._strategy == RotationStrategy.RANDOM:
            return self._select_random(available)
        else:
            return self._select_fill_first(available)

    def report_rate_limit(self, key: str, retry_after: float | None = None) -> None:
        state = self._find_by_key(key)
        if state:
            if retry_after is not None:
                if retry_after <= time.time():
                    return
                state.rate_limited_until = retry_after
            else:
                state.rate_limited_until = time.time() + 60

    def report_failure(self, key: str) -> None:
        state = self._find_by_key(key)
        if state:
            state.failure_count += 1

    def report_success(self, key: str) -> None:
        state = self._find_by_key(key)
        if state:
            state.failure_count = 0
            state.total_requests += 1
            state.last_used = time.time()

    @property
    def size(self) -> int:
        return len(self._states)

    @property
    def available_size(self) -> int:
        return len(self._get_available())

    def get_available_credentials(self) -> list[CredentialEntry]:
        return [s.entry for s in self._get_available()]

    def get_stats(self) -> dict[str, Any]:
        return {
            "provider": self.provider_name,
            "strategy": self._strategy,
            "total": self.size,
            "available": self.available_size,
            "credentials": [
                {
                    "key": s.entry.masked,
                    "available": s.is_available,
                    "failure_count": s.failure_count,
                    "total_requests": s.total_requests,
                    "rate_limited": s.rate_limited_until > time.time(),
                }
                for s in self._states
            ],
        }

    def health_check(self) -> dict[str, bool]:
        """检查所有凭据是否可用。

        Returns:
            dict[str, bool]: 凭据标签/掩码 -> 是否可用。True 表示可用，False 表示不可用。
        """
        result: dict[str, bool] = {}
        for s in self._states:
            label = s.entry.label or s.entry.masked
            result[label] = s.is_available
        return result

    def report_usage(self, key_label: str, tokens_used: int, cost_usd: float) -> None:
        """报告凭据用量。

        Args:
            key_label: 凭据标签（entry.label）或掩码（entry.masked）。
            tokens_used: 使用的 Token 数量。
            cost_usd: 消耗的美元成本。
        """
        if key_label not in self._usage_stats:
            self._usage_stats[key_label] = {
                "tokens_used": 0,
                "cost_usd": 0.0,
                "request_count": 0,
            }
        self._usage_stats[key_label]["tokens_used"] += tokens_used
        self._usage_stats[key_label]["cost_usd"] += cost_usd
        self._usage_stats[key_label]["request_count"] += 1

    def get_usage_stats(self) -> dict[str, Any]:
        """获取用量统计。

        Returns:
            dict: 包含每个凭据的用量统计和汇总数据。结构：
                - per_credential: 各凭据的详细用量。
                - total_tokens: 总 Token 数。
                - total_cost_usd: 总成本。
                - total_requests: 总请求数。
        """
        total_tokens = sum(v["tokens_used"] for v in self._usage_stats.values())
        total_cost = sum(v["cost_usd"] for v in self._usage_stats.values())
        total_requests = sum(v["request_count"] for v in self._usage_stats.values())
        return {
            "provider": self.provider_name,
            "per_credential": dict(self._usage_stats),
            "total_tokens": total_tokens,
            "total_cost_usd": round(total_cost, 6),
            "total_requests": total_requests,
        }

    def auto_recover(self) -> int:
        """自动恢复失败次数超限的凭据。

        将 failure_count >= 3 的凭据重置 failure_count 为 0，
        使其重新变为可用。

        Returns:
            int: 恢复的凭据数量。
        """
        recovered = 0
        for s in self._states:
            if s.failure_count >= 3:
                s.failure_count = 0
                recovered += 1
        return recovered

    def _get_available(self) -> list[CredentialState]:
        return [s for s in self._states if s.is_available]

    def _find_by_key(self, key: str) -> CredentialState | None:
        for s in self._states:
            if s.entry.key == key:
                return s
        return None

    def _force_reset(self) -> None:
        for s in self._states:
            s.failure_count = 0
            s.rate_limited_until = 0.0

    def _select_fill_first(self, available: list[CredentialState]) -> CredentialEntry:
        return available[0].entry

    def _select_round_robin(self, available: list[CredentialState]) -> CredentialEntry:
        self._round_robin_index = self._round_robin_index % len(available)
        entry = available[self._round_robin_index].entry
        self._round_robin_index += 1
        return entry

    def _select_least_used(self, available: list[CredentialState]) -> CredentialEntry:
        available.sort(key=lambda s: s.total_requests)
        return available[0].entry

    def _select_random(self, available: list[CredentialState]) -> CredentialEntry:
        import random
        total_weight = sum(s.entry.weight for s in available)
        r = random.random() * total_weight
        for s in available:
            r -= s.entry.weight
            if r <= 0:
                return s.entry
        return available[0].entry


@dataclass
class UsageRecord:
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    timestamp: float = 0.0


_MODEL_PRICING: dict[str, dict[str, float]] = {
    "gpt-4o": {"input": 2.50 / 1_000_000, "output": 10.00 / 1_000_000},
    "gpt-4o-mini": {"input": 0.15 / 1_000_000, "output": 0.60 / 1_000_000},
    "gpt-4-turbo": {"input": 10.00 / 1_000_000, "output": 30.00 / 1_000_000},
    "gpt-4": {"input": 30.00 / 1_000_000, "output": 60.00 / 1_000_000},
    "gpt-3.5-turbo": {"input": 0.50 / 1_000_000, "output": 1.50 / 1_000_000},
    "claude-3.5-sonnet": {"input": 3.00 / 1_000_000, "output": 15.00 / 1_000_000},
    "claude-3.5-haiku": {"input": 0.80 / 1_000_000, "output": 4.00 / 1_000_000},
    "claude-3-opus": {"input": 15.00 / 1_000_000, "output": 75.00 / 1_000_000},
    "claude-3-haiku": {"input": 0.25 / 1_000_000, "output": 1.25 / 1_000_000},
    "claude-3-sonnet": {"input": 3.00 / 1_000_000, "output": 15.00 / 1_000_000},
    "gemini-pro": {"input": 0.50 / 1_000_000, "output": 1.50 / 1_000_000},
    "gemini-1.5-pro": {"input": 3.50 / 1_000_000, "output": 10.50 / 1_000_000},
    "gemini-1.5-flash": {"input": 0.075 / 1_000_000, "output": 0.30 / 1_000_000},
    "gemini-2.0-flash": {"input": 0.10 / 1_000_000, "output": 0.40 / 1_000_000},
    "deepseek-chat": {"input": 0.14 / 1_000_000, "output": 0.28 / 1_000_000},
    "deepseek-reasoner": {"input": 0.55 / 1_000_000, "output": 2.19 / 1_000_000},
    "qwen-plus": {"input": 0.80 / 1_000_000, "output": 2.00 / 1_000_000},
    "qwen-turbo": {"input": 0.30 / 1_000_000, "output": 0.60 / 1_000_000},
    "qwen-max": {"input": 2.40 / 1_000_000, "output": 9.60 / 1_000_000},
    "glm-4": {"input": 1.50 / 1_000_000, "output": 1.50 / 1_000_000},
    "glm-4-flash": {"input": 0.10 / 1_000_000, "output": 0.10 / 1_000_000},
    "mimo-7b": {"input": 0.10 / 1_000_000, "output": 0.10 / 1_000_000},
}


class BudgetAlertLevel(str, Enum):
    NORMAL = "normal"
    WARNING = "warning"
    CRITICAL = "critical"
    EXCEEDED = "exceeded"


@dataclass
class BudgetAlert:
    level: BudgetAlertLevel
    message: str
    spent_usd: float
    budget_usd: float
    pct: float


@dataclass
class ModelCostEstimate:
    model: str
    estimated_input_tokens: int
    estimated_output_tokens: int
    estimated_cost_usd: float
    within_budget: bool


class CostGuard:
    def __init__(
        self,
        daily_budget_usd: float = 1.0,
        per_request_budget_usd: float = 0.05,
        warning_threshold: float = 0.7,
        critical_threshold: float = 0.9,
    ) -> None:
        self._daily_budget = daily_budget_usd
        self._per_request_budget = per_request_budget_usd
        self._warning_threshold = warning_threshold
        self._critical_threshold = critical_threshold
        self._records: list[UsageRecord] = []
        self._daily_reset: float = time.time()
        self._alert_callbacks: list[Any] = []

    def on_budget_alert(self, callback: Any) -> None:
        self._alert_callbacks.append(callback)

    def check_budget_alert(self) -> BudgetAlert:
        self._check_daily_reset()
        spent = self.get_daily_spent()
        pct = spent / self._daily_budget if self._daily_budget > 0 else 0

        if pct >= 1.0:
            alert = BudgetAlert(
                level=BudgetAlertLevel.EXCEEDED,
                message=f"预算已超支: ${spent:.4f} / ${self._daily_budget:.2f}",
                spent_usd=spent,
                budget_usd=self._daily_budget,
                pct=pct,
            )
        elif pct >= self._critical_threshold:
            alert = BudgetAlert(
                level=BudgetAlertLevel.CRITICAL,
                message=f"预算即将耗尽: ${spent:.4f} / ${self._daily_budget:.2f} ({pct:.0%})",
                spent_usd=spent,
                budget_usd=self._daily_budget,
                pct=pct,
            )
        elif pct >= self._warning_threshold:
            alert = BudgetAlert(
                level=BudgetAlertLevel.WARNING,
                message=f"预算使用过半: ${spent:.4f} / ${self._daily_budget:.2f} ({pct:.0%})",
                spent_usd=spent,
                budget_usd=self._daily_budget,
                pct=pct,
            )
        else:
            alert = BudgetAlert(
                level=BudgetAlertLevel.NORMAL,
                message="预算正常",
                spent_usd=spent,
                budget_usd=self._daily_budget,
                pct=pct,
            )

        for cb in self._alert_callbacks:
            try:
                cb(alert)
            except Exception:
                pass
        return alert

    def estimate_request_cost(
        self,
        model: str,
        estimated_input_tokens: int,
        estimated_output_tokens: int | None = None,
    ) -> ModelCostEstimate:
        if estimated_output_tokens is None:
            estimated_output_tokens = min(estimated_input_tokens, self._per_request_budget / max(self.calculate_cost(model, 1, 1), 0.000001))

        estimated_cost = self.calculate_cost(model, estimated_input_tokens, estimated_output_tokens)
        within = self.check_budget(estimated_cost)

        return ModelCostEstimate(
            model=model,
            estimated_input_tokens=estimated_input_tokens,
            estimated_output_tokens=estimated_output_tokens,
            estimated_cost_usd=estimated_cost,
            within_budget=within,
        )

    @staticmethod
    def get_model_pricing(model: str) -> dict[str, float] | None:
        return _MODEL_PRICING.get(model)

    @staticmethod
    def list_priced_models() -> list[str]:
        return list(_MODEL_PRICING.keys())

    def calculate_cost(self, model: str, input_tokens: int, output_tokens: int) -> float:
        pricing = _MODEL_PRICING.get(model)
        if not pricing:
            pricing = {"input": 1.0 / 1_000_000, "output": 3.0 / 1_000_000}
        return input_tokens * pricing["input"] + output_tokens * pricing["output"]

    def record_usage(self, model: str, input_tokens: int, output_tokens: int) -> UsageRecord:
        self._check_daily_reset()
        cost = self.calculate_cost(model, input_tokens, output_tokens)
        record = UsageRecord(
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_usd=cost,
            timestamp=time.time(),
        )
        self._records.append(record)
        return record

    def check_budget(self, estimated_cost: float) -> bool:
        self._check_daily_reset()
        daily_spent = self.get_daily_spent()
        if daily_spent + estimated_cost > self._daily_budget:
            return False
        if estimated_cost > self._per_request_budget:
            return False
        return True

    def get_daily_spent(self) -> float:
        return sum(r.cost_usd for r in self._records)

    def get_daily_stats(self) -> dict[str, Any]:
        self._check_daily_reset()
        total_input = sum(r.input_tokens for r in self._records)
        total_output = sum(r.output_tokens for r in self._records)
        total_cost = sum(r.cost_usd for r in self._records)
        by_model: dict[str, dict[str, float]] = {}
        for r in self._records:
            if r.model not in by_model:
                by_model[r.model] = {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}
            by_model[r.model]["input_tokens"] += r.input_tokens
            by_model[r.model]["output_tokens"] += r.output_tokens
            by_model[r.model]["cost_usd"] += r.cost_usd
        return {
            "total_input_tokens": total_input,
            "total_output_tokens": total_output,
            "total_cost_usd": round(total_cost, 6),
            "daily_budget_usd": self._daily_budget,
            "budget_remaining_usd": round(self._daily_budget - total_cost, 6),
            "budget_used_pct": round(total_cost / self._daily_budget * 100, 1) if self._daily_budget > 0 else 0,
            "request_count": len(self._records),
            "by_model": by_model,
        }

    def set_daily_budget(self, budget_usd: float) -> None:
        self._daily_budget = budget_usd

    def _check_daily_reset(self) -> None:
        now = time.time()
        if now - self._daily_reset > 86400:
            self._records = []
            self._daily_reset = now



# =============================================================================
# 凭据持久化与多源发现（P1 增强）
# =============================================================================


class CredentialPersistence:
    """凭据池状态持久化。

    将凭据池的运行时状态（failure_count/rate_limited_until/total_requests）
    持久化到 JSON 文件，避免进程重启后状态丢失。

    Attributes:
        file_path: 持久化文件路径。
    """

    def __init__(self, file_path: Path | None = None) -> None:
        """初始化持久化存储。

        Args:
            file_path: 持久化文件路径，默认为 DATA_DIR/credentials.json。
        """
        self.file_path = file_path or (DATA_DIR / "credentials.json")
        self.file_path.parent.mkdir(parents=True, exist_ok=True)

    def save(self, manager: "CredentialPoolManager") -> None:
        """保存所有凭据池状态到文件（原子写）。

        Args:
            manager: 凭据池管理器实例。
        """
        data: dict[str, Any] = {"providers": {}}
        for provider_name, pool in manager._pools.items():
            data["providers"][provider_name] = {
                "strategy": pool._strategy.value,
                "credentials": [
                    {
                        "key": s.entry.key,
                        "weight": s.entry.weight,
                        "label": s.entry.label,
                        "failure_count": s.failure_count,
                        "rate_limited_until": s.rate_limited_until,
                        "total_requests": s.total_requests,
                        "last_used": s.last_used,
                    }
                    for s in pool._states
                ],
            }
        tmp_path = self.file_path.with_suffix(".tmp")
        with tmp_path.open("w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        tmp_path.replace(self.file_path)

    def load(self) -> dict[str, Any]:
        """从文件加载状态。

        Returns:
            dict: 持久化的状态字典，结构如 save() 中所述。文件不存在时返回空字典。
        """
        if not self.file_path.exists():
            return {"providers": {}}
        try:
            with self.file_path.open("r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            return {"providers": {}}

    def apply(self, manager: "CredentialPoolManager") -> int:
        """将持久化状态应用到管理器中的凭据池。

        Args:
            manager: 凭据池管理器实例。

        Returns:
            int: 成功恢复状态的凭据数量。
        """
        data = self.load()
        restored = 0
        for provider_name, pdata in data.get("providers", {}).items():
            pool = manager._pools.get(provider_name)
            if not pool:
                continue
            for cred_data in pdata.get("credentials", []):
                state = pool._find_by_key(cred_data.get("key", ""))
                if state:
                    state.failure_count = cred_data.get("failure_count", 0)
                    state.rate_limited_until = cred_data.get("rate_limited_until", 0.0)
                    state.total_requests = cred_data.get("total_requests", 0)
                    state.last_used = cred_data.get("last_used", 0.0)
                    restored += 1
        return restored


class CredentialSources:
    """凭据多源发现器。

    从环境变量、凭据文件等多种来源发现 API Key，支持多 Key 轮换。

    支持的环境变量模式：
        - OPENAI_API_KEY / OPENAI_API_KEY_2 / OPENAI_API_KEY_3 ...
        - ANTHROPIC_API_KEY / ANTHROPIC_API_KEY_2 ...
        - 逗号分隔：OPENAI_API_KEY="key1,key2,key3"

    支持的凭据文件：
        - ~/.jiabaixing/credentials/{provider}.txt （每行一个 key）
        - /etc/jiabaixing/credentials/{provider}.txt （系统级）
    """

    # 提供商 -> 环境变量名列表
    _ENV_MAP: dict[str, list[str]] = {
        "openai": ["OPENAI_API_KEY"],
        "anthropic": ["ANTHROPIC_API_KEY"],
        "gemini": ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        "deepseek": ["DEEPSEEK_API_KEY"],
        "qwen": ["QWEN_API_KEY", "DASHSCOPE_API_KEY"],
        "glm": ["GLM_API_KEY", "ZHIPU_API_KEY"],
        "mimo": ["MIMO_API_KEY"],
        "azure": ["AZURE_OPENAI_API_KEY"],
    }

    # 凭据文件搜索路径
    _FILE_PATHS: list[Path] = [
        Path.home() / ".jiabaixing" / "credentials",
        Path("/etc/jiabaixing/credentials"),
    ]

    @classmethod
    def discover(
        cls,
        provider: str,
        env: dict[str, str] | None = None,
    ) -> list[CredentialEntry]:
        """发现指定提供商的所有可用 API Key。

        优先级：环境变量 > 凭据文件。会去重。

        Args:
            provider: 提供商名称（小写）。
            env: 环境变量字典，默认使用 os.environ。

        Returns:
            list[CredentialEntry]: 发现的凭据条目列表。
        """
        import os

        env = env if env is not None else dict(os.environ)
        keys: list[str] = []
        seen: set[str] = set()

        # 1. 从环境变量发现
        for env_name in cls._ENV_MAP.get(provider, []):
            # 主变量
            value = env.get(env_name, "").strip()
            if value:
                for k in value.split(","):
                    k = k.strip()
                    if k and k not in seen:
                        keys.append(k)
                        seen.add(k)
            # 编号后缀变量 _2, _3, ...
            i = 2
            while True:
                v = env.get(f"{env_name}_{i}", "").strip()
                if not v:
                    break
                if v not in seen:
                    keys.append(v)
                    seen.add(v)
                i += 1

        # 2. 从凭据文件发现
        for cred_dir in cls._FILE_PATHS:
            cred_file = cred_dir / f"{provider}.txt"
            if cred_file.exists():
                try:
                    with cred_file.open("r", encoding="utf-8") as f:
                        for line in f:
                            k = line.strip()
                            if k and not k.startswith("#") and k not in seen:
                                keys.append(k)
                                seen.add(k)
                except OSError:
                    continue

        return [CredentialEntry(key=k, label=f"{provider}-{i}") for i, k in enumerate(keys, 1)]

    @classmethod
    def discover_all(cls) -> dict[str, list[CredentialEntry]]:
        """发现所有提供商的凭据。

        Returns:
            dict: 提供商名称 -> 凭据条目列表。
        """
        result: dict[str, list[CredentialEntry]] = {}
        for provider in cls._ENV_MAP:
            entries = cls.discover(provider)
            if entries:
                result[provider] = entries
        return result


class CredentialPoolManager:
    """多提供商凭据池管理器。

    统一管理多个提供商的凭据池，支持自动发现、持久化和轮换策略。

    Attributes:
        _pools: 提供商名称 -> CredentialPool 映射。
        _persistence: 持久化实例。
    """

    def __init__(
        self,
        persistence: CredentialPersistence | None = None,
        auto_discover: bool = True,
    ) -> None:
        """初始化凭据池管理器。

        Args:
            persistence: 持久化实例，传入 None 则禁用持久化。
            auto_discover: 是否自动从环境变量和文件发现凭据。
        """
        self._pools: dict[str, CredentialPool] = {}
        self._persistence = persistence

        if auto_discover:
            discovered = CredentialSources.discover_all()
            for provider, entries in discovered.items():
                self.setup_provider(provider, entries)

        if self._persistence:
            restored = self._persistence.apply(self)
            if restored > 0:
                import logging
                logging.getLogger(__name__).info(
                    "Credential pool state restored", extra={"restored": restored}
                )

    def setup_provider(
        self,
        provider: str,
        entries: list[CredentialEntry],
        strategy: RotationStrategy = RotationStrategy.ROUND_ROBIN,
    ) -> CredentialPool:
        """设置或替换提供商的凭据池。

        Args:
            provider: 提供商名称（小写）。
            entries: 凭据条目列表。
            strategy: 轮换策略，默认 ROUND_ROBIN。

        Returns:
            CredentialPool: 创建/替换后的凭据池实例。
        """
        pool = CredentialPool(provider, entries, strategy)
        self._pools[provider] = pool
        return pool

    def get_pool(self, provider: str) -> CredentialPool | None:
        """获取提供商的凭据池。

        Args:
            provider: 提供商名称。

        Returns:
            CredentialPool | None: 凭据池实例，不存在时返回 None。
        """
        return self._pools.get(provider)

    def get_next(self, provider: str) -> CredentialEntry | None:
        """获取下一个可用凭据。

        Args:
            provider: 提供商名称。

        Returns:
            CredentialEntry | None: 凭据条目，无可用凭据时返回 None。
        """
        pool = self._pools.get(provider)
        if not pool:
            return None
        try:
            return pool.get_next()
        except IndexError:
            return None

    def report_success(self, provider: str, key: str) -> None:
        """报告凭据调用成功。

        Args:
            provider: 提供商名称。
            key: API Key。
        """
        pool = self._pools.get(provider)
        if pool:
            pool.report_success(key)

    def report_failure(self, provider: str, key: str) -> None:
        """报告凭据调用失败。

        Args:
            provider: 提供商名称。
            key: API Key。
        """
        pool = self._pools.get(provider)
        if pool:
            pool.report_failure(key)

    def report_rate_limit(
        self,
        provider: str,
        key: str,
        retry_after: float | None = None,
    ) -> None:
        """报告凭据被限流。

        Args:
            provider: 提供商名称。
            key: API Key。
            retry_after: 限流恢复时间戳，None 则默认 60 秒后。
        """
        pool = self._pools.get(provider)
        if pool:
            pool.report_rate_limit(key, retry_after)

    def persist_all(self) -> bool:
        """持久化所有凭据池状态。

        Returns:
            bool: 是否成功持久化（未配置持久化时返回 False）。
        """
        if not self._persistence:
            return False
        self._persistence.save(self)
        return True

    def get_all_stats(self) -> dict[str, Any]:
        """获取所有凭据池的统计信息。

        Returns:
            dict: 提供商名称 -> 统计信息。
        """
        return {name: pool.get_stats() for name, pool in self._pools.items()}

    @property
    def providers(self) -> list[str]:
        """已配置的提供商列表。"""
        return list(self._pools.keys())

    def has_provider(self, provider: str) -> bool:
        """是否配置了指定提供商。

        Args:
            provider: 提供商名称。

        Returns:
            bool: 是否已配置。
        """
        return provider in self._pools
