"""测试四个新功能模块: tool_search, TitleGenerator, SessionRecap, ErrorClassifier。"""

from __future__ import annotations

import importlib
import sys

import pytest

# 直接导入模块，避免通过 persistence/__init__.py 链触发 redis 依赖问题
from agent.tools.registry import ToolCategory, ToolDefinition, ToolRegistry
from agent.tools.tool_search import ToolSearchIndex, _tokenize
from agent.core.error_classifier import (
    ClassifiedError,
    ErrorCategory,
    ErrorClassifier,
)

# 绕过 agent.persistence.__init__.py 的链式导入（redis 版本问题）
# 直接加载子模块文件
import importlib.util


def _import_module_directly(module_name: str, file_path: str):
    """直接从文件路径加载模块，避免触发包的 __init__.py。"""
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


_tg = _import_module_directly(
    "agent.persistence.title_generator",
    r"c:\zy\jiabaixing\python\agent\persistence\title_generator.py",
)
TitleGenerator = _tg.TitleGenerator

_sr = _import_module_directly(
    "agent.persistence.session_recap",
    r"c:\zy\jiabaixing\python\agent\persistence\session_recap.py",
)
SessionRecap = _sr.SessionRecap


# ==================== ToolSearchIndex 测试 ====================


class TestTokenize:
    """测试分词函数。"""

    def test_empty_string(self) -> None:
        assert _tokenize("") == []

    def test_english_tokens(self) -> None:
        tokens = _tokenize("hello world")
        assert "hello" in tokens
        assert "world" in tokens

    def test_mixed_tokens(self) -> None:
        tokens = _tokenize("file_read 读取文件")
        # jieba 会将 file_read 拆分为 file, _, read
        # 检查关键 token 是否存在
        assert "file" in tokens or "file_read" in tokens
        assert len(tokens) > 0


class TestToolSearchIndex:
    """测试工具搜索索引。"""

    @pytest.fixture()
    def registry(self) -> ToolRegistry:
        """创建包含测试工具的注册中心。"""
        reg = ToolRegistry()
        reg.register(
            ToolDefinition(
                name="file_read",
                description="读取文件内容",
                short_desc="读取文件",
                category=ToolCategory.FILE,
                tags=["file", "read", "文件", "读取"],
                scenes=["coding"],
            ),
            lambda params: None,
        )
        reg.register(
            ToolDefinition(
                name="code_generate",
                description="生成代码片段",
                short_desc="生成代码",
                category=ToolCategory.CODE,
                tags=["code", "generate", "代码", "生成"],
                scenes=["coding"],
            ),
            lambda params: None,
        )
        reg.register(
            ToolDefinition(
                name="web_search",
                description="搜索网络信息",
                short_desc="搜索网页",
                category=ToolCategory.NETWORK,
                tags=["web", "search", "搜索", "网络"],
                scenes=["research"],
            ),
            lambda params: None,
        )
        reg.register(
            ToolDefinition(
                name="memory_recall",
                description="回忆存储的记忆",
                short_desc="回忆记忆",
                category=ToolCategory.MEMORY,
                tags=["memory", "recall", "记忆", "回忆"],
                scenes=["daily"],
            ),
            lambda params: None,
        )
        return reg

    @pytest.fixture()
    def index(self, registry: ToolRegistry) -> ToolSearchIndex:
        """创建已索引的搜索实例。"""
        idx = ToolSearchIndex()
        idx.index_tools(registry)
        return idx

    def test_index_tools_returns_count(self, registry: ToolRegistry) -> None:
        idx = ToolSearchIndex()
        count = idx.index_tools(registry)
        assert count == 4

    def test_search_returns_results(self, index: ToolSearchIndex) -> None:
        results = index.search("读取文件", limit=3)
        assert len(results) > 0
        assert results[0]["name"] == "file_read"

    def test_search_limit(self, index: ToolSearchIndex) -> None:
        results = index.search("文件", limit=2)
        assert len(results) <= 2

    def test_search_empty_query(self, index: ToolSearchIndex) -> None:
        results = index.search("", limit=5)
        assert results == []

    def test_search_no_match(self, index: ToolSearchIndex) -> None:
        results = index.search("zzzznonexistent", limit=5)
        # 可能返回空列表或低分结果
        assert isinstance(results, list)

    def test_get_by_category(self, index: ToolSearchIndex) -> None:
        results = index.get_by_category("file")
        assert len(results) == 1
        assert results[0]["name"] == "file_read"

    def test_get_by_category_empty(self, index: ToolSearchIndex) -> None:
        results = index.get_by_category("nonexistent")
        assert results == []

    def test_list_categories(self, index: ToolSearchIndex) -> None:
        categories = index.list_categories()
        assert "file" in categories
        assert "code" in categories
        assert "network" in categories
        assert "memory" in categories

    def test_get_tool_details(self, index: ToolSearchIndex) -> None:
        details = index.get_tool_details("file_read")
        assert details is not None
        assert details["name"] == "file_read"
        assert details["category"] == "file"
        assert "file" in details["tags"]

    def test_get_tool_details_not_found(self, index: ToolSearchIndex) -> None:
        details = index.get_tool_details("nonexistent_tool")
        assert details is None

    def test_get_recommended(self, index: ToolSearchIndex) -> None:
        results = index.get_recommended("搜索网络信息", limit=3)
        assert len(results) > 0
        assert len(results) <= 3
        # 推荐结果应有 reason 字段
        assert "reason" in results[0]

    def test_get_recommended_empty(self, index: ToolSearchIndex) -> None:
        results = index.get_recommended("", limit=3)
        assert results == []

    def test_reindex_clears_previous(self, registry: ToolRegistry) -> None:
        idx = ToolSearchIndex()
        idx.index_tools(registry)
        # 新建空注册中心重新索引
        empty_registry = ToolRegistry()
        count = idx.index_tools(empty_registry)
        assert count == 0
        assert idx.search("文件") == []

    def test_search_result_format(self, index: ToolSearchIndex) -> None:
        results = index.search("读取", limit=1)
        if results:
            result = results[0]
            assert "name" in result
            assert "description" in result
            assert "short_desc" in result
            assert "category" in result
            assert "tags" in result
            assert "score" in result


