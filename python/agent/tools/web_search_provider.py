"""多后端 Web 搜索提供者模块。

提供统一抽象层，支持 SearXNG / Tavily / DuckDuckGo 三个搜索后端，
WebSearchRegistry 按优先级自动选择可用后端。
"""

from __future__ import annotations

import os
import time
from abc import ABC, abstractmethod
from typing import Any

import httpx

from agent.core.logger import StructuredLogger
log = StructuredLogger("web_search_provider")

_log = StructuredLogger("tools.web_search")


# ---------------------------------------------------------------------------
# 数据类型
# ---------------------------------------------------------------------------

SearchResult = dict[str, str]
"""单条搜索结果，至少包含 title / url / snippet 三个键。"""


# ---------------------------------------------------------------------------
# 抽象基类
# ---------------------------------------------------------------------------

class WebSearchProvider(ABC):
    """Web 搜索提供者抽象基类。

    所有搜索后端必须实现 search 与 is_available 两个方法。
    """

    @abstractmethod
    async def search(
        self, query: str, *, max_results: int = 5
    ) -> list[SearchResult]:
        """执行搜索并返回结果列表。

        Args:
            query: 搜索关键词。
            max_results: 最大返回结果数，默认 5。

        Returns:
            搜索结果列表，每条包含 title / url / snippet。
        """

    @abstractmethod
    async def is_available(self) -> bool:
        """检测当前后端是否可用。

        Returns:
            True 表示后端可正常使用。
        """


# ---------------------------------------------------------------------------
# SearXNG Provider
# ---------------------------------------------------------------------------

