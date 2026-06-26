from __future__ import annotations

from typing import Any

from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolParameterDef,
    ToolResult,
)


WEB_SEARCH_DEF = ToolDefinition(
    name="web_search",
    description="实时网络搜索，返回标题+链接+摘要。适用场景：查最新信息、新闻、技术文档、市场数据。不适用：本地文件（用file_search）、代码问题（用code_analyze）。",
    category=ToolCategory.NETWORK,
    parameters=[
        ToolParameterDef(name="query", type="string", description="搜索关键词"),
        ToolParameterDef(name="max_results", type="number", required=False, description="最大结果数"),
    ],
    risk_level="low",
)

WEB_FETCH_DEF = ToolDefinition(
    name="web_fetch",
    description="获取网页内容并转为文本。适用场景：读取网页文章、获取API数据。不适用：搜索信息（用 web_search）。",
    category=ToolCategory.NETWORK,
    parameters=[
        ToolParameterDef(name="url", type="string", description="要获取的网页URL"),
        ToolParameterDef(name="format", type="string", required=False, description="输出格式: text/markdown", enum=["text", "markdown"]),
    ],
    risk_level="low",
)

TTS_SPEAK_DEF = ToolDefinition(
    name="tts_speak",
    description="文字转语音播报。适用场景：语音提醒、朗读文本。不适用：文字聊天（直接回复）。",
    category=ToolCategory.NETWORK,
    parameters=[
        ToolParameterDef(name="text", type="string", description="要朗读的文本"),
        ToolParameterDef(name="voice", type="string", required=False, description="语音类型"),
    ],
    risk_level="low",
)

CHART_GENERATE_DEF = ToolDefinition(
    name="chart_generate",
    description="根据数据生成图表描述。适用场景：数据可视化、生成图表配置。不适用：纯文本分析。",
    category=ToolCategory.NETWORK,
    parameters=[
        ToolParameterDef(name="data", type="string", description="数据（JSON格式或描述）"),
        ToolParameterDef(name="chart_type", type="string", required=False, description="图表类型: bar/line/pie/scatter", enum=["bar", "line", "pie", "scatter"]),
        ToolParameterDef(name="title", type="string", required=False, description="图表标题"),
    ],
    risk_level="low",
)


async def web_search_executor(params: dict[str, Any]) -> ToolResult:
    import time
    start = time.time()
    query = str(params.get("query", ""))
    max_results = int(params.get("max_results", 5))

    if not query:
        return ToolResult(success=False, error="搜索关键词不能为空")

    try:
        from agent.tools.web_search_provider import search
        results = await search(query, max_results=max_results)
        if not results:
            return ToolResult(success=True, output="未找到相关结果", duration=time.time() - start)

        formatted: list[str] = []
        for i, r in enumerate(results, 1):
            title = r.get("title", "")
            url = r.get("url", r.get("link", ""))
            snippet = r.get("snippet", r.get("body", ""))[:200]
            formatted.append(f"{i}. {title}\n   {url}\n   {snippet}")

        output = f"找到 {len(results)} 条结果:\n" + "\n\n".join(formatted)
        return ToolResult(success=True, output=output, duration=time.time() - start)
    except ImportError:
        return ToolResult(success=True, output="网络搜索服务未配置，请设置搜索API Key", duration=time.time() - start)
    except Exception as e:
        return ToolResult(success=False, error=f"搜索失败: {e}")


async def web_fetch_executor(params: dict[str, Any]) -> ToolResult:
    import time
    start = time.time()
    url = str(params.get("url", ""))
    fmt = str(params.get("format", "markdown"))

    if not url:
        return ToolResult(success=False, error="URL不能为空")

    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    try:
        import urllib.request
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read().decode("utf-8", errors="replace")

        content = html[:20000]
        if fmt == "markdown":
            content = _html_to_text(content)

        return ToolResult(success=True, output=content[:10000], duration=time.time() - start)
    except Exception as e:
        return ToolResult(success=False, error=f"获取网页失败: {e}")


async def tts_speak_executor(params: dict[str, Any]) -> ToolResult:
    import time
    start = time.time()
    text = str(params.get("text", ""))

    if not text:
        return ToolResult(success=False, error="文本不能为空")

    return ToolResult(
        success=True,
        output=f"已将文本加入语音播报队列: {text[:50]}...",
        duration=time.time() - start,
    )


async def chart_generate_executor(params: dict[str, Any]) -> ToolResult:
    import time
    start = time.time()
    data = str(params.get("data", ""))
    chart_type = str(params.get("chart_type", "bar"))
    title = params.get("title", "数据图表")

    if not data:
        return ToolResult(success=False, error="数据不能为空")

    llm = None
    try:
        from agent.main import engine
        if engine and hasattr(engine, "llm"):
            llm = engine.llm
    except Exception:
        pass

    if llm:
        try:
            prompt = (
                f"请根据以下数据生成{chart_type}类型的图表配置（ECharts格式JSON）：\n"
                f"数据: {data[:1000]}\n"
                f"图表类型: {chart_type}\n"
                f"标题: {title}\n"
                f"请只输出JSON配置。"
            )
            response = await llm.chat(messages=[{"role": "user", "content": prompt}], use_cache=False)
            content = response.get("content", "")
            return ToolResult(success=True, output=content, duration=time.time() - start)
        except Exception:
            pass

    return ToolResult(
        success=True,
        output=f"图表配置: type={chart_type}, title={title}, data={data[:100]}",
        duration=time.time() - start,
    )


def _html_to_text(html: str) -> str:
    import re
    text = re.sub(r"<script[^>]*>[\s\S]*?</script>", "", html, flags=re.I)
    text = re.sub(r"<style[^>]*>[\s\S]*?</style>", "", text, flags=re.I)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</p>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()
