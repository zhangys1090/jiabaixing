"""业界框架集成层 — 按需引入 LangChain / LlamaIndex 能力，不替换自研核心。

设计原则：
1. 不改动现有 Loop 循环和 Agent 框架
2. 仅作为可观测性增强层（Callbacks）和文档解析后端（LlamaIndex）
3. 所有集成通过环境变量开关控制，默认关闭

Usage:
    # LangChain Callbacks 可观测性
    from agent.tools.framework_integration import LangChainObservability
    obs = LangChainObservability()

    # LlamaIndex 文档解析
    from agent.tools.framework_integration import LlamaIndexDocParser
    parser = LlamaIndexDocParser()
"""

from __future__ import annotations

import os
from typing import Any

from agent.core.logger import log_ignored
from agent.core.logger import StructuredLogger

log = StructuredLogger("framework_integration")



def _get_env_bool(key: str, default: bool = False) -> bool:
    return os.getenv(key, str(default).lower()).lower() in ("true", "1", "enabled", "yes")


class LangChainObservability:
    """LangChain Callbacks 可观测性集成。

    通过 LangChain 的 Callback 体系增强日志/监控/追踪能力，
    不改变现有 Agent 循环逻辑。

    环境变量：
        LC_OBSERVABILITY=enabled  启用 LangChain 可观测性
        LC_TRACING=enabled        启用 LangSmith / LangFuse 追踪
    """

    def __init__(self) -> None:
        self._enabled = _get_env_bool("LC_OBSERVABILITY")
        self._tracing = _get_env_bool("LC_TRACING")
        self._callbacks: list[Any] = []

    @property
    def enabled(self) -> bool:
        return self._enabled

    @property
    def tracing_enabled(self) -> bool:
        return self._tracing

    def setup(self) -> None:
        """初始化 LangChain 可观测性（仅在启用时）。"""
        if not self._enabled:
            log.info("LangChain 可观测性未启用")
            return

        try:
            from langchain_core.callbacks import StdOutCallbackHandler

            self._callbacks.append(StdOutCallbackHandler())

            if self._tracing:
                langsmith_api_key = os.getenv("LANGCHAIN_API_KEY", "")
                if langsmith_api_key:
                    os.environ.setdefault("LANGCHAIN_TRACING_V2", "true")
                    os.environ.setdefault("LANGCHAIN_PROJECT", "jiabaixing")
                    log.info("LangSmith 追踪已启用")
                else:
                    log.warning("LC_TRACING=enabled 但未设置 LANGCHAIN_API_KEY，跳过追踪")

            log.info("LangChain 可观测性已启用", callbacks=len(self._callbacks))
        except ImportError:
            log.warning(
                "LangChain 可观测性已启用但 langchain-core 未安装。"
                "请运行: pip install langchain-core"
            )
            self._enabled = False

    def get_callbacks(self) -> list[Any]:
        return self._callbacks

    def on_llm_start(self, model: str, prompt: str) -> None:
        """LLM 调用开始回调。"""
        if not self._enabled:
            return
        for cb in self._callbacks:
            try:
                if hasattr(cb, "on_llm_start"):
                    cb.on_llm_start({"model": model}, [prompt], invocation_params={})
            except Exception as _exc:
                log.debug("framework_integration 异常处理", error=str(_exc))
                log_ignored(log, "framework_integration.LangChainObservability.on_llm_start", _exc)

    def on_llm_end(self, model: str, output: str, duration_ms: float = 0) -> None:
        """LLM 调用结束回调。"""
        if not self._enabled:
            return
        for cb in self._callbacks:
            try:
                if hasattr(cb, "on_llm_end"):
                    from langchain_core.outputs import LLMResult

                    cb.on_llm_end(LLMResult(generations=[[{"text": output}]]))
            except Exception as _exc:
                log.debug("framework_integration 异常处理", error=str(_exc))
                log_ignored(log, "framework_integration.LangChainObservability.on_llm_end", _exc)

    def on_tool_start(self, tool_name: str, tool_input: dict) -> None:
        """工具调用开始回调。"""
        if not self._enabled:
            return
        for cb in self._callbacks:
            try:
                if hasattr(cb, "on_tool_start"):
                    cb.on_tool_start({"name": tool_name}, tool_input)
            except Exception as _exc:
                log.debug("framework_integration 异常处理", error=str(_exc))
                log_ignored(log, "framework_integration.LangChainObservability.on_tool_start", _exc)

    def on_tool_end(self, tool_name: str, output: str, duration_ms: float = 0) -> None:
        """工具调用结束回调。"""
        if not self._enabled:
            return
        for cb in self._callbacks:
            try:
                if hasattr(cb, "on_tool_end"):
                    cb.on_tool_end(output)
            except Exception as _exc:
                log.debug("framework_integration 异常处理", error=str(_exc))
                log_ignored(log, "framework_integration.LangChainObservability.on_tool_end", _exc)


class LlamaIndexDocParser:
    """LlamaIndex 文档解析集成。

    用 LlamaIndex 的文档解析能力替换自研 file_parse_tools 的后端，
    保留工具接口不变，上层调用方无感知。

    环境变量：
        LLAMAINDEX_PARSER=enabled  使用 LlamaIndex 解析 PDF/DOCX
    """

    def __init__(self) -> None:
        self._enabled = _get_env_bool("LLAMAINDEX_PARSER")

    @property
    def enabled(self) -> bool:
        return self._enabled

    async def parse_pdf(self, file_path: str) -> str:
        """使用 LlamaIndex 解析 PDF 文件。

        Args:
            file_path: PDF 文件路径。

        Returns:
            str: 解析出的文本内容。
        """
        if not self._enabled:
            return ""

        try:
            from llama_index.core import SimpleDirectoryReader

            documents = SimpleDirectoryReader(input_files=[file_path]).load_data()
            return "\n\n".join(doc.text for doc in documents)
        except ImportError:
            log.warning(
                "LlamaIndex 解析器已启用但 llama-index-core 未安装。"
                "请运行: pip install llama-index-core"
            )
            return ""
        except Exception as exc:
            log.error("LlamaIndex PDF 解析失败", file=file_path, error=str(exc))
            return ""

    async def parse_docx(self, file_path: str) -> str:
        """使用 LlamaIndex 解析 DOCX 文件。"""
        return await self.parse_pdf(file_path)

    async def parse_xlsx(self, file_path: str) -> str:
        """使用 LlamaIndex 解析 XLSX 文件。"""
        if not self._enabled:
            return ""

        try:
            from llama_index.readers.file import PandasExcelReader

            reader = PandasExcelReader()
            documents = reader.load_data(file=file_path)
            return "\n\n".join(doc.text for doc in documents)
        except ImportError:
            log.warning("LlamaIndex PandasExcelReader 不可用")
            return ""
        except Exception as exc:
            log.error("LlamaIndex XLSX 解析失败", file=file_path, error=str(exc))
            return ""


langchain_observability = LangChainObservability()
llamaindex_parser = LlamaIndexDocParser()
