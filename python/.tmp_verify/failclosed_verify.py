import asyncio, sys, builtins
sys.path.insert(0, ".")
from agent.tools.code_tools import shell_exec_executor

_real_import = builtins.__import__
def broken_import(name, *a, **k):
    if name == "agent.sandbox.executor":
        raise ModuleNotFoundError("模拟沙箱子系统缺失")
    return _real_import(name, *a, **k)

async def main():
    builtins.__import__ = broken_import
    try:
        r = await shell_exec_executor({"command": "echo 本不该执行"})
    finally:
        builtins.__import__ = _real_import
    print("守卫不可用时 -> success =", r.success)
    print("            metadata =", r.metadata)
    print("            error    =", (r.error or "")[:100])
    print()
    print("结论:", "PASS fail-closed（已拦截）" if r.success is False else "FAIL 仍然 fail-open（放行了）")

asyncio.run(main())
