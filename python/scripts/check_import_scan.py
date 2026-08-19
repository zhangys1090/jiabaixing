"""全包导入扫描红线 — 防止 critical=False 子系统静默吞掉缺陷。

背景
----
本项目中部分网关子系统（PlatformManager / RelayAdapter / MessageDispatcher）
在引擎初始化时被 lazy 构建，且标记 ``critical=False``：
一旦构造失败，引擎不抛启动错误，子系统静默失效，CI 与启动均不报警。

这类缺陷分两类，本脚本同时覆盖：
  1. 导入期硬伤：SyntaxError / IndentationError / NameError / AttributeError /
     非「No module」的 ImportError / 本地 agent 包缺失。
  2. 实例化期硬伤：对「引擎启动必构造」的子系统做无参实例化，
     捕获如 ``MessageDispatcher`` 缺失 ``_mirror_send`` 这类 AttributeError。

判定规则
--------
- 代码缺陷（exit 1，阻断 CI）：上述导入期异常；实例化期任意异常。
- 环境缺失（仅告警，不阻断）：第三方包 ``No module named 'xxx'``
  （部署时 ``pip install -e ".[test]"`` 会补齐，本地缺可选依赖不算代码缺陷）。
- 本地包缺失（``No module named 'agent...'``）算代码缺陷。

用法
----
    python scripts/check_import_scan.py
    PYTHONPATH=<python 根目录> python scripts/check_import_scan.py

退出码：0 = 通过；1 = 发现代码缺陷。
"""

from __future__ import annotations

import importlib
import os
import pkgutil
import sys
import traceback


def _bootstrap_path() -> None:
    """让脚本在 ``python/scripts/`` 下也能 import 到 agent 包。"""
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    if root not in sys.path:
        sys.path.insert(0, root)


def _is_code_defect(exc: BaseException) -> bool:
    """区分代码缺陷与环境缺失。"""
    t = type(exc).__name__
    msg = str(exc)
    # 模块级 sys.exit()：生产包里不允许，且会中断扫描本身（SystemExit 继承
    # BaseException，普通 except Exception 接不住），必须判为代码缺陷。
    if isinstance(exc, SystemExit):
        return True
    if t in ("SyntaxError", "IndentationError", "NameError", "AttributeError"):
        return True
    if t in ("ImportError", "ModuleNotFoundError"):
        if "No module named" in msg:
            # msg 形如: No module named 'foo'
            mod = msg.split("'")[1] if "'" in msg else msg
            if mod.startswith("agent") or mod.startswith("python.agent"):
                return True  # 本地包缺失 = 代码缺陷
            return False  # 第三方缺失 = 环境（部署时补齐）
        return True  # 例如 cannot import name 'x' from 'agent.y'
    return False


# 引擎启动必构造、且可无参安全实例化的关键子系统（实例化即崩=生产崩）。
CRITICAL_INSTANCES: list[tuple[str, str]] = [
    ("agent.gateway.dispatcher", "MessageDispatcher"),
    ("agent.gateway.platform_manager", "PlatformManager"),
    ("agent.gateway.platforms.relay_adapter", "RelayAdapter"),
]


def main() -> int:
    _bootstrap_path()
    try:
        import agent  # noqa: F401
    except Exception as e:  # noqa: BLE001
        print(f"[FAIL] 无法导入 agent 根包: {type(e).__name__}: {e}")
        traceback.print_exc()
        return 1

    modules = [m.name for m in pkgutil.walk_packages(agent.__path__, "agent.")]
    ok = 0
    defects: list[tuple[str, str]] = []
    env_only: list[tuple[str, str]] = []

    for name in modules:
        try:
            importlib.import_module(name)
            ok += 1
        except KeyboardInterrupt:
            raise
        # 必须捕获 BaseException：模块级 sys.exit() 抛 SystemExit，
        # 若只 except Exception 会让扫描自身静默中断并误报 exit 0（真实事故，
        # 见 agent/core/_check_syntax.py 遗留调试脚本）。
        except BaseException as e:  # noqa: BLE001
            if _is_code_defect(e):
                defects.append((name, f"{type(e).__name__}: {str(e)[:160]}"))
            else:
                env_only.append((name, f"{type(e).__name__}: {str(e)[:120]}"))

    # 实例化期红线：引擎启动必构造的子系统
    instance_defects: list[tuple[str, str]] = []
    for mod_name, cls_name in CRITICAL_INSTANCES:
        try:
            mod = importlib.import_module(mod_name)
            cls = getattr(mod, cls_name)
            cls()  # 无参安全构造
        except KeyboardInterrupt:
            raise
        except BaseException as e:  # noqa: BLE001
            instance_defects.append(
                (f"{mod_name}.{cls_name}", f"{type(e).__name__}: {str(e)[:160]}")
            )

    # 报告
    print(f"[OK] 导入通过模块: {ok}/{len(modules)}")
    if env_only:
        print(f"[SKIP] 环境缺失(非代码缺陷, 部署时补齐): {len(env_only)}")
        for n, d in env_only:
            print(f"    - {n}: {d}")
    if defects:
        print(f"[FAIL] 代码缺陷(导入期): {len(defects)}")
        for n, d in defects:
            print(f"    - {n}: {d}")
    if instance_defects:
        print(f"[FAIL] 代码缺陷(实例化期): {len(instance_defects)}")
        for n, d in instance_defects:
            print(f"    - {n}: {d}")

    total = len(defects) + len(instance_defects)
    if total == 0:
        print("[PASS] 全包导入扫描 + 关键子系统实例化均无代码缺陷")
        return 0
    print(f"[BLOCK] 发现 {total} 处代码缺陷, 阻断 CI (exit 1)")
    return 1


if __name__ == "__main__":
    sys.exit(main())
