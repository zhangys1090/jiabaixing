# Hermes Agent 成熟度评估与优化路线图

> **评估日期**: 2026-07-01
> **评估标准**: 对标CLAUDE/GPT-4等成熟执行Agent
> **综合评级**: B+ (82/100) — 基础设施完备,核心能力扎实,但集成度和多模态输入有差距

---

## 一、能力成熟度矩阵

### 1.1 已完成(完备/优秀) — 9项

| 维度 | 实现水平 | 核心代码位置 | 对标商业Agent |
|------|---------|-------------|--------------|
| **ReAct循环** | ⭐⭐⭐⭐⭐ 完备 | `python/agent/loop/controller.py` — 支持结构化ReAct(JSON)和Plan→Exec→Eval→Replan双模式 | ≥ Claude |
| **自我反思** | ⭐⭐⭐⭐⭐ 6层反思 | `python/agent/loop/reflection.py` — 工具级/步骤级/任务级/成功/轻量/元反思 | > GPT-4(仅单层) |
| **工具韧性** | ⭐⭐⭐⭐⭐ L1-L4金字塔 | `python/agent/loop/executor.py` + `robustness.py` — 错误分类+指数退避+参数修正+降级替代 | > Claude |
| **进化闭环** | ⭐⭐⭐⭐⭐ 7引擎统一 | `python/agent/evolution/` + `src/evolution/EvolutionOrchestrator.ts` — V1反馈学习+V2代码自进化 | > 所有商业Agent |
| **审批安全** | ⭐⭐⭐⭐⭐ 4种模式 | `src/security/ApprovalEngine.ts` — auto/inline/batch/deny + 风险评估+审计日志 | ≥ Claude |
| **并发编排** | ⭐⭐⭐⭐⭐ asyncio.gather | `python/agent/orchestration/fanout.py` + `src/harness/orchestration/SubAgentFanout.ts` — DAG协调 | ≥ Claude |
| **上下文管理** | ⭐⭐⭐⭐ 活跃 | `src/harness/context/` — 主动检索+注意力聚焦+技能渐进式披露 | > GPT-4 |
| **因果推理** | ⭐⭐⭐⭐ 独特优势 | `python/agent/loop/causal.py` — 根因分析+影响传播+依赖图谱 | 唯一具备 |
| **记忆系统** | ⭐⭐⭐⭐ 三层架构 | `src/memory/MemoryEngine.ts` — 短期/长期/轨迹 + 向量检索(迁移中) | ≥ Claude |

### 1.2 部分实现(有差距) — 4项

| 维度 | 当前水平 | 差距 | 修复优先级 |
|------|---------|------|-----------|
| **多模态输入** | ⭐⭐ 仅输出端 | 有TTS/图像生成,缺少Vision输入管道(PDF/Word/Excel解析) | **P0 — 5-7天** |
| **Python记忆集成** | ⭐⭐⭐ 进行中 | TS MemoryEngine已deprecated,Python侧`agent/memory/`未完全实现 | **P1 — 3-5天** |
| **代码生成工具** | ⭐ TODO占位 | `src/harness/tools/code/code_generate.ts`大量TODO未实现 | **P1 — 3-5天** |
| **统一ContextBuilder** | ⭐⭐⭐ 5个TODO | `UnifiedContextBuilder.ts`中fileContextCount/referenceCount/cacheHitRate硬编码为0 | **P1 — 2-3天** |

### 1.3 测试覆盖度

| 测试类型 | 数量 | 状态 | 空白 |
|---------|------|------|------|
| **Python单元测试** | 1478通过 | ✅ 活跃 | executor/controller/reflection的集成测试 |
| **TypeScript单元测试** | 预存18旧错 | ⚠️ 停滞 | E2E测试11项skip(标注"已迁移到Python") |
| **进化系统审计** | 真实数据 | ✅ 完备 | 100条反馈历史+20个PromptExamples |

---

## 二、与竞品对标的关键差异

### 2.1 超越商业Agent的特性 ✅

| 能力 | Hermes | Claude | GPT-4 |
|------|--------|--------|-------|
| **反思层数** | 6层(含元反思) | 1层 | 0层(无内置反思) |
| **代码自进化** | EvolutionEngineV2可修改自身代码 | ❌ | ❌ |
| **因果推理** | CausalModeler根因分析 | ❌ | ❌ |
| **韧性重试** | L1-L4金字塔 | L1(基础重试) | ❌ |
| **审批安全** | ApprovalEngine+审计日志 | ❌ | ❌ |
| **进化学习** | 100条反馈历史+19个Auto-Skill | ❌ | ❌ |

### 2.2 落后于商业Agent的领域 ❌

| 能力 | Hermes | Claude | GPT-4 |
|------|--------|--------|-------|
| **Vision输入** | ❌ 无 | ✅ 图片/文档理解 | ✅ 多模态理解 |
| **文件解析** | ❌ 无PDF/Word提取 | ✅ Embedding | ✅ Embedding |
| **生态整合** | ⚠️ ACP stdio(自建) | ✅ ACP协议 | ✅ GPT Store |
| **语音理解** | ⚠️ 仅TTS输出 | ✅ STT+TTS | ✅ STT+TTS |
| **浏览器自动化** | ⚠️ 部分(需external skill) | ✅ Built-in | ✅ Built-in |

