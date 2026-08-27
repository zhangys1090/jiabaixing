import py_compile
import os
import sys

errors = []
for root, dirs, files in os.walk("agent"):
    for fn in files:
        if fn.endswith(".py"):
            fp = os.path.join(root, fn)
            try:
                py_compile.compile(fp, doraise=True)
            except py_compile.PyCompileError as e:
                errors.append((fp, str(e)))

if errors:
    for fp, err in errors:
        print(f"FAIL: {fp}")
        print(f"  {err[:200]}")
    print(f"\nTotal: {len(errors)} files with syntax errors")
    sys.exit(1)
else:
    print("ALL OK - no syntax errors")
    sys.exit(0)
