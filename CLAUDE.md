# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

jiabaixing is a private AI companion — a mature, dedicated secretary (御姐秘书) that lives on the user's computer. One personality, local-first, always running.

She is not a toolbox you open and close. She is someone who remembers you, knows your habits, watches your schedule, and acts proactively — morning briefings, deadline reminders, mood-aware check-ins. She can search files, manage tasks, and hold real conversations. One person doing all of these things, not three modes pretending to be one.

**Current state:** v5.0 Harness Agent Framework (six-layer E-T-C-S-L-V architecture). Model makes cognitive decisions (tool selection, reasoning, expression); Harness provides engineering guardrails (validation, budget, state, safety). Architecture unified — single execution path through AgentHarness → LoopController. 25 declarative tools across 8 categories, 132 Harness tests passing, 4-platform integration gateway.

## Product Direction (all phases complete)

| Was (v3.x) | Now (v5.0) |
|-----|---------|
| Rule-based intent recognition | LLM Function Calling via Harness ToolRegistry |
| PersonaRules as tone gate | Constitutional AI (persona in system prompt) |
| Hidden memory logic | Infrastructure-as-Tools (25 tools, 8 categories) |
| User-driven (wait for input) | Proactive loop (ScenarioAwareScheduler + triggers) |
| Hardcoded template responses | LLM-generated with memory-grounded context |
| Feature checklist mindset | Harness Agent Framework — engineering guardrails for LLM |
| Uncontrolled tool loops | Four-dimensional budget control (rounds/tokens/time/tool-calls) |
| No self-awareness | Quality scoring + evolution feedback + auto-optimization |

## Commands

```bash
# Development
npm run dev              # Start with nodemon (watches src/, runs ts-node src/main.ts)
npm start                # Start both backend and frontend concurrently
npm run start:backend    # Backend only (ts-node src/main.ts)
npm run start:frontend   # Frontend React dev server (port 3000)

# Build
npm run build            # tsc (full build)
npm run build:fast       # tsc with tsconfig.fast.json

# Testing
npm test                 # Jest (all tests)
npm run test:watch       # Jest --watch
npm run test:coverage    # Jest with coverage
npm run test:integration # Integration tests only
npm run test:e2e         # Cypress e2e tests
npm run test:all         # Full test suite via bash script

# Code quality
npm run lint             # ESLint
npm run lint:fix         # ESLint with auto-fix
npm run format           # Prettier write
npm run format:check     # Prettier check (CI-safe)
npm run check            # lint + format:check + test
npm run check:all        # Full CI check

# Security
npm run security:scan    # Snyk test
npm run security:audit   # npm audit
```

## Architecture

### Current Architecture (v5.0 — Harness Agent Framework)

Six-layer E-T-C-S-L-V Harness: the model makes cognitive decisions; the Harness provides engineering guardrails.

```
                     ┌──────────────────────────────┐
                     │     Gateway Layer（接入层）     │
                     │  Express HTTP + WebSocket      │
                     │  4-platform unified gateway    │
                     └──────────────┬───────────────┘
                                    │
         ┌──────────────────────────┼──────────────────────────┐
         │              Agent Harness（六层核心）                 │
         │                                                      │
         │   E — Execution Loop — "Heartbeat"                   │
         │   Planner → Executor → Evaluator → Reporter          │
         │   Plan-Execute-Evaluate state machine + replan        │
         │                                                      │
         │   T — Tool Registry — "Capability Catalog"           │
         │   8 categories, 25 declarative tools + Schema + Auth │
         │                                                      │
         │   C — Context Manager — "Memory Steward"             │
         │   Composable pipeline: Constitution → Memory →       │
         │   Dynamic Context → History + Token Budget Allocator │
         │                                                      │
         │   S — State Store — "RAM & Disk"                     │
         │   SQLite + ChromaDB, 3-tier memory (instant/short/long) │
         │                                                      │
         │   L — Lifecycle Hooks — "Guard Posts"                │
         │   9 hooks: before/after tool_call, on_error, etc.    │
         │                                                      │
         │   V — Evaluation Interface — "Scorecard & Dashboard" │
         │   Tool validation + safety check + 5-dim quality     │
         └──────────────────────────────────────────────────────┘
                                    │
                     ┌──────────────┴───────────────┐
                     │   Infrastructure Layer       │
                     │   Model / Scheduler / Evolution │
                     │   Security / Skills / Memory  │
                     └──────────────────────────────┘
```

