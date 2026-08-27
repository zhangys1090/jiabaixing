/**
 * Harness 工具注册编排器
 *
 * 将 25 个独立工具模块注册到 ToolRegistry
 * 同时支持注册到旧版 SkillRegistry（双写兼容）
 */

import { SkillRegistry } from '../../skills/SkillRegistry';
import { Logger } from '../../utils/Logger';
import { Permission } from '../types';
import { PermissionGuard } from './registry/PermissionGuard';
import { SchemaValidator } from './registry/SchemaValidator';
import { ToolRegistry } from './registry/ToolRegistry';

// === 记忆工具 ===
import { MEMORY_RECALL_DEF } from './memory/memory_recall';
import { MEMORY_SEARCH_DEF } from './memory/memory_search';
import { MEMORY_STORE_DEF } from './memory/memory_store';

// === 认知工具 ===
import { EMOTION_DETECT_DEF } from './cognition/emotion_detect';
import { SCENE_ANALYZE_DEF } from './cognition/scene_analyze';
import { SELF_REFLECT_DEF } from './cognition/self_reflect';

// === 桌面工具 ===
import { DESKTOP_AUTOMATE_DEF } from './desktop/desktop_automate';
import { DESKTOP_SCREENSHOT_DEF } from './desktop/desktop_screenshot';

// === 系统工具 ===
import { ASK_CLARIFICATION_DEF } from './system/ask_clarification';
import { PREVIEW_EXECUTION_DEF } from './system/preview_execution';
import { ROLLBACK_CHANGES_DEF } from './system/rollback_changes';

// === 文件工具 ===
import { FILE_DEDUP_DEF } from './file/file_dedup';
import { FILE_GREP_DEF } from './file/file_grep';
import { FILE_LIST_DEF } from './file/file_list';
import { FILE_READ_DEF } from './file/file_read';
import { FILE_SEARCH_DEF } from './file/file_search';
import { GET_ACTIVE_FILE_DEF } from './file/get_active_file';
import { INCREMENTAL_EDIT_DEF } from './file/incremental_edit';
import { MULTI_FILE_EDIT_DEF } from './file/multi_file_edit';
import {
  SUBDIRECTORY_HINTS_DEF,
  createSubdirectoryHintsExecutor,
} from './file/subdirectory_hints';

// === 代码工具 ===
import { CODE_ANALYZE_DEF } from './code/code_analyze';
import { CODE_FIX_DEF } from './code/code_fix';
import { CODE_GENERATE_DEF } from './code/code_generate';
import {
  CODE_REVIEW_DEF,
  createCodeReviewExecutor,
  type CodeReviewDeps,
} from './code/code_review';
import {
  CODE_REVIEW_PROJECT_DEF,
  createCodeReviewProjectExecutor,
} from './code/code_review_project';
import { CSV_ANALYZE_DEF, createCsvAnalyzeExecutor } from './code/csv_analyze';

// === 日常管理工具 ===
import { BATCH_TASK_DEF } from './daily/batch_task';
import { CALENDAR_DEF } from './daily/calendar';
import {
  MORNING_BRIEF_DEF,
  createMorningBriefExecutor,
  type MorningBriefDeps,
} from './daily/morning_brief';
import {
  NATURAL_SCHEDULE_DEF,
  createNaturalScheduleExecutor,
} from './daily/natural_schedule';
import { NOTE_TAKE_DEF } from './daily/note_take';
import { REMINDER_SET_DEF } from './daily/reminder_set';
import { SYSTEM_STATUS_DEF } from './daily/system_status';
import { TASK_ANALYTICS_DEF } from './daily/task_analytics';
import { TASK_DEPENDENCY_DEF } from './daily/task_dependency';
import { TASK_MANAGE_DEF } from './daily/task_manage';
import { TASK_PRIORITY_DEF } from './daily/task_priority';
import {
  KNOWLEDGE_QUERY_DEF,
  createKnowledgeQueryExecutor,
  type KnowledgeQueryDeps,
} from './memory/knowledge_query';
import { SKILL_SHARE_DEF, createSkillShareExecutor } from './skill/skill_share';

// === 网络工具 ===
import { CHART_GENERATE_DEF } from './network/chart_generate';
import { IMAGE_GENERATE_DEF } from './network/image_generate';
import { MESSAGE_PUSH_DEF } from './network/message_push';
import { SKILL_CREATE_DEF } from './network/skill_create';
import { TTS_SPEAK_DEF } from './network/tts_speak';
import { WEB_FETCH_DEF } from './network/web_fetch';
import { WEB_SEARCH_DEF } from './network/web_search';

