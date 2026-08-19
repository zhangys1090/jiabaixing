import asyncio, sys
sys.path.insert(0, ".")
from agent.tools.code_tools import shell_exec_executor

async def main():
    for cmd in ["rm -rf /", "echo hello"]:
        r = await shell_exec_executor({"command": cmd})
        viol = (r.metadata or {}).get("security_violation")
        print(f"{cmd!r:16} success={r.success} security_violation={viol}")
        print(f"                 error={(r.error or '')[:90]}")

asyncio.run(main())