# ==================== TitleGenerator 测试 ====================


class TestTitleGenerator:
    """测试基于本地规则的标题生成器。"""

    @pytest.fixture()
    def generator(self) -> TitleGenerator:
        return TitleGenerator()

    @pytest.mark.anyio
    async def test_short_message_directly(self, generator: TitleGenerator) -> None:
        title = await generator.generate("你好")
        assert title == "你好"

    @pytest.mark.anyio
    async def test_short_message_with_punctuation(self, generator: TitleGenerator) -> None:
        title = await generator.generate("你好，世界！")
        # 标点被替换为空格
        assert "你好" in title

    @pytest.mark.anyio
    async def test_intent_extraction(self, generator: TitleGenerator) -> None:
        title = await generator.generate("帮我写一个排序算法")
        assert "排序算法" in title

    @pytest.mark.anyio
    async def test_intent_how_to(self, generator: TitleGenerator) -> None:
        title = await generator.generate("如何学习Python编程语言")
        assert "学习Python编程语言" in title

    @pytest.mark.anyio
    async def test_empty_message_fallback(self, generator: TitleGenerator) -> None:
        title = await generator.generate("")
        assert title.startswith("对话 ")

    @pytest.mark.anyio
    async def test_none_message_fallback(self, generator: TitleGenerator) -> None:
        title = await generator.generate("")
        assert title.startswith("对话 ")

    @pytest.mark.anyio
    async def test_long_message_truncation(self, generator: TitleGenerator) -> None:
        long_msg = "这是一个非常长的消息，" * 10
        title = await generator.generate(long_msg)
        assert len(title) <= 20

    @pytest.mark.anyio
    async def test_max_title_length_configurable(self) -> None:
        gen = TitleGenerator(max_title_length=10)
        title = await gen.generate("这是一个比较长的标题文本")
        assert len(title) <= 10

    def test_extract_keywords(self, generator: TitleGenerator) -> None:
        keywords = generator._extract_keywords("Python编程语言的排序算法")
        assert len(keywords) > 0

    def test_summarize_content(self, generator: TitleGenerator) -> None:
        summary = generator._summarize_content("这是一个关于排序算法的讨论。后续内容不重要。")
        assert len(summary) <= 20

    def test_format_title_with_keywords(self, generator: TitleGenerator) -> None:
        title = generator._format_title(["排序", "算法"])
        assert "排序" in title
        assert "算法" in title

    def test_format_title_with_summary(self, generator: TitleGenerator) -> None:
        title = generator._format_title([], "写一个函数")
        assert title == "写一个函数"

    def test_extract_intent(self, generator: TitleGenerator) -> None:
        intent = generator._extract_intent("帮我写一个函数")
        assert "写一个函数" in intent

    def test_extract_intent_no_match(self, generator: TitleGenerator) -> None:
        intent = generator._extract_intent("今天天气不错")
        assert intent == ""

    def test_fallback_title_format(self) -> None:
        title = TitleGenerator._make_fallback_title()
        assert title.startswith("对话 ")


