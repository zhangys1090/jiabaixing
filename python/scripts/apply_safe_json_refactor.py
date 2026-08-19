"""机械式、确定性地把未受保护的 DB 列 json.loads 替换为 safe_json_loads。

仅替换下方精确枚举的字符串；不触碰其它代码。运行后由 py_compile + 导入扫描 + 单测验证。
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # python/

IMPORT_LINE = "from agent.infrastructure.safe_json import safe_json_loads\n"

# (相对路径, [(旧串, 新串), ...])
PATCHES = {
    "agent/safety/audit_trail.py": [
        ('params=json.loads(row[3]),', 'params=safe_json_loads(row[3], {}, context="safety.audit_trail.params"),'),
    ],
    "agent/safety/checkpoint_manager.py": [
        ('metadata=json.loads(row[6]),', 'metadata=safe_json_loads(row[6], {}, context="safety.checkpoint_manager.metadata"),'),
    ],
    "agent/persistence/session_lineage.py": [
        ('tags: list[str] = json.loads(row[0])', 'tags: list[str] = safe_json_loads(row[0], [], context="session_lineage.tags")'),
        ('tags=json.loads(row[4]),', 'tags=safe_json_loads(row[4], [], context="session_lineage.tags4"),'),
    ],
    "agent/knowledge/knowledge_store.py": [
        ('tags=json.loads(row["tags"]),', 'tags=safe_json_loads(row["tags"], [], context="knowledge.tags"),'),
        ('metadata=json.loads(row["metadata"]),', 'metadata=safe_json_loads(row["metadata"], {}, context="knowledge.metadata"),'),
    ],
    "agent/evolution/learning_graph.py": [
        ('metadata=json.loads(row[3]),', 'metadata=safe_json_loads(row[3], {}, context="learning_graph.node_metadata"),'),
        ('metadata=json.loads(row[4]),', 'metadata=safe_json_loads(row[4], {}, context="learning_graph.edge_metadata"),'),
    ],
    "agent/memory/episodic_memory.py": [
        ('tags=json.loads(row[9]),', 'tags=safe_json_loads(row[9], [], context="episodic.tags"),'),
        ('metadata=json.loads(row[10]),', 'metadata=safe_json_loads(row[10], {}, context="episodic.metadata"),'),
    ],
}


def ensure_import(content: str) -> str:
    if "safe_json_loads" in content:
        return content
    # 优先插在 log_ignored 导入之后，否则插在 import json 之后
    if "from agent.core.logger import log_ignored" in content:
        return content.replace(
            "from agent.core.logger import log_ignored\n",
            "from agent.core.logger import log_ignored\n" + IMPORT_LINE,
            1,
        )
    return content.replace("import json\n", "import json\n" + IMPORT_LINE, 1)


def main() -> None:
    total_changes = 0
    for rel, subs in PATCHES.items():
        p = ROOT / rel
        content = p.read_text(encoding="utf-8")
        before = content
        for old, new in subs:
            if old not in content:
                raise SystemExit(f"[FAIL] 未找到精确串 in {rel}: {old!r}")
            if content.count(old) != 1:
                # 防御：避免误替换
                raise SystemExit(f"[FAIL] 串出现多次 in {rel}: {old!r}")
            content = content.replace(old, new, 1)
            total_changes += 1
        content = ensure_import(content)
        if content != before:
            p.write_text(content, encoding="utf-8")
        print(f"[OK] {rel}: +{len(subs)} 处替换")
    print(f"总替换 {total_changes} 处")


if __name__ == "__main__":
    main()
