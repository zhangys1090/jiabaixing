"""
简单的导入检查脚本

用于验证统一上下文编排器模块是否能正确导入。
"""

import sys
import os

# 添加项目路径
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

print("=" * 60)
print("  Unified Context Orchestrator - Import Check")
print("=" * 60)
print()

errors = []
successes = []

# 1. Check models module
print("1. Checking models module...")
try:
    from agent.context.models import (
        BuildContext,
        BuildStatistics,
        BuildStatus,
        CacheMetrics,
        CacheStrategy,
        ComponentDependency,
        ComponentMetrics,
        ComponentPriority,
        ComponentResult,
        ComponentStatus,
        ContextBuildRequest,
        ContextBuildResult,
        ErrorInfo,
    )
    print("   [OK] models module imported successfully")
    successes.append("models")
except Exception as e:
    print(f"   [FAIL] models module import failed: {e}")
    errors.append(("models", str(e)))

print()

# 2. Check base module
print("2. Checking base module...")
try:
    from agent.context.base import (
        ComponentRegistry,
        ContextComponent,
        DependencyResolver,
    )
    print("   [OK] base module imported successfully")
    successes.append("base")
except Exception as e:
    print(f"   [FAIL] base module import failed: {e}")
    errors.append(("base", str(e)))

print()

# 3. Check cache module
print("3. Checking cache module...")
try:
    from agent.context.cache import ContextCache, LRUCache
    print("   [OK] cache module imported successfully")
    successes.append("cache")
except Exception as e:
    print(f"   [FAIL] cache module import failed: {e}")
    errors.append(("cache", str(e)))

print()

# 4. Check unified_orchestrator module
print("4. Checking unified_orchestrator module...")
try:
    from agent.context.unified_orchestrator import (
        UnifiedContextOrchestrator,
        get_orchestrator,
    )
    print("   [OK] unified_orchestrator module imported successfully")
    successes.append("unified_orchestrator")
except Exception as e:
    print(f"   [FAIL] unified_orchestrator module import failed: {e}")
    errors.append(("unified_orchestrator", str(e)))

print()

# 5. Check adapters module
print("5. Checking adapters module...")
try:
    from agent.context.adapters import (
        SystemPromptComponent,
        PersonaComponent,
        MemoryRetrievalComponent,
        FileContextComponent,
        TokenBudgetComponent,
        ContextAssemblerComponent,
    )
    print("   [OK] adapters module imported successfully")
    successes.append("adapters")
except Exception as e:
    print(f"   [FAIL] adapters module import failed: {e}")
    errors.append(("adapters", str(e)))

print()

# 6. Check context package __init__
print("6. Checking context package exports...")
try:
    from agent.context import (
        UnifiedContextOrchestrator,
        ContextBuildRequest,
        ContextBuildResult,
        BuildContext,
        get_orchestrator,
    )
    print("   [OK] context package exports successful")
    successes.append("context_package")
except Exception as e:
    print(f"   [FAIL] context package exports failed: {e}")
    errors.append(("context_package", str(e)))

print()

# 7. Simple functional test
print("7. Simple functional test...")
try:
    from agent.context import UnifiedContextOrchestrator, ContextBuildRequest
    from agent.context.adapters import SystemPromptComponent

    orch = UnifiedContextOrchestrator(enabled=True, use_cache=False)
    orch.register_component(SystemPromptComponent())

    request = ContextBuildRequest(user_input="test")
    import asyncio

    async def test():
        result = await orch.build_context(request)
        return result

    result = asyncio.run(test())

    if result.is_success():
        print(f"   [OK] simple build test passed (messages: {len(result.messages)})")
        successes.append("simple_test")
    else:
        print(f"   [FAIL] simple build test failed: {result.status}")
        errors.append(("simple_test", f"status: {result.status}"))
except Exception as e:
    print(f"   [FAIL] simple functional test failed: {e}")
    import traceback
    traceback.print_exc()
    errors.append(("simple_test", str(e)))

print()

# Summary
print("=" * 60)
print("  Summary")
print("=" * 60)
print()
print(f"Success: {len(successes)} items")
print(f"Failed: {len(errors)} items")
print()

if errors:
    print("Failure details:")
    for name, error in errors:
        print(f"  - {name}: {error}")
    print()
    print("Import check FAILED. Please fix the errors above.")
else:
    print("All import checks PASSED!")
    print()
    print("You can continue with unit tests and performance benchmarks.")

print()