// === 系统工具(扩展) ===
import { CONTEXT_MANAGE_DEF } from './system/context_manage';
import {
  DELEGATE_TASK_DEF,
  createDelegateTaskExecutor,
} from './system/delegate_task';
import {
  DISK_CLEANUP_DEF,
  createDiskCleanupExecutor,
} from './system/disk_cleanup';
import {
  EXECUTE_CODE_DEF,
  createExecuteCodeExecutor,
  type ExecuteCodeDeps,
} from './system/execute_code';
import { OSV_SCAN_DEF, createOsvScanExecutor } from './system/osv_scan';
import { SHELL_EXEC_DEF } from './system/shell_exec';
import {
  SHELL_GENERATE_DEF,
  createShellGenerateExecutor,
} from './system/shell_generate';
import {
  VOICE_INTERACT_DEF,
  createVoiceInteractExecutor,
  type VoiceInteractDeps,
} from './system/voice_interact';

// === T0/T1/T2 新增工具 ===
import {
  BUDGET_MANAGE_DEF,
  createBudgetManageExecutor,
} from './system/budget_manage';
import {
  CONVERSATION_COMPRESSION_DEF,
  createConversationCompressionExecutor,
  type ConversationCompressionDeps,
} from './system/conversation_compression';
import { LAZY_DEPS_DEF, createLazyDepsExecutor } from './system/lazy_deps';
import {
  RESULT_CACHE_DEF,
  createResultCacheExecutor,
} from './system/result_cache';
import {
  SECURITY_GUIDANCE_DEF,
  createSecurityGuidanceExecutor,
} from './system/security_guidance';
import {
  TODO_MANAGE_DEF,
  createTodoManageExecutor,
} from './system/todo_manage';
import {
  WRITE_APPROVAL_DEF,
  createWriteApprovalExecutor,
  type WriteApprovalDeps,
} from './system/write_approval';

// === T3 新增工具 ===
import {
  PROJECT_MANAGER_DEF,
  createProjectManagerExecutor,
} from './system/project_manager';

// ── LSP 工具定义与执行器 ──
import {
  LSP_COMPLETION_DEF,
  createLspCompletionExecutor,
  type LspCompletionDeps,
} from './lsp/lsp_completion';
import {
  LSP_DEFINITION_DEF,
  createLspDefinitionExecutor,
  type LspDefinitionDeps,
} from './lsp/lsp_definition';
import {
  LSP_DIAGNOSTICS_DEF,
  createLspDiagnosticsExecutor,
  type LspDiagnosticsDeps,
} from './lsp/lsp_diagnostics';
import {
  LSP_HOVER_DEF,
  createLspHoverExecutor,
  type LspHoverDeps,
} from './lsp/lsp_hover';
import {
  LSP_REFERENCES_DEF,
  createLspReferencesExecutor,
  type LspReferencesDeps,
} from './lsp/lsp_references';
import {
  LSP_SYMBOLS_DEF,
  createLspSymbolsExecutor,
  type LspSymbolsDeps,
} from './lsp/lsp_symbols';

// === 元工具（动态工具自创造） ===
import { TOOL_DEFINE_DEF, createToolDefineExecutor } from './meta/tool_define';
import {
  TOOL_INSPECT_DEF,
  createToolInspectExecutor,
} from './meta/tool_inspect';
import {
  TOOL_UNDEFINE_DEF,
  createToolUndefineExecutor,
} from './meta/tool_undefine';

