import logging
import sys
from typing import Any


_LOG_FORMAT = "%(asctime)s | %(levelname)-8s | %(name)s | %(message)s"
_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

_initialized = False


def setup_logging(level: int = logging.INFO) -> None:
    global _initialized
    if _initialized:
        return
    root = logging.getLogger("agent")
    root.setLevel(level)
    if not root.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(logging.Formatter(_LOG_FORMAT, _DATE_FORMAT))
        root.addHandler(handler)
    _initialized = True


def get_logger(name: str) -> logging.Logger:
    setup_logging()
    return logging.getLogger(f"agent.{name}")


class StructuredLogger:
    def __init__(self, name: str) -> None:
        self._logger = get_logger(name)
        self._name = name

    def _format_kwargs(self, kwargs: dict[str, Any]) -> str:
        if not kwargs:
            return ""
        parts = [f"{k}={v}" for k, v in kwargs.items()]
        return " | " + " ".join(parts)

    def debug(self, msg: str, **kwargs: Any) -> None:
        self._logger.debug(msg + self._format_kwargs(kwargs))

    def info(self, msg: str, **kwargs: Any) -> None:
        self._logger.info(msg + self._format_kwargs(kwargs))

    def warning(self, msg: str, **kwargs: Any) -> None:
        self._logger.warning(msg + self._format_kwargs(kwargs))

    def error(self, msg: str, **kwargs: Any) -> None:
        self._logger.error(msg + self._format_kwargs(kwargs))

    def critical(self, msg: str, **kwargs: Any) -> None:
        self._logger.critical(msg + self._format_kwargs(kwargs))