# ==================== SessionRecap 测试 ====================


class TestSessionRecap:
    """测试基于本地规则的会话回顾生成器。"""

    @pytest.fixture()
    def recap(self) -> SessionRecap:
        return SessionRecap()

    @pytest.mark.anyio
    async def test_empty_messages(self, recap: SessionRecap) -> None:
        result = await recap.recap([])
        assert result["summary"] == "无对话内容"
        assert result["key_points"] == []
        assert result["decisions"] == []
        assert result["action_items"] == []

    @pytest.mark.anyio
    async def test_question_extraction(self, recap: SessionRecap) -> None:
        messages = [
            {"role": "user", "content": "什么是Python？"},
            {"role": "assistant", "content": "Python是一种编程语言"},
        ]
        result = await recap.recap(messages)
        assert len(result["key_points"]) > 0
        assert any("提问" in kp for kp in result["key_points"])

    @pytest.mark.anyio
    async def test_decision_extraction(self, recap: SessionRecap) -> None:
        messages = [
            {"role": "user", "content": "我们决定使用Python开发"},
            {"role": "assistant", "content": "好的，Python是个好选择"},
        ]
        result = await recap.recap(messages)
        assert len(result["decisions"]) > 0

    @pytest.mark.anyio
    async def test_action_item_extraction(self, recap: SessionRecap) -> None:
        messages = [
            {"role": "user", "content": "需要完成单元测试"},
            {"role": "assistant", "content": "好的，TODO: 完成测试"},
        ]
        result = await recap.recap(messages)
        assert len(result["action_items"]) > 0

    @pytest.mark.anyio
    async def test_summary_generation(self, recap: SessionRecap) -> None:
        messages = [
            {"role": "user", "content": "什么是Python？"},
            {"role": "assistant", "content": "Python是一种编程语言"},
        ]
        result = await recap.recap(messages)
        assert "2 条消息" in result["summary"]

    @pytest.mark.anyio
    async def test_max_points_limit(self, recap: SessionRecap) -> None:
        messages = [
            {"role": "user", "content": f"问题{i}是什么？"}
            for i in range(10)
        ]
        result = await recap.recap(messages, max_points=3)
        assert len(result["key_points"]) <= 3

    @pytest.mark.anyio
    async def test_date_extraction(self, recap: SessionRecap) -> None:
        messages = [
            {"role": "assistant", "content": "会议定在2026年7月7日"},
        ]
        result = await recap.recap(messages)
        assert any("关键信息" in kp for kp in result["key_points"])

    def test_make_snippet(self, recap: SessionRecap) -> None:
        long_content = "a" * 200
        snippet = recap._make_snippet(long_content)
        assert len(snippet) <= 121  # 120 + "…"
        assert snippet.endswith("…")

    def test_make_snippet_short(self, recap: SessionRecap) -> None:
        content = "短内容"
        snippet = recap._make_snippet(content)
        assert snippet == "短内容"

    def test_make_snippet_empty(self, recap: SessionRecap) -> None:
        snippet = recap._make_snippet("")
        assert snippet == ""

    @pytest.mark.anyio
    async def test_full_structured_output(self, recap: SessionRecap) -> None:
        messages = [
            {"role": "user", "content": "项目要用什么语言？"},
            {"role": "assistant", "content": "决定使用Python"},
            {"role": "user", "content": "需要写测试用例"},
        ]
        result = await recap.recap(messages)
        assert "summary" in result
        assert "key_points" in result
        assert "decisions" in result
        assert "action_items" in result
        assert isinstance(result["key_points"], list)
        assert isinstance(result["decisions"], list)
        assert isinstance(result["action_items"], list)