---

## 三、优化路线图(按优先级排序)

### P0 — 多模态输入管道 (5-7天) ⭐⭐⭐⭐⭐

**目标**: 补齐Vision输入能力,对标Claude/GPT-4

**实施方案**:

1. **文件上传解析管道** (2-3天)
   - 集成`pdfkit-py` skill解析PDF
   - 集成`xlsx` skill解析Excel
   - 集成`docx` skill解析Word
   - 路径: `src/harness/tools/file/file_parse.ts` (新增)
   - 调用方式: LLM检测到文件上传时自动选择解析工具

2. **Vision模型集成** (2-3天)
   - 接入GPT-4o Vision或Claude Vision API
   - 支持图片理解(截图/照片/图表)
   - 路径: 修改`src/llm/provider/openai.ts`添加vision支持
   - 配置: `.env`中添加`VISION_MODEL=gpt-4o-vision`

3. **OCR文本提取** (1天)
   - 集成`tesseract.js`或云端OCR API
   - 支持扫描图片转文本
   - 路径: `src/harness/tools/file/ocr.ts` (新增)

**验收标准**:
- [ ] 用户上传PDF/Word/Excel后,Hermes能解析并提取文本
- [ ] 上传图片后,Hermes能理解图片内容并回复
- [ ] OCR能处理扫描件图片(准确率>90%)

---

### P1 — 清理废弃代码 (1-2天) ⭐⭐⭐⭐

**目标**: 删除@deprecated的TS MemoryEngine,避免误导新开发者

**实施方案**:

1. **删除MemoryEngine.ts**
   - 文件: `src/memory/MemoryEngine.ts`
   - 操作: 标记为DEPRECATED_V6_REMOVE,在注释中明确指引Python侧`agent/memory/`
   - 替代: 所有引用改为`from agent.memory.engine import MemoryEngine`

2. **清理AgentHarness.ts中的过时逻辑**
   - 文件: `src/harness/AgentHarness.ts` (行690-699)
   - 操作: 删除`processInput()`中的迁移提示抛出异常逻辑
   - 替代: 直接委托给Python后端`/api/agent/process`端点

3. **统一ContextBuilder TODO**
   - 文件: `src/harness/context/UnifiedContextBuilder.ts` (5个TODO)
   - 操作: 实现ContextReferenceResolver集成+记忆注入+文件注册表统计
   - 路径: 读取`data/files/`目录获取真实文件计数

**验收标准**:
- [ ] TypeScript编译0新增错误
- [ ] 删除后系统正常运行,Python后端接管记忆
- [ ] UnifiedContextBuilder的fileContextCount/referenceCount/cacheHitRate为真实值

---

### P1 — 实现code_generate核心逻辑 (3-5天) ⭐⭐⭐

**目标**: 将TODO占位符替换为真实LLM代码生成调用

**实施方案**:

1. **LLM代码生成调用**
   - 文件: `src/harness/tools/code/code_generate.ts`
   - 操作: 集成`agent/llm/generate.py` Python后端端点
   - 功能: 根据自然语言描述生成TypeScript/Python代码
   - 示例: "创建一个Express路由处理用户登录" → 生成完整代码

2. **代码质量检查**
   - 集成`tsc --noEmit`验证生成的TypeScript代码
   - 集成`py_compile`验证生成的Python代码
   - 失败时返回错误信息并请求LLM修正

3. **沙箱执行**
   - 生成的代码在隔离环境中执行(容器或sandbox)
   - 捕获输出并反馈给用户
   - 路径: 复用`src/harness/sandbox/`现有沙箱

**验收标准**:
- [ ] 能根据自然语言描述生成可执行的TypeScript/Python代码
- [ ] 生成的代码通过编译检查
- [ ] 支持简单到中等复杂度的代码生成(函数/类/路由)

---

### P2 — Python记忆系统集成 (3-5天) ⭐⭐⭐

**目标**: 完成TS→Python记忆系统迁移,实现语义检索

**实施方案**:

1. **Python MemoryEngine实现**
   - 目录: `python/agent/memory/` (新建)
   - 类: `MemoryEngine` — 三层记忆(短期/长期/轨迹)
   - 存储: SQLite + FTS5全文检索 + ChromaDB向量检索
   - 路径: `python/agent/memory/engine.py`

2. **语义检索集成**
   - 工具: `langchain.embeddings`或`sentence-transformers`
   - 功能: 输入查询→向量嵌入→相似度检索→返回相关记忆
   - 阈值: cosine similarity > 0.7才返回

3. **经验迁移**
   - 功能: 从历史任务中提取可复用经验
   - 存储: `data/trajectory/`轨迹数据库
   - 查询: 相似任务场景自动推荐相关经验

**验收标准**:
- [ ] Python MemoryEngine能存储和检索短期/长期/轨迹记忆
- [ ] 语义检索准确率>80%(人工抽检50条)
- [ ] 经验迁移功能可用(相似任务自动推荐)

