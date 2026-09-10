"""D4-I2 Post-Audit: authorityMeta HMAC 签名测试。

覆盖：
- 签名确定性（同输入同签名）
- 不同 actionHash/goalId 产生不同签名
- signed_authority_payload 携带 authority_sig + authority_actionHash
- 生产密钥检测
"""
import pytest

from agent.core.authority_signature import (
    action_hash,
    is_production_secret,
    sign_authority_meta,
    signed_authority_payload,
)


GOAL = "G_test123"
SNAP = "SS_test456"
DECISION = "D_test789"
TASK = "打开记事本并输入Hello World"


def test_action_hash_deterministic():
    assert action_hash(TASK) == action_hash(TASK)
    assert action_hash(TASK) != action_hash(TASK + "x")


def test_sign_deterministic_and_binds_all_fields():
    ahash = action_hash(TASK)
    sig1 = sign_authority_meta(GOAL, SNAP, DECISION, ahash)
    sig2 = sign_authority_meta(GOAL, SNAP, DECISION, ahash)
    assert sig1 == sig2
    # 任一字段变化 → 签名变化
    assert sig1 != sign_authority_meta("G_other", SNAP, DECISION, ahash)
    assert sig1 != sign_authority_meta(GOAL, "SS_other", DECISION, ahash)
    assert sig1 != sign_authority_meta(GOAL, SNAP, "D_other", ahash)
    assert sig1 != sign_authority_meta(GOAL, SNAP, DECISION, "0" * 64)


def test_signed_payload_carries_sig_and_hash():
    meta = {
        "authority_goalId": GOAL,
        "authority_snapshotId": SNAP,
        "authority_decisionId": DECISION,
    }
    payload = signed_authority_payload(meta, TASK)
    assert payload["authority_actionHash"] == action_hash(TASK)
    assert payload["authority_sig"] == sign_authority_meta(
        GOAL, SNAP, DECISION, action_hash(TASK)
    )
    # 原字段保留
    assert payload["authority_goalId"] == GOAL
    assert payload["authority_snapshotId"] == SNAP
    assert payload["authority_decisionId"] == DECISION


def test_production_secret_flag():
    # 未设置环境变量时为开发模式
    import os
    old = os.environ.pop("AGENT_AUTHORITY_HMAC_SECRET", None)
    try:
        assert is_production_secret() is False
        os.environ["AGENT_AUTHORITY_HMAC_SECRET"] = "s3cret"
        assert is_production_secret() is True
    finally:
        if old is not None:
            os.environ["AGENT_AUTHORITY_HMAC_SECRET"] = old
        else:
            os.environ.pop("AGENT_AUTHORITY_HMAC_SECRET", None)