# ==================== ErrorClassifier 测试 ====================


class TestErrorClassifier:
    """测试通用错误分类器。"""

    @pytest.fixture()
    def classifier(self) -> ErrorClassifier:
        return ErrorClassifier()

    def test_classify_timeout(self, classifier: ErrorClassifier) -> None:
        error = TimeoutError("request timed out")
        result = classifier.classify(error)
        assert result.category == ErrorCategory.TIMEOUT
        assert result.is_retryable is True
        assert result.retry_delay == 5.0

    def test_classify_connection_error(self, classifier: ErrorClassifier) -> None:
        error = ConnectionError("connection refused")
        result = classifier.classify(error)
        assert result.category == ErrorCategory.NETWORK_ERROR
        assert result.is_retryable is True
        assert result.retry_delay == 10.0

    def test_classify_generic_exception(self, classifier: ErrorClassifier) -> None:
        error = RuntimeError("something went wrong")
        result = classifier.classify(error)
        assert result.category == ErrorCategory.UNKNOWN
        assert result.is_retryable is True
        assert result.retry_delay == 5.0

    def test_classify_with_status_code_429(self, classifier: ErrorClassifier) -> None:
        error = Exception("rate limited")
        error.status_code = 429  # type: ignore[attr-defined]
        result = classifier.classify(error)
        assert result.category == ErrorCategory.RATE_LIMIT
        assert result.is_retryable is True
        assert result.retry_delay == 60.0

    def test_classify_with_status_code_401(self, classifier: ErrorClassifier) -> None:
        error = Exception("unauthorized")
        error.status_code = 401  # type: ignore[attr-defined]
        result = classifier.classify(error)
        assert result.category == ErrorCategory.AUTH_FAILED
        assert result.is_retryable is False
        assert result.retry_delay == 0.0

    def test_classify_with_status_code_403(self, classifier: ErrorClassifier) -> None:
        error = Exception("forbidden")
        error.status_code = 403  # type: ignore[attr-defined]
        result = classifier.classify(error)
        assert result.category == ErrorCategory.AUTH_FAILED
        assert result.is_retryable is False

    def test_classify_with_status_code_400(self, classifier: ErrorClassifier) -> None:
        error = Exception("bad request")
        error.status_code = 400  # type: ignore[attr-defined]
        result = classifier.classify(error)
        assert result.category == ErrorCategory.INVALID_REQUEST
        assert result.is_retryable is False

    def test_classify_with_status_code_500(self, classifier: ErrorClassifier) -> None:
        error = Exception("internal server error")
        error.status_code = 500  # type: ignore[attr-defined]
        result = classifier.classify(error)
        assert result.category == ErrorCategory.SERVER_ERROR
        assert result.is_retryable is True
        assert result.retry_delay == 30.0

    def test_classify_with_status_code_502(self, classifier: ErrorClassifier) -> None:
        error = Exception("bad gateway")
        error.status_code = 502  # type: ignore[attr-defined]
        result = classifier.classify(error)
        assert result.category == ErrorCategory.SERVER_ERROR

    def test_classify_with_status_code_503(self, classifier: ErrorClassifier) -> None:
        error = Exception("service unavailable")
        error.status_code = 503  # type: ignore[attr-defined]
        result = classifier.classify(error)
        assert result.category == ErrorCategory.SERVER_ERROR

    def test_classify_context_too_long_by_message(self, classifier: ErrorClassifier) -> None:
        error = Exception("context length exceeds maximum")
        result = classifier.classify(error)
        assert result.category == ErrorCategory.CONTEXT_TOO_LONG
        assert result.is_retryable is False

    def test_classify_quota_exceeded_by_message(self, classifier: ErrorClassifier) -> None:
        error = Exception("quota exceeded for this month")
        result = classifier.classify(error)
        assert result.category == ErrorCategory.QUOTA_EXCEEDED
        assert result.is_retryable is False

    def test_classify_model_not_found_by_message(self, classifier: ErrorClassifier) -> None:
        error = Exception("model not found: gpt-5")
        result = classifier.classify(error)
        assert result.category == ErrorCategory.MODEL_NOT_FOUND

    def test_from_status_code_429(self) -> None:
        result = ErrorClassifier.from_status_code(429, "Too Many Requests")
        assert result.category == ErrorCategory.RATE_LIMIT
        assert result.is_retryable is True
        assert result.retry_delay == 60.0

    def test_from_status_code_401(self) -> None:
        result = ErrorClassifier.from_status_code(401, "Unauthorized")
        assert result.category == ErrorCategory.AUTH_FAILED
        assert result.is_retryable is False

    def test_from_status_code_500(self) -> None:
        result = ErrorClassifier.from_status_code(500, "Internal Server Error")
        assert result.category == ErrorCategory.SERVER_ERROR
        assert result.is_retryable is True

    def test_from_status_code_unknown(self) -> None:
        result = ErrorClassifier.from_status_code(418, "I'm a teapot")
        assert result.category == ErrorCategory.UNKNOWN

    def test_from_status_code_with_context_message(self) -> None:
        result = ErrorClassifier.from_status_code(400, "context length too long")
        assert result.category == ErrorCategory.CONTEXT_TOO_LONG

    def test_from_status_code_with_quota_message(self) -> None:
        result = ErrorClassifier.from_status_code(403, "quota exceeded")
        assert result.category == ErrorCategory.QUOTA_EXCEEDED

    def test_is_retryable(self, classifier: ErrorClassifier) -> None:
        assert classifier.is_retryable(ErrorCategory.RATE_LIMIT) is True
        assert classifier.is_retryable(ErrorCategory.NETWORK_ERROR) is True
        assert classifier.is_retryable(ErrorCategory.SERVER_ERROR) is True
        assert classifier.is_retryable(ErrorCategory.TIMEOUT) is True
        assert classifier.is_retryable(ErrorCategory.AUTH_FAILED) is False
        assert classifier.is_retryable(ErrorCategory.INVALID_REQUEST) is False
        assert classifier.is_retryable(ErrorCategory.CONTEXT_TOO_LONG) is False
        assert classifier.is_retryable(ErrorCategory.QUOTA_EXCEEDED) is False

    def test_get_retry_delay(self, classifier: ErrorClassifier) -> None:
        assert classifier.get_retry_delay(ErrorCategory.RATE_LIMIT) == 60.0
        assert classifier.get_retry_delay(ErrorCategory.NETWORK_ERROR) == 10.0
        assert classifier.get_retry_delay(ErrorCategory.SERVER_ERROR) == 30.0
        assert classifier.get_retry_delay(ErrorCategory.TIMEOUT) == 5.0
        assert classifier.get_retry_delay(ErrorCategory.AUTH_FAILED) == 0.0
        assert classifier.get_retry_delay(ErrorCategory.CONTEXT_TOO_LONG) == 0.0

    def test_classified_error_preserves_original(self, classifier: ErrorClassifier) -> None:
        original = ValueError("test error")
        result = classifier.classify(original)
        assert result.original_error is original

    def test_classified_error_has_suggested_action(self, classifier: ErrorClassifier) -> None:
        error = TimeoutError("timeout")
        result = classifier.classify(error)
        assert result.suggested_action != ""

    def test_error_category_values(self) -> None:
        assert ErrorCategory.RATE_LIMIT.value == "rate_limit"
        assert ErrorCategory.AUTH_FAILED.value == "auth_failed"
        assert ErrorCategory.NETWORK_ERROR.value == "network_error"
        assert ErrorCategory.INVALID_REQUEST.value == "invalid_request"
        assert ErrorCategory.SERVER_ERROR.value == "server_error"
        assert ErrorCategory.CONTEXT_TOO_LONG.value == "context_too_long"
        assert ErrorCategory.MODEL_NOT_FOUND.value == "model_not_found"
        assert ErrorCategory.QUOTA_EXCEEDED.value == "quota_exceeded"
        assert ErrorCategory.TIMEOUT.value == "timeout"
        assert ErrorCategory.UNKNOWN.value == "unknown"

    def test_extract_status_code_from_response(self, classifier: ErrorClassifier) -> None:
        """测试从 error.response.status_code 提取状态码。"""

        class MockResponse:
            status_code = 429

        error = Exception("rate limited")
        error.response = MockResponse()  # type: ignore[attr-defined]
        result = classifier.classify(error)
        assert result.category == ErrorCategory.RATE_LIMIT
