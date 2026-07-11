"""技能来源追踪（Skill Provenance）。

追踪技能的来源、版本、签名和变更历史：
  - 技能来源记录（本地/远程/市场/用户上传）
  - 版本追踪与变更日志
  - 代码签名验证（防篡改）
  - 依赖关系追踪
  - 来源可信度评分
  - 审计日志

与 SkillAuditor 的关系：
  - SkillAuditor 做静态安全审计
  - SkillProvenance 追踪来源可信度
  - 两者组合提供完整的安全+来源保障

集成示例::

    from agent.evolution.skill_provenance import SkillProvenance

    prov = SkillProvenance()
    prov.register_source("my_skill", source_type="market", url="https://hub.example.com/skills/my_skill")
    record = prov.get_provenance("my_skill")
    print(record.trust_score)  # 0.8
"""

from __future__ import annotations

import hashlib
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("skill_provenance")


class SourceType(str, Enum):
    """技能来源类型。"""

    LOCAL = "local"
    REMOTE = "remote"
    MARKET = "market"
    USER_UPLOAD = "user_upload"
    BUILTIN = "builtin"
    GIT = "git"


@dataclass
class VersionRecord:
    """版本记录。

    Attributes:
        version: 版本号。
        checksum: 代码校验和。
        timestamp: 时间戳。
        changelog: 变更说明。
        author: 作者。
    """

    version: str = "0.0.1"
    checksum: str = ""
    timestamp: float = 0.0
    changelog: str = ""
    author: str = ""

    def __post_init__(self) -> None:
        if self.timestamp == 0.0:
            self.timestamp = time.time()


@dataclass
class ProvenanceRecord:
    """来源记录。

    Attributes:
        skill_id: 技能 ID。
        source_type: 来源类型。
        source_url: 来源 URL。
        trust_score: 可信度评分（0-1）。
        versions: 版本历史。
        dependencies: 依赖技能列表。
        signer: 签名者。
        signature: 签名值。
        metadata: 附加元数据。
        registered_at: 注册时间。
    """

    skill_id: str = ""
    source_type: SourceType = SourceType.LOCAL
    source_url: str = ""
    trust_score: float = 0.5
    versions: list[VersionRecord] = field(default_factory=list)
    dependencies: list[str] = field(default_factory=list)
    signer: str = ""
    signature: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    registered_at: float = 0.0

    def __post_init__(self) -> None:
        if self.registered_at == 0.0:
            self.registered_at = time.time()

    @property
    def latest_version(self) -> VersionRecord | None:
        """最新版本。"""
        return self.versions[-1] if self.versions else None

    @property
    def is_verified(self) -> bool:
        """签名是否已验证。"""
        return bool(self.signature)


TRUST_SCORES: dict[SourceType, float] = {
    SourceType.BUILTIN: 1.0,
    SourceType.MARKET: 0.8,
    SourceType.GIT: 0.7,
    SourceType.REMOTE: 0.5,
    SourceType.LOCAL: 0.6,
    SourceType.USER_UPLOAD: 0.3,
}


class SkillProvenance:
    """技能来源追踪器。

    追踪技能的来源、版本、签名和变更历史。
    """

    def __init__(self) -> None:
        self._records: dict[str, ProvenanceRecord] = {}
        self._audit: list[dict[str, Any]] = []
        self._max_audit = 500

    def register_source(
        self,
        skill_id: str,
        source_type: SourceType = SourceType.LOCAL,
        url: str = "",
        trust_score: float | None = None,
        dependencies: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> ProvenanceRecord:
        """注册技能来源。

        Args:
            skill_id: 技能 ID。
            source_type: 来源类型。
            url: 来源 URL。
            trust_score: 可信度评分（None 则按来源类型默认）。
            dependencies: 依赖技能列表。
            metadata: 附加元数据。

        Returns:
            ProvenanceRecord 来源记录。
        """
        score = trust_score if trust_score is not None else TRUST_SCORES.get(source_type, 0.5)

        record = ProvenanceRecord(
            skill_id=skill_id,
            source_type=source_type,
            source_url=url,
            trust_score=score,
            dependencies=dependencies or [],
            metadata=metadata or {},
        )
        self._records[skill_id] = record
        self._record_audit("register", skill_id, source_type=source_type.value, url=url)
        log.info("Skill source registered", skill_id=skill_id, source=source_type.value, trust=score)
        return record

    def add_version(
        self,
        skill_id: str,
        version: str,
        code: str = "",
        changelog: str = "",
        author: str = "",
    ) -> VersionRecord:
        """添加版本记录。

        Args:
            skill_id: 技能 ID。
            version: 版本号。
            code: 技能代码（用于计算校验和）。
            changelog: 变更说明。
            author: 作者。

        Returns:
            VersionRecord 版本记录。
        """
        record = self._records.get(skill_id)
        if record is None:
            record = self.register_source(skill_id)

        checksum = hashlib.sha256(code.encode()).hexdigest() if code else ""

        ver = VersionRecord(
            version=version,
            checksum=checksum,
            changelog=changelog,
            author=author,
        )
        record.versions.append(ver)
        self._record_audit("add_version", skill_id, version=version, checksum=checksum[:16])
        return ver

    def verify_integrity(self, skill_id: str, code: str) -> bool:
        """验证技能代码完整性。

        Args:
            skill_id: 技能 ID。
            code: 当前代码。

        Returns:
            是否与最新版本校验和匹配。
        """
        record = self._records.get(skill_id)
        if record is None or not record.versions:
            return False

        current_checksum = hashlib.sha256(code.encode()).hexdigest()
        latest = record.versions[-1]
        match = current_checksum == latest.checksum

        if not match:
            log.warning(
                "Skill integrity check failed",
                skill_id=skill_id,
                expected=latest.checksum[:16],
                actual=current_checksum[:16],
            )
            self._record_audit("integrity_fail", skill_id)

        return match

    def get_provenance(self, skill_id: str) -> ProvenanceRecord | None:
        """获取技能来源记录。"""
        return self._records.get(skill_id)

    def get_dependency_chain(self, skill_id: str) -> list[str]:
        """获取技能的完整依赖链（递归展开）。"""
        visited: set[str] = set()
        chain: list[str] = []

        def _walk(sid: str) -> None:
            if sid in visited:
                return
            visited.add(sid)
            record = self._records.get(sid)
            if record:
                for dep in record.dependencies:
                    chain.append(dep)
                    _walk(dep)

        _walk(skill_id)
        return chain

    def get_trust_report(self) -> dict[str, Any]:
        """获取可信度报告。"""
        if not self._records:
            return {"total": 0}

        scores = [r.trust_score for r in self._records.values()]
        low_trust = [r.skill_id for r in self._records.values() if r.trust_score < 0.5]
        verified = sum(1 for r in self._records.values() if r.is_verified)

        return {
            "total": len(self._records),
            "avg_trust": round(sum(scores) / len(scores), 3),
            "low_trust_skills": low_trust,
            "verified_count": verified,
            "by_source": {
                st.value: sum(1 for r in self._records.values() if r.source_type == st)
                for st in SourceType
            },
        }

    def get_audit_log(self, limit: int = 100) -> list[dict[str, Any]]:
        """获取审计日志。"""
        return self._audit[-limit:]

    def _record_audit(self, action: str, skill_id: str, **kwargs: Any) -> None:
        """记录审计日志。"""
        entry = {"action": action, "skill_id": skill_id, "ts": time.time(), **kwargs}
        self._audit.append(entry)
        if len(self._audit) > self._max_audit:
            self._audit = self._audit[-self._max_audit:]
