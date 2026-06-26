"""
Unified Context Orchestrator - Functional Verification

Tests core functionality of the orchestrator.
"""

from __future__ import annotations

import asyncio
import os
import sys

# Add project path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from agent.context import (
    BuildStatus,
    ComponentStatus,
    ContextBuildRequest,
    UnifiedContextOrchestrator,
)
from agent.context.adapters import (
    ContextAssemblerComponent,
    FileContextComponent,
    MemoryRetrievalComponent,
    PersonaComponent,
    SystemPromptComponent,
    TokenBudgetComponent,
)


async def test_component_registration():
    """Test component registration"""
    print("Test 1: Component Registration")
    print("-" * 50)

    orch = UnifiedContextOrchestrator(enabled=True, use_cache=False)

    # Register components
    orch.register_component(SystemPromptComponent())
    orch.register_component(PersonaComponent())
    orch.register_component(MemoryRetrievalComponent())

    # Check count
    count = orch.component_count
    print(f"  Registered components: {count}")

    # List components
    components = orch.list_components()
    print(f"  Component list: {components}")

    # Check if specific component exists
    has_system = orch.get_component("system_prompt") is not None
    print(f"  Has system_prompt: {has_system}")

    # Unregister component
    orch.unregister_component("persona")
    print(f"  After unregister persona: {orch.component_count} components")

    # Disable component
    orch.disable_component("memory_retrieval")
    print(f"  memory_retrieval disabled")

    # Enable component
    orch.enable_component("memory_retrieval")
    print(f"  memory_retrieval enabled")

    print("  [PASS] Component registration test passed")
    print()
    return True


async def test_basic_build():
    """Test basic context building"""
    print("Test 2: Basic Context Build")
    print("-" * 50)

    orch = UnifiedContextOrchestrator(enabled=True, use_cache=False)
    orch.register_component(SystemPromptComponent())
    orch.register_component(ContextAssemblerComponent())

    request = ContextBuildRequest(
        user_input="Hello, how are you?",
        session_id="test_session",
        scene="daily",
    )

    result = await orch.build_context(request)

    print(f"  Build status: {result.status}")
    print(f"  Message count: {len(result.messages)}")
    print(f"  Total tokens: {result.total_tokens}")
    print(f"  Build time: {result.build_time_ms:.3f} ms")
    print(f"  Component results: {list(result.component_results.keys())}")

    # Check messages
    roles = [msg["role"] for msg in result.messages]
    print(f"  Message roles: {roles}")

    assert result.is_success(), "Build should succeed"
    assert len(result.messages) > 0, "Should have messages"
    assert "system" in roles, "Should have system message"
    assert "user" in roles, "Should have user message"

    print("  [PASS] Basic build test passed")
    print()
    return True


async def test_history():
    """Test history messages"""
    print("Test 3: History Messages")
    print("-" * 50)

    orch = UnifiedContextOrchestrator(enabled=True, use_cache=False)
    orch.register_component(SystemPromptComponent())
    orch.register_component(ContextAssemblerComponent())

    history = [
        {"role": "user", "content": "What is your name?"},
        {"role": "assistant", "content": "My name is Jiabaixing."},
        {"role": "user", "content": "How old are you?"},
        {"role": "assistant", "content": "I am an AI, I don't have an age."},
    ]

    request = ContextBuildRequest(
        user_input="Tell me more about yourself.",
        history=history,
    )

    result = await orch.build_context(request)

    print(f"  History count in request: {len(history)}")
    print(f"  Total messages in result: {len(result.messages)}")
    print(f"  History extracted: {len(result.history)}")

    # Should have: system + 4 history + 1 user = 6 messages
    expected_count = 1 + len(history) + 1  # system + history + user
    print(f"  Expected messages: {expected_count}")

    assert len(result.messages) == expected_count, f"Expected {expected_count} messages"

    print("  [PASS] History test passed")
    print()
    return True


async def test_cache():
    """Test cache functionality"""
    print("Test 4: Cache Functionality")
    print("-" * 50)

    orch = UnifiedContextOrchestrator(enabled=True, use_cache=True)
    orch.register_component(SystemPromptComponent())

    # First request (cache miss)
    request1 = ContextBuildRequest(user_input="test cache")
    result1 = await orch.build_context(request1)
    time1 = result1.build_time_ms
    print(f"  First build (miss): {time1:.3f} ms")
    print(f"  From cache: {result1.from_cache}")

    # Second request (cache hit)
    request2 = ContextBuildRequest(user_input="test cache")
    result2 = await orch.build_context(request2)
    time2 = result2.build_time_ms
    print(f"  Second build (hit): {time2:.3f} ms")
    print(f"  From cache: {result2.from_cache}")

    # Check cache stats
    stats = orch.get_cache_stats()
    print(f"  Cache stats: hit_rate={stats.get('hit_rate', 0):.2%}, hits={stats.get('cache_hits', 0)}, misses={stats.get('cache_misses', 0)}")

    # Cache hit should be faster
    assert result2.from_cache, "Second request should come from cache"

    # Clear cache
    orch.clear_cache()
    print("  Cache cleared")

    # After clearing, should be miss again
    result3 = await orch.build_context(request2)
    print(f"  After clear: from_cache={result3.from_cache}")
    assert not result3.from_cache, "After clear, should not be from cache"

    print("  [PASS] Cache test passed")
    print()
    return True


