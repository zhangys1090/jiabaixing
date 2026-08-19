"""统一 subprocess 封装（P-P4）。

项目内存在大量裸 ``subprocess.run`` / ``subprocess.Popen`` 调用且未设超时，
一旦子进程挂死会阻塞调用方（含桌面自动化、剪贴板、代码工具等热路径）。
本模块提供带**默认超时**的 ``run`` 封装，作为统一超时策略入口：

- 默认 ``timeout=30s``，避免进程挂死；调用方可按需覆盖（``timeout=None`` 表示不限）。
- 透传 ``subprocess.run`` 全部参数（``input`` / ``capture_output`` / ``text`` 等）。
- 超时抛 ``subprocess.TimeoutExpired`` 由调用方决定降级，**不静默吞**。
- 仅做超时兜底，不引入额外静默 except（静默吞异常红线已锁新增为 0）。
"""

from __future__ import annotations

import logging
import subprocess
from typing import Any, Sequence

from agent.core.logger import log_ignored

log = logging.getLogger(__name__)

#: 默认子进程超时（秒）。设为 None 表示不限制（仅限确有长耗时需求的调用方显式传入）。
DEFAULT_TIMEOUT: float | None = 30.0


def run(
    args: Sequence[str],
    *,
    timeout: float | None = DEFAULT_TIMEOUT,
    **kwargs: Any,
) -> subprocess.CompletedProcess:
    """``subprocess.run`` 的安全封装：默认带超时，防止子进程挂死阻塞调用方。

    Args:
        args: 命令及参数（同 ``subprocess.run`` 的第一个位置参数）。
        timeout: 超时秒数；默认 :data:`DEFAULT_TIMEOUT`，传 ``None`` 关闭超时。
        **kwargs: 透传给 ``subprocess.run``（``input`` / ``capture_output`` / ``text`` 等）。

    Returns:
        ``subprocess.CompletedProcess``。

    Raises:
        subprocess.TimeoutExpired: 子进程超时时按原样抛出，由调用方处理降级。
    """
    try:
        return subprocess.run(args, timeout=timeout, **kwargs)
    except subprocess.TimeoutExpired:
        # 超时属于「可被调用方感知并处理」的异常，不在此吞掉；仅记录便于排查。
        log.warning("subprocess_util.run timed out", cmd=" ".join(args), timeout=timeout)
        raise
    except Exception as _exc:  # noqa: BLE001
        # 非超时异常（如 FileNotFoundError）同样透传；仅在完全无法继续时记录。
        log_ignored(log, "subprocess_util.run", _exc)
        raise