// === 工具执行器工厂 ===
import {
  createCodeAnalyzeExecutor,
  type CodeAnalyzeDeps,
} from './code/code_analyze';
import { createCodeFixExecutor, type CodeFixDeps } from './code/code_fix';
import {
  createCodeGenerateExecutor,
  type CodeGenerateDeps,
} from './code/code_generate';
import {
  createEmotionDetectExecutor,
  type EmotionDetectDeps,
} from './cognition/emotion_detect';
import {
  createSceneAnalyzeExecutor,
  type SceneAnalyzeDeps,
} from './cognition/scene_analyze';
import {
  createSelfReflectExecutor,
  type SelfReflectDeps,
} from './cognition/self_reflect';
import { createDesktopAutomateExecutor } from './desktop/desktop_automate';
import {
  createDesktopScreenshotExecutor,
  type DesktopScreenshotDeps,
} from './desktop/desktop_screenshot';
import { createFileDedupExecutor } from './file/file_dedup';
import { createFileGrepExecutor, type FileGrepDeps } from './file/file_grep';
import { createFileListExecutor, type FileListDeps } from './file/file_list';
import { createFileReadExecutor, type FileReadDeps } from './file/file_read';
import {
  createFileSearchExecutor,
  type FileSearchDeps,
} from './file/file_search';
import {
  createGetActiveFileExecutor,
  type GetActiveFileDeps,
} from './file/get_active_file';
import {
  createIncrementalEditExecutor,
  type IncrementalEditDeps,
} from './file/incremental_edit';
import {
  createMultiFileEditExecutor,
  type MultiFileEditDeps,
} from './file/multi_file_edit';
import {
  createMemoryRecallExecutor,
  type MemoryRecallDeps,
} from './memory/memory_recall';
import {
  createMemorySearchExecutor,
  type MemorySearchDeps,
} from './memory/memory_search';
import {
  createMemoryStoreExecutor,
  type MemoryStoreDeps,
} from './memory/memory_store';
import { createAskClarificationExecutor } from './system/ask_clarification';
import { createPreviewExecutionExecutor } from './system/preview_execution';
import {
  createRollbackChangesExecutor,
  type RollbackChangesDeps,
} from './system/rollback_changes';

// === 日常管理工具执行器工厂 ===
import {
  createBatchTaskExecutor,
  type BatchTaskDeps,
} from './daily/batch_task';
import { createCalendarExecutor, type CalendarDeps } from './daily/calendar';
import { createNoteTakeExecutor, type NoteTakeDeps } from './daily/note_take';
import {
  createReminderSetExecutor,
  type ReminderSetDeps,
} from './daily/reminder_set';
import {
  createSystemStatusExecutor,
  type SystemStatusDeps,
} from './daily/system_status';
import {
  createTaskAnalyticsExecutor,
  type TaskAnalyticsDeps,
} from './daily/task_analytics';
import {
  createTaskDependencyExecutor,
  type TaskDependencyDeps,
} from './daily/task_dependency';
import {
  createTaskManageExecutor,
  type TaskManageDeps,
} from './daily/task_manage';
import {
  createTaskPriorityExecutor,
  type TaskPriorityDeps,
} from './daily/task_priority';

// === 网络工具执行器工厂 ===
import {
  createChartGenerateExecutor,
  type ChartGenerateDeps,
} from './network/chart_generate';
import {
  createImageGenerateExecutor,
  type ImageGenerateDeps,
} from './network/image_generate';
import {
  createMessagePushExecutor,
  type MessagePushDeps,
} from './network/message_push';
import {
  createSkillCreateExecutor,
  type SkillCreateDeps,
} from './network/skill_create';
import { createTTSSpeakExecutor, type TTSSpeakDeps } from './network/tts_speak';
import { createWebFetchExecutor, type WebFetchDeps } from './network/web_fetch';
import {
  createWebSearchExecutor,
  type WebSearchDeps,
} from './network/web_search';
import {
  createContextManageExecutor,
  type ContextManageDeps,
} from './system/context_manage';
import {
  createShellExecExecutor,
  type ShellExecDeps,
} from './system/shell_exec';

/** 所有工具依赖的聚合接口 */
export interface HarnessToolDeps
  extends
    MemoryRecallDeps,
    MemoryStoreDeps,
    MemorySearchDeps,
    EmotionDetectDeps,
    SceneAnalyzeDeps,
    SelfReflectDeps,
    DesktopScreenshotDeps,
    RollbackChangesDeps,
    IncrementalEditDeps,
    MultiFileEditDeps,
    FileReadDeps,
    FileSearchDeps,
    FileListDeps,
    FileGrepDeps,
    GetActiveFileDeps,
    CodeGenerateDeps,
    CodeAnalyzeDeps,
    CodeFixDeps,
    TaskManageDeps,
    TaskPriorityDeps,
    TaskDependencyDeps,
    BatchTaskDeps,
    TaskAnalyticsDeps,
    CalendarDeps,
    ReminderSetDeps,
    NoteTakeDeps,
    SystemStatusDeps,
    WebSearchDeps,
    SkillCreateDeps,
    WebFetchDeps,
    ImageGenerateDeps,
    TTSSpeakDeps,
    ShellExecDeps,
    ExecuteCodeDeps,
    ContextManageDeps,
    VoiceInteractDeps,
    ChartGenerateDeps,
    MessagePushDeps,
    LspDiagnosticsDeps,
    LspCompletionDeps,
    LspHoverDeps,
    LspDefinitionDeps,
    LspReferencesDeps,
    LspSymbolsDeps,
    WriteApprovalDeps,
    ConversationCompressionDeps {
  // 允许运行时动态挂载额外依赖（如 messageProcessor、i18nManager）
  [key: string]: unknown;
}

