# Document Governance — 文档治理架构

> 核心原则：不同阶段的文档，不需要"完全合并"。
> 四类文档混在一起，必然越来越乱。

## 四层分离模型

```
docs/
├── A-ground-truth/          # 真相底账 — 系统当前真实状态
│   ├── authority-map.md     #   Authority 清单及职责
│   ├── task-inventory.md    #   T/G/N/H 任务清单及状态
│   ├── capability-matrix.md #   每个 Authority 的能力边界
│   └── pipeline-status.md   #   P0-P6 主链当前阶段
│
├── B-audit/                 # 审计结果 — 验证数据，只追加不修改
│   ├── D7-3C-audit.md       #   Decision→Action→Evidence 链路审计
│   ├── D7-4-audit.md        #   Goal 完成闭环审计
│   ├── D8-audit.md          #   真实任务通过率
│   └── D9-audit.md          #   跨任务泛化审计
│
├── C-rules/                 # 开发规则 — 约束，极少变化
│   ├── audit-rules.md       #   审计规则（不可造假、Evidence 来自环境）
│   ├── coding-standards.md  #   代码规范
│   └── change-policy.md     #   改什么只改对应层
│
└── D-process/               # 开发过程记录 — 可废弃/归档
    ├── P0-to-P1-log.md      #   阶段过渡记录
    ├── P1-to-P5-log.md
    └── decisions-log.md     #   关键决策记录
```

## 各层读写规则

| 层 | 谁能写 | 写入规则 | 生命周期 |
|----|--------|----------|----------|
| **A 真相底账** | 代码变更自动更新 | 每次 `src/` 变更后同步更新对应条目 | 永久，但可被新状态覆盖 |
| **B 审计结果** | 测试/审计脚本 | **只追加，不修改历史** | 永久，不可删除 |
| **C 开发规则** | 人工审批 | 修改需说明原因，GLM 不能自行修改 | 极少变化 |
| **D 过程记录** | GLM/开发者自由写 | 无限制 | 可归档/删除 |

## 防止版本分叉的核心规则

### 规则 1：GLM 修一个 bug
- ✅ 改 `src/` 代码
- ✅ 追加 B 层审计条目
- ❌ 不动 A/C/D 层

### 规则 2：GLM 加一个功能
- ✅ 改 `src/` 代码
- ✅ 更新 A 层对应条目（authority-map / task-inventory）
- ✅ 追加 B 层审计条目
- ❌ 不动 C/D 层

### 规则 3：GLM 永远不合并/重构文档
- ❌ 不把多个文档合成一个
- ❌ 不重命名/移动已有文档
- ❌ 不修改历史审计数据

### 规则 4：旧文档处理
- `archive/` 下的文档：**不动**
- 根目录散落文档：**不动**，新文档按 4 层模型写入
- 需要引用旧文档时：用相对链接，不复制内容

## 现有文档归类

### → A-ground-truth（真相底账）
| 现有文件 | 对应新位置 |
|----------|-----------|
| AUTHORITY_RECONSTRUCTION.md | A/authority-map.md |
| TOP_LEVEL_DESIGN.md | A/pipeline-status.md（部分） |
| DEPRECATION_MAP.md | A/capability-matrix.md（部分） |

### → B-audit（审计结果）
| 现有文件 | 对应新位置 |
|----------|-----------|
| COMPREHENSIVE_ENGINEERING_AUDIT_2026-09-04.md | B/D8-audit.md（部分） |
| D4_I2_Post_Integration_Audit_2026-09-10.md | B/D7-4-audit.md（部分） |
| ARCHITECTURE_AUDIT_V6.md | B/（历史审计，保留原位） |

### → C-rules（开发规则）
| 现有文件 | 对应新位置 |
|----------|-----------|
| PRODUCTION_READINESS_RUNBOOK.md | C/（部分规则） |
| DEPRECATION_SCHEDULE.md | C/change-policy.md（部分） |

### → D-process（过程记录）
| 现有文件 | 对应新位置 |
|----------|-----------|
| EXECUTION_AGENT_ROADMAP.md | D/decisions-log.md（部分） |
| P0-1_default_python_backend_changelog.md | D/P0-to-P1-log.md（部分） |
| archive/** | 保留原位不动 |

## 迁移策略

**不迁移。** 旧文档留在原位，新文档按 4 层模型写入。
理由：迁移本身就会制造版本分叉。新架构从今天开始，旧文档自然过期。