**LLM vs Harness Responsibility Split:**

| LLM Responsibilities | Harness Responsibilities |
|---------------------|--------------------------|
| Creativity & reasoning | Persistence (memory, state) |
| Natural language understanding | Time-sense injection |
| Tool selection (Function Calling) | Budget control (4-dimensional) |
| Multi-step reasoning (ReAct) | Tool result validation + safety check |
| Personalized expression | Quality scoring (5 dimensions) |
| Scene adaptation | Lifecycle hooks + permission guard |
| Safety judgment (RLHF) | Architecture guardrails + audit |

### Key Architecture Decisions

| Decision | Rationale |
|----------|-----------|
| **Harness as OS** | Six-layer engineering framework wraps LLM uncertainty in deterministic guardrails |
| **Constraint, don't instruct** | Harness sets boundaries (budget, permissions, validation), doesn't tell model how to think |
| **State externalized** | Agent holds no internal state — all state in LoopContext managed by Harness |
| **Infrastructure-as-Tools** | Memory, emotion, scene, desktop, code exposed as declarative FC tools (8 categories, 25 tools) |
| **Constitutional AI** | Persona defined in system prompt, not post-processed (LLM generates in character) |
| **Budget Control** | Soft (4-round) + Hard (8-round) + Token (4500) + Time (60s) four-dimensional limits |
| **Rippable Architecture** | Each Harness layer independently toggleable — peel away as model capability improves |
| **Declarative Tools** | JSON Schema parameters + risk level + required permissions + idempotency + timeout per tool |
| **Dual-write Compatibility** | Harness ToolRegistry syncs to legacy SkillRegistry for backward compatibility |

### Phase Completion Status

| Phase | Goal | Completion | Key Implementation |
|-------|------|------------|-------------------|
| Phase 1-7: Foundation | LLM-First, FC loop, budget, memory, proactive | 100% | JiabaixingCore, LLMProvider, SkillRegistry |
| **Phase 8: Harness Framework** | **Six-layer E-T-C-S-L-V Harness** | **100%** | AgentHarness, LoopController, ToolRegistry, ContextManager, PersistenceService, VerificationService, ConstraintsService |
| **Phase 9: Full Integration** | **Harness wired into all pathways** | **100%** | JiabaixingCore → Harness routing, gateway → Harness, dual-write compatibility |
| Phase 10: Multi-Agent | Multi-agent orchestration | Planning | TBD |
| Phase 11: Self-Evaluation | Auto-evaluation pipeline + continuous optimization | Planning | TBD |

### Key Infrastructure

- **AgentHarness** (`src/harness/AgentHarness.ts`) — Six-layer assembly entry point. Dependency injection, feature toggle control (6 switches), lifecycle hook registration.
  - **LoopController** (`src/harness/loop/LoopController.ts`) — Plan-Execute-Evaluate state machine with replan support (max 1 retry), budget checking, 4-dimensional limits.
  - **Planner / Executor / Evaluator / Reporter** (`src/harness/loop/`) — Four-phase loop nodes.
  - **ToolRegistry** (`src/harness/tools/registry/ToolRegistry.ts`) — Declarative tool registry: 25 tools, 8 categories, OpenAI format conversion with caching.
  - **SchemaValidator** + **PermissionGuard** (`src/harness/tools/registry/`) — JSON Schema validation + permission grading (low/medium/high/critical).
  - **ContextManager** (`src/harness/context/ContextManager.ts`) — Composable context pipeline: Constitution → Memory → Dynamic → History.
  - **TokenBudgetAllocator** (`src/harness/context/TokenBudgetAllocator.ts`) — Token budget across 6 allocation buckets.
  - **PersistenceService** (`src/harness/persistence/PersistenceService.ts`) — Unified persistence: memory + task state + user profile + evolution metrics.
  - **VerificationService** (`src/harness/verification/VerificationService.ts`) — Tool result validation + safety check + 5-dim quality scoring.
  - **ConstraintsService** (`src/harness/constraints/ConstraintsService.ts`) — Budget control + permission check + 9 lifecycle hooks.