/** 工具注册结果 */
export interface ToolRegistrationResult {
  toolRegistry: ToolRegistry;
  schemaValidator: SchemaValidator;
  permissionGuard: PermissionGuard;
  registeredCount: number;
}

/**
 * 注册所有 Harness 工具到 ToolRegistry
 */
export function registerHarnessTools(
  deps: HarnessToolDeps
): ToolRegistrationResult {
  const toolRegistry = new ToolRegistry();
  const schemaValidator = new SchemaValidator();
  const permissionGuard = new PermissionGuard();

  // 记忆工具 (3)
  toolRegistry.register(MEMORY_RECALL_DEF, createMemoryRecallExecutor(deps));
  toolRegistry.register(MEMORY_STORE_DEF, createMemoryStoreExecutor(deps));
  toolRegistry.register(MEMORY_SEARCH_DEF, createMemorySearchExecutor(deps));

  // 认知工具 (3)
  toolRegistry.register(EMOTION_DETECT_DEF, createEmotionDetectExecutor(deps));
  toolRegistry.register(SCENE_ANALYZE_DEF, createSceneAnalyzeExecutor(deps));
  toolRegistry.register(SELF_REFLECT_DEF, createSelfReflectExecutor(deps));

  // 桌面工具 (2)
  toolRegistry.register(DESKTOP_AUTOMATE_DEF, createDesktopAutomateExecutor());
  toolRegistry.register(
    DESKTOP_SCREENSHOT_DEF,
    createDesktopScreenshotExecutor(deps)
  );

  // 文件工具 (6→7)
  toolRegistry.register(FILE_READ_DEF, createFileReadExecutor(deps));
  toolRegistry.register(GET_ACTIVE_FILE_DEF, createGetActiveFileExecutor(deps));
  toolRegistry.register(
    INCREMENTAL_EDIT_DEF,
    createIncrementalEditExecutor(deps)
  );
  toolRegistry.register(MULTI_FILE_EDIT_DEF, createMultiFileEditExecutor(deps));
  toolRegistry.register(FILE_SEARCH_DEF, createFileSearchExecutor(deps));
  toolRegistry.register(FILE_LIST_DEF, createFileListExecutor(deps));
  toolRegistry.register(FILE_GREP_DEF, createFileGrepExecutor(deps));
  toolRegistry.register(FILE_DEDUP_DEF, createFileDedupExecutor());
  toolRegistry.register(
    SUBDIRECTORY_HINTS_DEF,
    createSubdirectoryHintsExecutor()
  );

  // 代码工具 (3)
  toolRegistry.register(CODE_GENERATE_DEF, createCodeGenerateExecutor(deps));
  toolRegistry.register(CODE_ANALYZE_DEF, createCodeAnalyzeExecutor(deps));
  toolRegistry.register(CSV_ANALYZE_DEF, createCsvAnalyzeExecutor());

  // 代码审查工具
  const codeReviewDeps: CodeReviewDeps = { llm: deps.llm };
  toolRegistry.register(
    CODE_REVIEW_DEF,
    createCodeReviewExecutor(codeReviewDeps)
  );
  toolRegistry.register(
    CODE_REVIEW_PROJECT_DEF,
    createCodeReviewProjectExecutor(codeReviewDeps)
  );
  toolRegistry.register(CODE_FIX_DEF, createCodeFixExecutor(deps));

  // 日常管理工具 (9)
  toolRegistry.register(TASK_MANAGE_DEF, createTaskManageExecutor(deps));
  toolRegistry.register(TASK_PRIORITY_DEF, createTaskPriorityExecutor(deps));
  toolRegistry.register(
    TASK_DEPENDENCY_DEF,
    createTaskDependencyExecutor(deps)
  );
  toolRegistry.register(BATCH_TASK_DEF, createBatchTaskExecutor(deps));
  toolRegistry.register(TASK_ANALYTICS_DEF, createTaskAnalyticsExecutor(deps));

  // 晨报工具
  const morningBriefDeps: MorningBriefDeps = {
    llm: deps.llm,
    searchExecutor: (params, ctx) =>
      toolRegistry.execute(
        'web_search',
        params,
        ctx || { permissions: new Set(), metadata: {} }
      ),
  };
  toolRegistry.register(
    MORNING_BRIEF_DEF,
    createMorningBriefExecutor(morningBriefDeps)
  );

  // 自然语言调度工具
  toolRegistry.register(NATURAL_SCHEDULE_DEF, createNaturalScheduleExecutor());

  // Skill 分享工具
  toolRegistry.register(SKILL_SHARE_DEF, createSkillShareExecutor());

  // 知识查询工具
  const knowledgeDeps: KnowledgeQueryDeps = {
    memoryRecall: deps.retrieveRelevant
      ? async (query, limit) => {
          const results = await deps.retrieveRelevant!({ query, limit });
          return results.map((r) => {
            const item = r as {
              content: unknown;
              type?: string;
              timestamp?: Date;
              relevanceScore?: number;
            };
            return {
              content: item.content,
              type: item.type,
              timestamp: item.timestamp,
              relevanceScore: item.relevanceScore,
            };
          });
        }
      : undefined,
    // D1: 记忆召回不足时降级到 web_search（复用 HarnessToolDeps.searchEngine）
    webSearch: deps.searchEngine
      ? async (query, limit) => {
          const r = await deps.searchEngine!(query, {
            searchType: 'web',
            maxResults: limit,
            language: 'zh-CN',
          });
          return r.map((x) => ({
            content: x.snippet || x.title,
            source: x.url,
          }));
        }
      : undefined,
    // D1: 网络检索补强结果回填记忆（RAG 闭环），复用 MemoryStoreDeps.storeShortTermMemory
    memoryStore: deps.storeShortTermMemory
      ? async (query, content) => {
          await deps.storeShortTermMemory!(content, 'knowledge');
        }
      : undefined,
  };
  toolRegistry.register(
    KNOWLEDGE_QUERY_DEF,
    createKnowledgeQueryExecutor(knowledgeDeps)
  );
  toolRegistry.register(CALENDAR_DEF, createCalendarExecutor(deps));
  toolRegistry.register(REMINDER_SET_DEF, createReminderSetExecutor(deps));
  toolRegistry.register(NOTE_TAKE_DEF, createNoteTakeExecutor(deps));
  toolRegistry.register(SYSTEM_STATUS_DEF, createSystemStatusExecutor(deps));

  // 网络工具 (2→7)
  toolRegistry.register(WEB_SEARCH_DEF, createWebSearchExecutor(deps));
  toolRegistry.register(SKILL_CREATE_DEF, createSkillCreateExecutor(deps));
  toolRegistry.register(WEB_FETCH_DEF, createWebFetchExecutor(deps));
  toolRegistry.register(IMAGE_GENERATE_DEF, createImageGenerateExecutor(deps));
  toolRegistry.register(TTS_SPEAK_DEF, createTTSSpeakExecutor(deps));
  toolRegistry.register(CHART_GENERATE_DEF, createChartGenerateExecutor(deps));
  toolRegistry.register(MESSAGE_PUSH_DEF, createMessagePushExecutor(deps));

  // 系统工具(扩展) (3→4)
  toolRegistry.register(
    ASK_CLARIFICATION_DEF,
    createAskClarificationExecutor()
  );
  toolRegistry.register(
    PREVIEW_EXECUTION_DEF,
    createPreviewExecutionExecutor()
  );
  toolRegistry.register(
    ROLLBACK_CHANGES_DEF,
    createRollbackChangesExecutor(deps)
  );
  toolRegistry.register(SHELL_EXEC_DEF, createShellExecExecutor(deps));
  toolRegistry.register(EXECUTE_CODE_DEF, createExecuteCodeExecutor(deps));
  toolRegistry.register(
    SHELL_GENERATE_DEF,
    createShellGenerateExecutor({ llm: deps.llm })
  );
  toolRegistry.register(
    DELEGATE_TASK_DEF,
    createDelegateTaskExecutor({ llm: deps.llm!, toolRegistry })
  );
  toolRegistry.register(CONTEXT_MANAGE_DEF, createContextManageExecutor(deps));
  toolRegistry.register(VOICE_INTERACT_DEF, createVoiceInteractExecutor(deps));
  toolRegistry.register(OSV_SCAN_DEF, createOsvScanExecutor());
  toolRegistry.register(DISK_CLEANUP_DEF, createDiskCleanupExecutor());

  // T0 新增工具: todo_manage + write_approval
  toolRegistry.register(TODO_MANAGE_DEF, createTodoManageExecutor());
  toolRegistry.register(WRITE_APPROVAL_DEF, createWriteApprovalExecutor(deps));

  // T1 新增工具: lazy_deps + result_cache + conversation_compression
  toolRegistry.register(LAZY_DEPS_DEF, createLazyDepsExecutor());
  toolRegistry.register(RESULT_CACHE_DEF, createResultCacheExecutor());
  toolRegistry.register(
    CONVERSATION_COMPRESSION_DEF,
    createConversationCompressionExecutor({ llm: deps.llm })
  );

  // T2 新增工具: budget_manage + security_guidance
  toolRegistry.register(BUDGET_MANAGE_DEF, createBudgetManageExecutor());
  toolRegistry.register(
    SECURITY_GUIDANCE_DEF,
    createSecurityGuidanceExecutor()
  );

  // T3 新增工具: project_manager
  toolRegistry.register(PROJECT_MANAGER_DEF, createProjectManagerExecutor());

  // LSP 工具 (5) — Phase 2 集成
  toolRegistry.register(
    LSP_DIAGNOSTICS_DEF,
    createLspDiagnosticsExecutor(deps)
  );
  toolRegistry.register(LSP_COMPLETION_DEF, createLspCompletionExecutor(deps));
  toolRegistry.register(LSP_HOVER_DEF, createLspHoverExecutor(deps));
  toolRegistry.register(LSP_DEFINITION_DEF, createLspDefinitionExecutor(deps));
  toolRegistry.register(LSP_REFERENCES_DEF, createLspReferencesExecutor(deps));
  toolRegistry.register(LSP_SYMBOLS_DEF, createLspSymbolsExecutor(deps));

  // 元工具（动态工具自创造）
  const metaDeps = { toolRegistry };
  toolRegistry.register(TOOL_DEFINE_DEF, createToolDefineExecutor(metaDeps));
  toolRegistry.register(TOOL_INSPECT_DEF, createToolInspectExecutor(metaDeps));
  toolRegistry.register(
    TOOL_UNDEFINE_DEF,
    createToolUndefineExecutor(metaDeps)
  );

  Logger.info(
    `🔧 Harness 工具注册完成: ${toolRegistry.size} 个工具`,
    'HarnessToolRegistrar'
  );

  return {
    toolRegistry,
    schemaValidator,
    permissionGuard,
    registeredCount: toolRegistry.size,
  };
}