---

### P2 — 调试工具失败根因 (2-3天) ⭐⭐

**目标**: 持续优化file_search成功率(当前6.4%,已修复参数bug)

**实施方案**:

1. **增强file_search错误日志**
   - 文件: `src/harness/tools/file/file_search.ts`
   - 操作: 每次失败时记录具体原因(query为空/目录不存在/权限拒绝/超时)
   - 输出: `data/logs/file_search-failures.jsonl`

2. **分析失败模式**
   - 脚本: `scripts/analyze-file-search-failures.py`(新建)
   - 功能: 读取失败日志,统计失败原因分布
   - 输出: 可视化报表(PNG)

3. **针对性优化**
   - 如果query为空→Executor降级逻辑增加fallback
   - 如果目录不存在→增加目录自动创建或友好提示
   - 如果超时→调整TOOL_TIMEOUT环境变量默认值

**验收标准**:
- [ ] file_search成功率从6.4%提升至>50%(修复参数bug后预期)
- [ ] 失败日志可量化分析
- [ ] Top3失败原因有针对性优化

---

### P3 — 补充Python后端集成测试 (3-5天) ⭐⭐

**目标**: 填补Python核心组件的测试空白

**实施方案**:

1. **LoopController集成测试**
   - 文件: `python/tests/test_loop_controller_integration.py`(新建)
   - 内容: 端到端测试ReAct循环(输入→规划→执行→评估→输出)
   - 模拟: 使用mock LLM provider避免真实API调用

2. **Executor韧性测试**
   - 文件: `python/tests/test_executor_robustness.py`(新建)
   - 内容: 测试L1-L4韧性金字塔(L1重试/L2参数修正/L3降级/L4替代工具)
   - 场景: 模拟工具失败→验证自动重试→验证参数修正→验证降级

3. **ReflectionEngine测试**
   - 文件: `python/tests/test_reflection.py`(新建)
   - 内容: 测试6层反思(工具级/步骤级/任务级/成功/轻量/元反思)
   - 场景: 工具失败→触发工具级反思→输出根因和建议

**验收标准**:
- [ ] Python核心组件测试覆盖率达到>70%(当前约40%)
- [ ] E2E测试11项skip改为pass(对接Python后端)
- [ ] 测试运行时间<30秒(避免CI超时)

---

## 四、资源估算

| 优先级 | 工作量 | 依赖 | 风险 |
|--------|--------|------|------|
| **P0 多模态输入** | 5-7天 | 需PDF/Word/Excel解析库 | 低(现有skill可复用) |
| **P1 清理废弃代码** | 1-2天 | 无 | 极低 |
| **P1 code_generate** | 3-5天 | 需LLM代码生成API | 中(代码质量难保证) |
| **P2 Python记忆** | 3-5天 | 需ChromaDB/sentence-transformers | 中(向量检索调优复杂) |
| **P2 file_search调试** | 2-3天 | 无 | 极低 |
| **P3 Python测试** | 3-5天 | 无 | 低 |

**总计**: 17-27个工作日(可并行P1和P2)

---

## 五、成功标准

### 5.1 短期(30天内)

- [ ] P0多模态输入上线: 支持PDF/Word/Excel解析+图片理解
- [ ] P1废弃代码清理: TS MemoryEngine删除,Python记忆接管
- [ ] file_search成功率>50%
- [ ] 编译0新增错误

### 5.2 中期(60天内)

- [ ] P1 code_generate可用: 能生成可执行的TypeScript/Python代码
- [ ] P2 Python记忆集成: 语义检索准确率>80%
- [ ] P3测试覆盖率达到70%+
- [ ] 综合评级从B+(82)提升至A-(88+)

### 5.3 长期(90天内)

- [ ] 补齐语音理解(STT+TTS)
- [ ] 生态整合: 接入ACP协议或GPT Store
- [ ] 浏览器自动化: 内置Playwright集成
- [ ] 综合评级达到A(92+),对标Claude/GPT-4

---

## 六、核心优势与差异化战略

### 6.1 不应追赶商业Agent,而应发挥独特优势

| 优势 | 说明 | 投资策略 |
|------|------|---------|
| **代码自进化** | EvolutionEngineV2可修改自身代码 | ✅ 加大投入(唯一具备) |
| **因果推理** | CausalModeler根因分析+影响传播 | ✅ 加大投入(唯一具备) |
| **韧性重试** | L1-L4金字塔错误处理 | ✅ 维持领先 |
| **审批安全** | ApprovalEngine+审计日志 | ✅ 企业级差异化 |
| **本地化部署** | 不依赖云端API | ✅ 隐私敏感客户 |

### 6.2 需要补齐的基础能力

| 能力 | 投资策略 | 理由 |
|------|---------|------|
| **多模态输入** | P0最高优先 | 用户体验底线,缺一不可 |
| **文件解析** | P0最高优先 | 企业场景刚需 |
| **生态整合** | P3低优先 | 长期规划,不急于一时 |

---

*评估完毕。下一步建议: 先执行P1清理废弃代码(1-2天),快速见效后再投入P0多模态输入(5-7天).*
