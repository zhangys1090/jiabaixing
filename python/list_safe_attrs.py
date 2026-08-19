"""列出可安全删除的扁平属性（Presentation/Cache/Session/Observability域）。"""
from agent.core.domain_containers import SUBSYSTEM_TO_DOMAIN

safe_domains = {"presentation", "cache", "session", "observability"}
safe_attrs = {k for k, v in SUBSYSTEM_TO_DOMAIN.items() if v in safe_domains}

print("可安全删除的扁平属性（__init__中全为None，已有域容器+代理覆盖）:")
for domain in sorted(safe_domains):
    attrs = sorted(k for k, v in SUBSYSTEM_TO_DOMAIN.items() if v == domain)
    print(f"\n  {domain} ({len(attrs)}):")
    for a in attrs:
        print(f"    self.{a}: Any = None")

print(f"\n总计: {len(safe_attrs)} 个属性可安全删除")