async def test_error_handling():
    """Test error handling and degradation"""
    print("Test 5: Error Handling & Degradation")
    print("-" * 50)

    from agent.context.base import ContextComponent
    from agent.context.models import BuildContext, ComponentPriority

    class FailingComponent(ContextComponent):
        """Component that always fails"""

        @property
        def name(self) -> str:
            return "failing_component"

        @property
        def priority(self) -> int:
            return ComponentPriority.SYSTEM_PROMPT + 5

        def can_handle(self, request) -> bool:
            return True

        async def _execute(self, request, context):
            raise ValueError("Intentional test error")

    orch = UnifiedContextOrchestrator(enabled=True, use_cache=False)
    orch.register_component(SystemPromptComponent())
    orch.register_component(FailingComponent())
    orch.register_component(ContextAssemblerComponent())

    request = ContextBuildRequest(user_input="test error")
    result = await orch.build_context(request)

    print(f"  Build status: {result.status}")
    print(f"  Error count: {len(result.errors)}")
    print(f"  Component results: {len(result.component_results)}")

    # Check component statuses
    for name, comp_result in result.component_results.items():
        print(f"    {name}: {comp_result.status}")

    # Should be partial success (some components failed but others succeeded)
    assert result.status == BuildStatus.PARTIAL or result.status == BuildStatus.SUCCESS, \
        f"Should be partial or success, got {result.status}"

    # Should have errors
    assert len(result.errors) > 0, "Should have errors"

    print("  [PASS] Error handling test passed")
    print()
    return True


async def test_disabled_orchestrator():
    """Test disabled orchestrator"""
    print("Test 6: Disabled Orchestrator")
    print("-" * 50)

    orch = UnifiedContextOrchestrator(enabled=False, use_cache=False)
    orch.register_component(SystemPromptComponent())

    request = ContextBuildRequest(
        user_input="test disabled",
        system_prompt="Custom system prompt",
    )

    result = await orch.build_context(request)

    print(f"  Orchestrator enabled: {orch.enabled}")
    print(f"  Build status: {result.status}")
    print(f"  Message count: {len(result.messages)}")

    # Even when disabled, should return basic result
    assert result.is_success(), "Should still succeed with basic result"
    assert len(result.messages) > 0, "Should have messages"

    print("  [PASS] Disabled orchestrator test passed")
    print()
    return True


async def test_all_adapters():
    """Test all adapter components"""
    print("Test 7: All Adapter Components")
    print("-" * 50)

    orch = UnifiedContextOrchestrator(enabled=True, use_cache=False)

    # Register all adapters
    components = [
        SystemPromptComponent(),
        PersonaComponent(),
        MemoryRetrievalComponent(),
        FileContextComponent(),
        TokenBudgetComponent(),
        ContextAssemblerComponent(),
    ]

    for comp in components:
        orch.register_component(comp)

    print(f"  Registered {len(components)} components")

    request = ContextBuildRequest(
        user_input="Test all components",
        session_id="test_all",
        scene="development",
        use_memory=False,
        use_file_context=False,
    )

    result = await orch.build_context(request)

    print(f"  Build status: {result.status}")
    print(f"  Component results: {len(result.component_results)}")
    print(f"  Message count: {len(result.messages)}")
    print(f"  Build time: {result.build_time_ms:.3f} ms")

    # List component statuses
    for name, comp_result in result.component_results.items():
        print(f"    {name}: {comp_result.status} ({comp_result.execution_time_ms:.3f} ms)")

    assert result.is_success(), "Build should succeed"

    print("  [PASS] All adapters test passed")
    print()
    return True


async def run_all_tests():
    """Run all functional tests"""
    print("=" * 70)
    print("  Unified Context Orchestrator - Functional Verification")
    print("=" * 70)
    print()

    tests = [
        test_component_registration,
        test_basic_build,
        test_history,
        test_cache,
        test_error_handling,
        test_disabled_orchestrator,
        test_all_adapters,
    ]

    passed = 0
    failed = 0
    failures = []

    for test_func in tests:
        try:
            await test_func()
            passed += 1
        except Exception as e:
            failed += 1
            failures.append((test_func.__name__, str(e)))
            print(f"  [FAIL] {test_func.__name__}: {e}")
            import traceback
            traceback.print_exc()
            print()

    print("=" * 70)
    print("  Test Summary")
    print("=" * 70)
    print()
    print(f"  Total: {len(tests)} tests")
    print(f"  Passed: {passed}")
    print(f"  Failed: {failed}")
    print()

    if failures:
        print("  Failed tests:")
        for name, error in failures:
            print(f"    - {name}: {error}")
        print()
        print("  Functional verification FAILED")
    else:
        print("  All tests PASSED!")
        print()
        print("  Functional verification completed successfully!")

    print()
    return failed == 0


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)