/**
 * 将 Harness 工具同步注册到旧版 SkillRegistry（双写兼容）
 * 确保 InfrastructureToolRegistrar 的功能不退化
 */
export function syncToLegacySkillRegistry(
  toolRegistry: ToolRegistry,
  skillRegistry: SkillRegistry
): void {
  const tools = toolRegistry.getAll();

  for (const tool of tools) {
    const def = tool.definition;
    skillRegistry.registerInfrastructureTool({
      name: def.name,
      description: def.description,
      parameters: Object.entries(def.parameters).map(
        ([name, paramDef]: [string, import('../types').ToolParameterDef]) => ({
          name,
          type: paramDef.type,
          required: def.requiredParams.includes(name),
          description: paramDef.description,
        })
      ),
      execute: async (args, context) => {
        const userPerms = context?.sessionData?.permissions;
        const permissions =
          Array.isArray(userPerms) && userPerms.length > 0
            ? new Set<Permission>(userPerms as Permission[])
            : new Set<Permission>([
                Permission.MEMORY_READ,
                Permission.MEMORY_WRITE,
                Permission.FILE_READ,
                Permission.FILE_WRITE,
                Permission.CODE_EXECUTE,
                Permission.NETWORK_ACCESS,
              ]);
        const toolContext: import('../types').ToolContext = {
          userId: context?.userId,
          traceId: context?.traceId,
          permissions,
          metadata: {},
        };
        const result = await tool.execute(args, toolContext);
        return {
          success: result.success,
          output: result.output,
          error: result.error,
          metadata: result.metadata,
        };
      },
    });
  }

  Logger.info(
    `🔄 已同步 ${tools.length} 个 Harness 工具到旧版 SkillRegistry`,
    'HarnessToolRegistrar'
  );
}