class SearXNGProvider(WebSearchProvider):
    """SearXNG 自托管搜索引擎提供者。

    通过 SearXNG 的 JSON API 执行搜索，默认连接 http://localhost:8080。
    需要用户自行部署 SearXNG 实例。

    Args:
        base_url: SearXNG 实例地址，默认 http://localhost:8080。
        timeout: 请求超时秒数，默认 10。
    """

    def __init__(
        self, base_url: str = "http://localhost:8080", timeout: float = 10.0
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout

    async def is_available(self) -> bool:
        """检测 SearXNG 实例是否可达。"""
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.get(f"{self._base_url}/healthz")
                return resp.status_code == 200
        except Exception as exc:
            _log.debug("SearXNG 不可达", base_url=self._base_url, error=str(exc))
            return False

    async def search(
        self, query: str, *, max_results: int = 5
    ) -> list[SearchResult]:
        """通过 SearXNG JSON API 搜索。

        Args:
            query: 搜索关键词。
            max_results: 最大返回结果数。

        Returns:
            搜索结果列表。

        Raises:
            RuntimeError: 请求失败时抛出。
        """
        params: dict[str, Any] = {
            "q": query,
            "format": "json",
            "pageno": 1,
        }
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.get(f"{self._base_url}/search", params=params)
                resp.raise_for_status()
                data = resp.json()
        except httpx.TimeoutException as exc:
            raise RuntimeError(f"SearXNG 请求超时: {exc}") from exc
        except httpx.HTTPStatusError as exc:
            raise RuntimeError(f"SearXNG 返回 HTTP {exc.response.status_code}") from exc
        except Exception as exc:
            raise RuntimeError(f"SearXNG 请求失败: {exc}") from exc

        results: list[SearchResult] = []
        for item in data.get("results", [])[:max_results]:
            results.append(
                {
                    "title": item.get("title", ""),
                    "url": item.get("url", ""),
                    "snippet": item.get("content", ""),
                }
            )
        return results


# ---------------------------------------------------------------------------
# Tavily Provider
# ---------------------------------------------------------------------------

class TavilyProvider(WebSearchProvider):
    """Tavily API 搜索提供者。

    使用 Tavily 搜索 API，需要设置 TAVILY_API_KEY 环境变量。

    Args:
        api_key: Tavily API Key，默认从 TAVILY_API_KEY 环境变量读取。
        timeout: 请求超时秒数，默认 10。
    """

    _API_URL = "https://api.tavily.com/search"

    def __init__(
        self, api_key: str | None = None, timeout: float = 10.0
    ) -> None:
        self._api_key = api_key or os.environ.get("TAVILY_API_KEY", "")
        self._timeout = timeout

    async def is_available(self) -> bool:
        """检测 Tavily API Key 是否已配置。"""
        return bool(self._api_key)

    async def search(
        self, query: str, *, max_results: int = 5
    ) -> list[SearchResult]:
        """通过 Tavily API 搜索。

        Args:
            query: 搜索关键词。
            max_results: 最大返回结果数。

        Returns:
            搜索结果列表。

        Raises:
            RuntimeError: API Key 缺失或请求失败时抛出。
        """
        if not self._api_key:
            raise RuntimeError("Tavily API Key 未配置，请设置 TAVILY_API_KEY 环境变量")

        payload: dict[str, Any] = {
            "api_key": self._api_key,
            "query": query,
            "max_results": max_results,
            "search_depth": "basic",
        }
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.post(self._API_URL, json=payload)
                resp.raise_for_status()
                data = resp.json()
        except httpx.TimeoutException as exc:
            raise RuntimeError(f"Tavily 请求超时: {exc}") from exc
        except httpx.HTTPStatusError as exc:
            raise RuntimeError(f"Tavily 返回 HTTP {exc.response.status_code}") from exc
        except Exception as exc:
            raise RuntimeError(f"Tavily 请求失败: {exc}") from exc

        results: list[SearchResult] = []
        for item in data.get("results", [])[:max_results]:
            results.append(
                {
                    "title": item.get("title", ""),
                    "url": item.get("url", ""),
                    "snippet": item.get("content", ""),
                }
            )
        return results


# ---------------------------------------------------------------------------
# DuckDuckGo Provider
# ---------------------------------------------------------------------------

class DuckDuckGoProvider(WebSearchProvider):
    """DuckDuckGo 搜索提供者（免费，无需 API Key）。

    通过 DuckDuckGo HTML 搜索页面抓取结果，使用 httpx 异步请求。
    无需任何密钥配置，但结果解析依赖页面结构，稳定性较低。

    Args:
        timeout: 请求超时秒数，默认 10。
    """

    _HTML_URL = "https://html.duckduckgo.com/html/"

    def __init__(self, timeout: float = 10.0) -> None:
        self._timeout = timeout

    async def is_available(self) -> bool:
        """DuckDuckGo 免费无密钥，始终可用。"""
        return True

    async def search(
        self, query: str, *, max_results: int = 5
    ) -> list[SearchResult]:
        """通过 DuckDuckGo HTML 搜索。

        Args:
            query: 搜索关键词。
            max_results: 最大返回结果数。

        Returns:
            搜索结果列表。

        Raises:
            RuntimeError: 请求失败时抛出。
        """
        try:
            async with httpx.AsyncClient(
                timeout=self._timeout,
                headers={
                    "User-Agent": (
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/125.0.0.0 Safari/537.36"
                    )
                },
                follow_redirects=True,
            ) as client:
                resp = await client.post(
                    self._HTML_URL,
                    data={"q": query, "b": ""},
                )
                resp.raise_for_status()
                html = resp.text
        except httpx.TimeoutException as exc:
            raise RuntimeError(f"DuckDuckGo 请求超时: {exc}") from exc
        except httpx.HTTPStatusError as exc:
            raise RuntimeError(f"DuckDuckGo 返回 HTTP {exc.response.status_code}") from exc
        except Exception as exc:
            raise RuntimeError(f"DuckDuckGo 请求失败: {exc}") from exc

        return self._parse_html(html, max_results)

    @staticmethod
    def _parse_html(html: str, max_results: int) -> list[SearchResult]:
        """解析 DuckDuckGo HTML 搜索结果页。

        Args:
            html: 搜索结果 HTML 文本。
            max_results: 最大返回结果数。

        Returns:
            搜索结果列表。
        """
        import re

        results: list[SearchResult] = []
        # 匹配 DuckDuckGo HTML 结果块
        blocks = re.findall(
            r'<a rel="nofollow".*?class="result__a".*?href="(?P<url>[^"]+)"'
            r'.*?>(?P<title>.*?)</a>'
            r'.*?<a class="result__snippet".*?>(?P<snippet>.*?)</a>',
            html,
            re.DOTALL,
        )
        for url, title, snippet in blocks[:max_results]:
            clean_title = re.sub(r"<[^>]+>", "", title).strip()
            clean_snippet = re.sub(r"<[^>]+>", "", snippet).strip()
            results.append(
                {
                    "title": clean_title,
                    "url": url,
                    "snippet": clean_snippet,
                }
            )
        return results


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

class WebSearchRegistry:
    """Web 搜索提供者注册中心。

    管理多个 WebSearchProvider 实例，按优先级自动选择可用后端执行搜索。

    默认优先级（从高到低）：
        1. SearXNG   — 自托管，隐私优先
        2. Tavily    — 付费 API，质量稳定
        3. DuckDuckGo — 免费无需密钥，兜底方案

    Usage:
        registry = WebSearchRegistry()
        results = await registry.search("Python 异步编程")
    """

    _CACHE_TTL = 300.0

    def __init__(self, providers: list[WebSearchProvider] | None = None) -> None:
        self._providers: list[WebSearchProvider] = providers or [
            SearXNGProvider(),
            TavilyProvider(),
            DuckDuckGoProvider(),
        ]
        self._available_cache: dict[str, tuple[bool, float]] = {}

    async def _pick_provider(self) -> WebSearchProvider | None:
        """按优先级选择第一个可用的 provider。

        Returns:
            可用的 WebSearchProvider 实例，均不可用时返回 None。
        """
        now = time.monotonic()
        for provider in self._providers:
            name = type(provider).__name__
            cached = self._available_cache.get(name)
            if cached is not None:
                available, cached_time = cached
                if now - cached_time > self._CACHE_TTL:
                    del self._available_cache[name]
                    cached = None
            if cached is None:
                try:
                    available = await provider.is_available()
                    self._available_cache[name] = (available, now)
                except Exception as exc:
                    _log.warning("Provider 可用性检测失败", provider=name, error=str(exc))
                    self._available_cache[name] = (False, now)
                    available = False
            else:
                available = cached[0]
            if available:
                return provider
        return None

    def reset_cache(self) -> None:
        """重置可用性缓存，下次搜索时重新检测。"""
        self._available_cache.clear()

    async def search(
        self, query: str, *, max_results: int = 5
    ) -> list[SearchResult]:
        """自动选择可用后端执行搜索。

        按优先级依次检测 provider 可用性，使用第一个可用后端。
        所有后端均不可用时返回空列表。

        Args:
            query: 搜索关键词。
            max_results: 最大返回结果数，默认 5。

        Returns:
            搜索结果列表；所有后端不可用时返回空列表。
        """
        last_error: Exception | None = None
        for _ in range(len(self._providers)):
            provider = await self._pick_provider()
            if provider is None:
                break
            try:
                return await provider.search(query, max_results=max_results)
            except Exception as exc:
                log.debug("web_search_provider 异常处理", error=str(exc))
                last_error = exc
                name = type(provider).__name__
                _log.warning("Provider 搜索失败，尝试下一个", provider=name, error=str(exc))
                self._available_cache[name] = (False, time.monotonic())
        if last_error is not None:
            _log.warning("所有搜索后端均失败", error=str(last_error))
        return []

    @property
    def providers(self) -> list[WebSearchProvider]:
        """已注册的 provider 列表（按优先级排列）。"""
        return list(self._providers)


# ---------------------------------------------------------------------------
# 模块级便捷函数
# ---------------------------------------------------------------------------

_default_registry: WebSearchRegistry | None = None


def _get_registry() -> WebSearchRegistry:
    """获取或创建默认 WebSearchRegistry 单例。"""
    global _default_registry
    if _default_registry is None:
        _default_registry = WebSearchRegistry()
    return _default_registry


async def search(query: str, *, max_results: int = 5) -> list[SearchResult]:
    """便捷搜索函数，使用默认 Registry 自动选择后端。

    Args:
        query: 搜索关键词。
        max_results: 最大返回结果数，默认 5。

    Returns:
        搜索结果列表。
    """
    return await _get_registry().search(query, max_results=max_results)