- **JiabaixingCore** (`src/core/JiabaixingCore.ts`) — System controller. Delegates processing to AgentHarness; manages memory, scheduler, evolution components.
  - **ConstitutionPromptBuilder** (`src/core/ConstitutionPromptBuilder.ts`) — Dynamic system prompt construction.
  - **MemoryAssistant** (`src/core/MemoryAssistant.ts`) — Memory retrieval, deduplication, auto knowledge extraction.
  - **ScenarioAwareScheduler** (`src/core/ScenarioAwareScheduler.ts`) — Proactive scheduling with cron polling.
- **LLMProvider** (`src/models/LLMProvider.ts`) — LLM interface. chatWithTools (FC loop), chat (fallback), model selection.
- **SkillRegistry** (`src/skills/SkillRegistry.ts`) — Legacy skill registry. Receives Harness tools via dual-write compatibility layer.
- **MemoryEngine** (`src/memory/MemoryEngine.ts`) — Memory storage. SQLite + ChromaDB, 3-tier memory (instant/short/long). Delegates to:
  - **MemoryRetriever** (`src/memory/MemoryRetriever.ts`) — Hybrid retrieval (keyword + vector + RRF fusion)
  - **MemoryTracker** (`src/memory/MemoryTracker.ts`) — Validation + tracking
- **PersonaRules** (`src/persona/PersonaRules.ts`) — Persona definition. Builds constitutional prompt.
- **EventBus** (`src/shared/EventBus.ts`) — Cross-module communication, WebSocket bridging.
- **IntegrationManager** (`src/integration/IntegrationManager.ts`) — Multi-platform gateway (WeChat QR/API, QQ Mirai, Feishu, DingTalk).

### Frontend (`src/frontend/`)

React 18 + TypeScript chat interface with 14 panels: ChatInterface, IntegrationPanel, AutomationPanel, EvolutionPanel, SecurityPanel, MemoryPanel, SkillConsole, DesktopPanel, MonitorPanel, PerformancePanel, AgentExecutionPanel, LogPanel, SettingsPanel, VibeCodingPanel. State management via Zustand + Context API. The frontend has its own `node_modules` and `package.json` — install dependencies inside `src/frontend/`.

## Key Design Decisions

**Constraint, not instruction.** Harness sets boundaries (budget, permissions, validation), doesn't tell model how to reason. The model makes cognitive decisions; Harness provides engineering guardrails.

**State externalized.** Agent holds no internal state. All state lives in LoopContext, managed by Harness. The Agent can resume from any saved state checkpoint.

**Infrastructure-as-Tools.** Memory, emotion, scene, desktop, code are declarative FC tools (25 tools, 8 categories). LLM decides when to call them.

**Constitutional AI.** Persona is defined in system prompt (age 28, mature secretary, behavior rules), not post-processed. LLM generates responses in character naturally.

**Budget Control.** Four dimensions: rounds (soft 4, hard 8), tokens (warn 4500, hard 6000), time (60s max), tool calls (20 max). Budget exceeded triggers lifecycle hooks for graceful degradation.

**Rippable Architecture.** Each of the 6 Harness layers is independently toggleable. As model capability improves, layers can be peeled away, converging toward pure-model-driven system.

**Declarative Tools.** Every tool defined with JSON Schema parameters, risk level (low/medium/high/critical), required permissions, idempotency flag, and timeout. SchemaValidator + PermissionGuard enforce before execution.

**Dual-write Compatibility.** Harness ToolRegistry syncs to legacy SkillRegistry, ensuring existing skills continue working during transition.

## Environment

```
OPENAI_API_BASE=http://127.0.0.1:8001/v1    # LLM.server (OpenAI-compatible)
OPENAI_API_KEY=not-needed
LLM_MODEL=qwen2.5:3b                          # QWEN 2.5 3B multimodal
API_PORT=3111                                  # Backend server port
ENABLE_AUTO_OPTIMIZE=true                      # Self-evolution scheduler
```

