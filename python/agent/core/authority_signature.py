"""D4-I2 Post-Audit: authorityMeta HMAC 防伪造签名。

解决审计发现的问题：TS delegated 路径此前仅做
``authority_decisionId`` 三字段存在性检查，任何能到达
``POST /api/desktop/automate`` 的调用方都可伪造
"合法 decisionId + 任意 action"（拿通行证换货）。

方案：Python 端（desktop_tools._call_ts_desktop）对
``goalId | snapshotId | decisionId | actionHash`` 计算 HMAC-SHA256，
TS 端（src/authority/AuthoritySignature.ts）用共享密钥校验，
签名无效时拒绝走 delegated 路径（fail-safe 降级为 TS 本地决策链）。

密钥约定：
- 环境变量 ``AGENT_AUTHORITY_HMAC_SECRET``，两端必须一致；
- 未设置时回退内置开发默认值（仅限本地开发，生产必须显式设置并告警）。
"""
from __future__ import annotations

import hashlib
import hmac
import os
from typing import Any

_DEV_FALLBACK_SECRET = "jiabaixing-dev-authority-secret"


def _secret() -> str:
    return os.environ.get("AGENT_AUTHORITY_HMAC_SECRET") or _DEV_FALLBACK_SECRET


def is_production_secret() -> bool:
    """生产部署必须显式设置 AGENT_AUTHORITY_HMAC_SECRET。"""
    return bool(os.environ.get("AGENT_AUTHORITY_HMAC_SECRET"))


def action_hash(task: str) -> str:
    """动作内容哈希：绑定"这个 decision 到底对应哪个 action/task"。"""
    return hashlib.sha256(task.encode("utf-8")).hexdigest()


def sign_authority_meta(
    goal_id: str,
    snapshot_id: str,
    decision_id: str,
    action_hash_hex: str,
) -> str:
    """对 authority 四元组计算 HMAC-SHA256 签名（hex）。"""
    message = f"{goal_id}|{snapshot_id}|{decision_id}|{action_hash_hex}"
    return hmac.new(
        _secret().encode("utf-8"),
        message.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def signed_authority_payload(
    authority_meta: dict[str, Any],
    task: str,
) -> dict[str, Any]:
    """为 HTTP payload["authority"] 补齐签名字段。

    输入 authority_meta 来自 ToolCall.metadata（authority_* 前缀键），
    输出额外携带 ``authority_sig``（绑定 task 内容哈希）。
    """
    goal_id = str(authority_meta.get("authority_goalId", ""))
    snapshot_id = str(authority_meta.get("authority_snapshotId", ""))
    decision_id = str(authority_meta.get("authority_decisionId", ""))
    ahash = action_hash(task)
    return {
        **authority_meta,
        "authority_actionHash": ahash,
        "authority_sig": sign_authority_meta(goal_id, snapshot_id, decision_id, ahash),
    }