## Tech Stack

- **TypeScript 6.0.2** — ES2022 target, CommonJS modules
- **Node.js + Express + WebSocket** — backend server on port 3111
- **React 18** — frontend chat UI (port 3000 dev server)
- **SQLite + Chroma** — memory storage (short-term + vector)
- **OpenAI-compatible API** — LLM interface (local LLM.server)
- **Whisper** — local speech recognition (faster-whisper / openai-whisper)
- **Jest + ts-jest** — testing (\~79% coverage)
- **ESLint v9** — flat config, no explicit `any`, no floating promises
- **Prettier** — single quotes, trailing commas (es5), 80 char width

## API Endpoints

```
POST /api/process          # Main chat endpoint
POST /api/upload           # File upload (PDF/DOCX/XLSX/Images)
POST /api/voice/upload     # Voice upload for transcription
POST /api/skills/execute   # Direct skill execution
GET  /api/skills/list      # Get all registered skills
POST /api/skills/register  # Register external skill
GET  /api/evolution/metrics    # Evolution metrics
GET  /api/evolution/insights   # Learning insights
POST /api/evolution/trigger    # Manual optimization trigger
GET  /api/health           # Health check
GET  /api/security/report  # Security audit report
```

## Testing

Tests live in `tests/` at project root (not co-located). Coverage threshold in `tests/coverage/coverage-config`. Core modules (MemoryEngine, DAG tasks) above 90% coverage.

## Refactoring Context

The codebase has been restructured to v5.0 Harness Agent Framework. Key changes when working in this repo:

1. **Harness Agent Framework** — Six-layer E-T-C-S-L-V architecture wraps LLM in engineering guardrails
2. **Architecture Unified** — Old components removed (DirectExecutor, ToolExecutor, FC Loop, src/tools/, SkillBridge). Single execution path: JiabaixingCore → AgentHarness → LoopController.
3. **State Externalized** — Agent holds no internal state; LoopContext carries everything
4. **25 Declarative Tools** — 8 categories (memory/cognition/desktop/file/code/system/daily/network) with JSON Schema + permissions + risk levels
5. **Plan-Execute-Evaluate** — State machine with replan support (max 1 retry), budget checking, lifecycle hooks
6. **Dual-write Compatibility** — Harness ToolRegistry syncs to legacy SkillRegistry
7. **6 Feature Switches** — Each Harness layer independently toggleable via HarnessConfig
8. **4-Platform Gateway** — WeChat (QR + API), QQ (Mirai), Feishu, DingTalk. Isolated worker mode with inline fallback.
9. **Type Safety** — Core modules use typed interfaces; JiabaixingCore.harness field currently `unknown` (needs typing fix)
10. **Performance** — EventBus.getTraceStatistics O(n²)→O(n), 3 new DB indexes, 8 setInterval leaks fixed

## Working with This Codebase

**Before implementing new features:**

1. Check if similar functionality already exists (grep for keywords)
2. Prefer extending existing Harness layers over creating new execution paths
3. Use the EventBus for cross-module communication (don't create direct dependencies)
4. New tools: add a definition file in `src/harness/tools/<category>/`, then register in `registerHarnessTools.ts`
5. New capabilities should be registered as declarative tools in ToolRegistry, not hidden logic
6. Always run `npm run build:fast` before committing

**Common patterns:**

- Error handling: Use `Logger.error()` with context, never throw unhandled
- Async: Always `await` or `.catch()`, never floating promises
- Types: No `any` — use `unknown` with type guards if needed; prefer typed interfaces over `as unknown as`
- Memory: Auto-injected via ContextManager pipeline; LLM can call memory_recall tool for more
- Safety: PersonaRules builds constitutional prompt; VerificationService handles output safety checks
- Harness Loop: Plan-Execute-Evaluate state machine; budget limits: rounds (soft 4, hard 8), tokens (warn 4500, hard 6000), time (60s), tool calls (20)
- Tools: Declarative definition (JSON Schema + risk level + permissions + idempotency + timeout) required for each new tool

