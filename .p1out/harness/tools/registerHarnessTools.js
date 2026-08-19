"use strict";
/**
 * Harness 工具注册编排器
 *
 * 将 25 个独立工具模块注册到 ToolRegistry
 * 同时支持注册到旧版 SkillRegistry（双写兼容）
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerHarnessTools = registerHarnessTools;
exports.syncToLegacySkillRegistry = syncToLegacySkillRegistry;
const Logger_1 = require("../../utils/Logger");
const types_1 = require("../types");
const PermissionGuard_1 = require("./registry/PermissionGuard");
const SchemaValidator_1 = require("./registry/SchemaValidator");
const ToolRegistry_1 = require("./registry/ToolRegistry");
// === 记忆工具 ===
const memory_recall_1 = require("./memory/memory_recall");
const memory_search_1 = require("./memory/memory_search");
const memory_store_1 = require("./memory/memory_store");
// === 认知工具 ===
const emotion_detect_1 = require("./cognition/emotion_detect");
const scene_analyze_1 = require("./cognition/scene_analyze");
const self_reflect_1 = require("./cognition/self_reflect");
// === 桌面工具 ===
const desktop_automate_1 = require("./desktop/desktop_automate");
const desktop_screenshot_1 = require("./desktop/desktop_screenshot");
// === 系统工具 ===
const ask_clarification_1 = require("./system/ask_clarification");
const preview_execution_1 = require("./system/preview_execution");
const rollback_changes_1 = require("./system/rollback_changes");
// === 文件工具 ===
const file_dedup_1 = require("./file/file_dedup");
const file_grep_1 = require("./file/file_grep");
const file_list_1 = require("./file/file_list");
const file_read_1 = require("./file/file_read");
const file_search_1 = require("./file/file_search");
const get_active_file_1 = require("./file/get_active_file");
const incremental_edit_1 = require("./file/incremental_edit");
const multi_file_edit_1 = require("./file/multi_file_edit");
const subdirectory_hints_1 = require("./file/subdirectory_hints");
// === 代码工具 ===
const code_analyze_1 = require("./code/code_analyze");
const code_fix_1 = require("./code/code_fix");
const code_generate_1 = require("./code/code_generate");
const code_review_1 = require("./code/code_review");
const code_review_project_1 = require("./code/code_review_project");
const csv_analyze_1 = require("./code/csv_analyze");
// === 日常管理工具 ===
const batch_task_1 = require("./daily/batch_task");
const calendar_1 = require("./daily/calendar");
const morning_brief_1 = require("./daily/morning_brief");
const natural_schedule_1 = require("./daily/natural_schedule");
const note_take_1 = require("./daily/note_take");
const reminder_set_1 = require("./daily/reminder_set");
const system_status_1 = require("./daily/system_status");
const task_analytics_1 = require("./daily/task_analytics");
const task_dependency_1 = require("./daily/task_dependency");
const task_manage_1 = require("./daily/task_manage");
const task_priority_1 = require("./daily/task_priority");
const knowledge_query_1 = require("./memory/knowledge_query");
const skill_share_1 = require("./skill/skill_share");
// === 网络工具 ===
const chart_generate_1 = require("./network/chart_generate");
const image_generate_1 = require("./network/image_generate");
const message_push_1 = require("./network/message_push");
const skill_create_1 = require("./network/skill_create");
const tts_speak_1 = require("./network/tts_speak");
const web_fetch_1 = require("./network/web_fetch");
const web_search_1 = require("./network/web_search");
// === 系统工具(扩展) ===
const context_manage_1 = require("./system/context_manage");
const delegate_task_1 = require("./system/delegate_task");
const disk_cleanup_1 = require("./system/disk_cleanup");
const execute_code_1 = require("./system/execute_code");
const osv_scan_1 = require("./system/osv_scan");
const shell_exec_1 = require("./system/shell_exec");
const shell_generate_1 = require("./system/shell_generate");
const voice_interact_1 = require("./system/voice_interact");
// === T0/T1/T2 新增工具 ===
const budget_manage_1 = require("./system/budget_manage");
const conversation_compression_1 = require("./system/conversation_compression");
const lazy_deps_1 = require("./system/lazy_deps");
const result_cache_1 = require("./system/result_cache");
const security_guidance_1 = require("./system/security_guidance");
const todo_manage_1 = require("./system/todo_manage");
const write_approval_1 = require("./system/write_approval");
// === T3 新增工具 ===
const project_manager_1 = require("./system/project_manager");
// === 元工具（动态工具自创造） ===
const tool_define_1 = require("./meta/tool_define");
const tool_inspect_1 = require("./meta/tool_inspect");
const tool_undefine_1 = require("./meta/tool_undefine");
// ── LSP 工具定义与执行器 ──
const lsp_completion_1 = require("./lsp/lsp_completion");
const lsp_definition_1 = require("./lsp/lsp_definition");
const lsp_diagnostics_1 = require("./lsp/lsp_diagnostics");
const lsp_hover_1 = require("./lsp/lsp_hover");
const lsp_references_1 = require("./lsp/lsp_references");
const lsp_symbols_1 = require("./lsp/lsp_symbols");
// === 工具执行器工厂 ===
const code_analyze_2 = require("./code/code_analyze");
const code_fix_2 = require("./code/code_fix");
const code_generate_2 = require("./code/code_generate");
const emotion_detect_2 = require("./cognition/emotion_detect");
const scene_analyze_2 = require("./cognition/scene_analyze");
const self_reflect_2 = require("./cognition/self_reflect");
const desktop_automate_2 = require("./desktop/desktop_automate");
const desktop_screenshot_2 = require("./desktop/desktop_screenshot");
const file_dedup_2 = require("./file/file_dedup");
const file_grep_2 = require("./file/file_grep");
const file_list_2 = require("./file/file_list");
const file_read_2 = require("./file/file_read");
const file_search_2 = require("./file/file_search");
const get_active_file_2 = require("./file/get_active_file");
const incremental_edit_2 = require("./file/incremental_edit");
const multi_file_edit_2 = require("./file/multi_file_edit");
const memory_recall_2 = require("./memory/memory_recall");
const memory_search_2 = require("./memory/memory_search");
const memory_store_2 = require("./memory/memory_store");
const ask_clarification_2 = require("./system/ask_clarification");
const preview_execution_2 = require("./system/preview_execution");
const rollback_changes_2 = require("./system/rollback_changes");
// === 日常管理工具执行器工厂 ===
const batch_task_2 = require("./daily/batch_task");
const calendar_2 = require("./daily/calendar");
const note_take_2 = require("./daily/note_take");
const reminder_set_2 = require("./daily/reminder_set");
const system_status_2 = require("./daily/system_status");
const task_analytics_2 = require("./daily/task_analytics");
const task_dependency_2 = require("./daily/task_dependency");
const task_manage_2 = require("./daily/task_manage");
const task_priority_2 = require("./daily/task_priority");
// === 网络工具执行器工厂 ===
const chart_generate_2 = require("./network/chart_generate");
const image_generate_2 = require("./network/image_generate");
const message_push_2 = require("./network/message_push");
const skill_create_2 = require("./network/skill_create");
const tts_speak_2 = require("./network/tts_speak");
const web_fetch_2 = require("./network/web_fetch");
const web_search_2 = require("./network/web_search");
const context_manage_2 = require("./system/context_manage");
const shell_exec_2 = require("./system/shell_exec");
/**
 * 注册所有 Harness 工具到 ToolRegistry
 */
function registerHarnessTools(deps) {
    const toolRegistry = new ToolRegistry_1.ToolRegistry();
    const schemaValidator = new SchemaValidator_1.SchemaValidator();
    const permissionGuard = new PermissionGuard_1.PermissionGuard();
    // 记忆工具 (3)
    toolRegistry.register(memory_recall_1.MEMORY_RECALL_DEF, (0, memory_recall_2.createMemoryRecallExecutor)(deps));
    toolRegistry.register(memory_store_1.MEMORY_STORE_DEF, (0, memory_store_2.createMemoryStoreExecutor)(deps));
    toolRegistry.register(memory_search_1.MEMORY_SEARCH_DEF, (0, memory_search_2.createMemorySearchExecutor)(deps));
    // 认知工具 (3)
    toolRegistry.register(emotion_detect_1.EMOTION_DETECT_DEF, (0, emotion_detect_2.createEmotionDetectExecutor)(deps));
    toolRegistry.register(scene_analyze_1.SCENE_ANALYZE_DEF, (0, scene_analyze_2.createSceneAnalyzeExecutor)(deps));
    toolRegistry.register(self_reflect_1.SELF_REFLECT_DEF, (0, self_reflect_2.createSelfReflectExecutor)(deps));
    // 桌面工具 (2)
    toolRegistry.register(desktop_automate_1.DESKTOP_AUTOMATE_DEF, (0, desktop_automate_2.createDesktopAutomateExecutor)());
    toolRegistry.register(desktop_screenshot_1.DESKTOP_SCREENSHOT_DEF, (0, desktop_screenshot_2.createDesktopScreenshotExecutor)(deps));
    // 文件工具 (6→7)
    toolRegistry.register(file_read_1.FILE_READ_DEF, (0, file_read_2.createFileReadExecutor)(deps));
    toolRegistry.register(get_active_file_1.GET_ACTIVE_FILE_DEF, (0, get_active_file_2.createGetActiveFileExecutor)(deps));
    toolRegistry.register(incremental_edit_1.INCREMENTAL_EDIT_DEF, (0, incremental_edit_2.createIncrementalEditExecutor)(deps));
    toolRegistry.register(multi_file_edit_1.MULTI_FILE_EDIT_DEF, (0, multi_file_edit_2.createMultiFileEditExecutor)(deps));
    toolRegistry.register(file_search_1.FILE_SEARCH_DEF, (0, file_search_2.createFileSearchExecutor)(deps));
    toolRegistry.register(file_list_1.FILE_LIST_DEF, (0, file_list_2.createFileListExecutor)(deps));
    toolRegistry.register(file_grep_1.FILE_GREP_DEF, (0, file_grep_2.createFileGrepExecutor)(deps));
    toolRegistry.register(file_dedup_1.FILE_DEDUP_DEF, (0, file_dedup_2.createFileDedupExecutor)());
    toolRegistry.register(subdirectory_hints_1.SUBDIRECTORY_HINTS_DEF, (0, subdirectory_hints_1.createSubdirectoryHintsExecutor)());
    // 代码工具 (3)
    toolRegistry.register(code_generate_1.CODE_GENERATE_DEF, (0, code_generate_2.createCodeGenerateExecutor)(deps));
    toolRegistry.register(code_analyze_1.CODE_ANALYZE_DEF, (0, code_analyze_2.createCodeAnalyzeExecutor)(deps));
    toolRegistry.register(csv_analyze_1.CSV_ANALYZE_DEF, (0, csv_analyze_1.createCsvAnalyzeExecutor)());
    // 代码审查工具
    const codeReviewDeps = { llm: deps.llm };
    toolRegistry.register(code_review_1.CODE_REVIEW_DEF, (0, code_review_1.createCodeReviewExecutor)(codeReviewDeps));
    toolRegistry.register(code_review_project_1.CODE_REVIEW_PROJECT_DEF, (0, code_review_project_1.createCodeReviewProjectExecutor)(codeReviewDeps));
    toolRegistry.register(code_fix_1.CODE_FIX_DEF, (0, code_fix_2.createCodeFixExecutor)(deps));
    // 日常管理工具 (9)
    toolRegistry.register(task_manage_1.TASK_MANAGE_DEF, (0, task_manage_2.createTaskManageExecutor)(deps));
    toolRegistry.register(task_priority_1.TASK_PRIORITY_DEF, (0, task_priority_2.createTaskPriorityExecutor)(deps));
    toolRegistry.register(task_dependency_1.TASK_DEPENDENCY_DEF, (0, task_dependency_2.createTaskDependencyExecutor)(deps));
    toolRegistry.register(batch_task_1.BATCH_TASK_DEF, (0, batch_task_2.createBatchTaskExecutor)(deps));
    toolRegistry.register(task_analytics_1.TASK_ANALYTICS_DEF, (0, task_analytics_2.createTaskAnalyticsExecutor)(deps));
    // 晨报工具
    const morningBriefDeps = {
        llm: deps.llm,
        searchExecutor: (params, ctx) => toolRegistry.execute('web_search', params, ctx || { permissions: new Set(), metadata: {} }),
    };
    toolRegistry.register(morning_brief_1.MORNING_BRIEF_DEF, (0, morning_brief_1.createMorningBriefExecutor)(morningBriefDeps));
    // 自然语言调度工具
    toolRegistry.register(natural_schedule_1.NATURAL_SCHEDULE_DEF, (0, natural_schedule_1.createNaturalScheduleExecutor)());
    // Skill 分享工具
    toolRegistry.register(skill_share_1.SKILL_SHARE_DEF, (0, skill_share_1.createSkillShareExecutor)());
    // 知识查询工具
    const knowledgeDeps = {
        memoryRecall: deps.retrieveRelevant
            ? async (query, limit) => {
                const results = await deps.retrieveRelevant({ query, limit });
                return results.map((r) => {
                    const item = r;
                    return {
                        content: item.content,
                        type: item.type,
                        timestamp: item.timestamp,
                        relevanceScore: item.relevanceScore,
                    };
                });
            }
            : undefined,
    };
    toolRegistry.register(knowledge_query_1.KNOWLEDGE_QUERY_DEF, (0, knowledge_query_1.createKnowledgeQueryExecutor)(knowledgeDeps));
    toolRegistry.register(calendar_1.CALENDAR_DEF, (0, calendar_2.createCalendarExecutor)(deps));
    toolRegistry.register(reminder_set_1.REMINDER_SET_DEF, (0, reminder_set_2.createReminderSetExecutor)(deps));
    toolRegistry.register(note_take_1.NOTE_TAKE_DEF, (0, note_take_2.createNoteTakeExecutor)(deps));
    toolRegistry.register(system_status_1.SYSTEM_STATUS_DEF, (0, system_status_2.createSystemStatusExecutor)(deps));
    // 网络工具 (2→7)
    toolRegistry.register(web_search_1.WEB_SEARCH_DEF, (0, web_search_2.createWebSearchExecutor)(deps));
    toolRegistry.register(skill_create_1.SKILL_CREATE_DEF, (0, skill_create_2.createSkillCreateExecutor)(deps));
    toolRegistry.register(web_fetch_1.WEB_FETCH_DEF, (0, web_fetch_2.createWebFetchExecutor)(deps));
    toolRegistry.register(image_generate_1.IMAGE_GENERATE_DEF, (0, image_generate_2.createImageGenerateExecutor)(deps));
    toolRegistry.register(tts_speak_1.TTS_SPEAK_DEF, (0, tts_speak_2.createTTSSpeakExecutor)(deps));
    toolRegistry.register(chart_generate_1.CHART_GENERATE_DEF, (0, chart_generate_2.createChartGenerateExecutor)(deps));
    toolRegistry.register(message_push_1.MESSAGE_PUSH_DEF, (0, message_push_2.createMessagePushExecutor)(deps));
    // 系统工具(扩展) (3→4)
    toolRegistry.register(ask_clarification_1.ASK_CLARIFICATION_DEF, (0, ask_clarification_2.createAskClarificationExecutor)());
    toolRegistry.register(preview_execution_1.PREVIEW_EXECUTION_DEF, (0, preview_execution_2.createPreviewExecutionExecutor)());
    toolRegistry.register(rollback_changes_1.ROLLBACK_CHANGES_DEF, (0, rollback_changes_2.createRollbackChangesExecutor)(deps));
    toolRegistry.register(shell_exec_1.SHELL_EXEC_DEF, (0, shell_exec_2.createShellExecExecutor)(deps));
    toolRegistry.register(execute_code_1.EXECUTE_CODE_DEF, (0, execute_code_1.createExecuteCodeExecutor)(deps));
    toolRegistry.register(shell_generate_1.SHELL_GENERATE_DEF, (0, shell_generate_1.createShellGenerateExecutor)({ llm: deps.llm }));
    toolRegistry.register(delegate_task_1.DELEGATE_TASK_DEF, (0, delegate_task_1.createDelegateTaskExecutor)({ llm: deps.llm, toolRegistry }));
    toolRegistry.register(context_manage_1.CONTEXT_MANAGE_DEF, (0, context_manage_2.createContextManageExecutor)(deps));
    toolRegistry.register(voice_interact_1.VOICE_INTERACT_DEF, (0, voice_interact_1.createVoiceInteractExecutor)(deps));
    toolRegistry.register(osv_scan_1.OSV_SCAN_DEF, (0, osv_scan_1.createOsvScanExecutor)());
    toolRegistry.register(disk_cleanup_1.DISK_CLEANUP_DEF, (0, disk_cleanup_1.createDiskCleanupExecutor)());
    // T0 新增工具: todo_manage + write_approval
    toolRegistry.register(todo_manage_1.TODO_MANAGE_DEF, (0, todo_manage_1.createTodoManageExecutor)());
    toolRegistry.register(write_approval_1.WRITE_APPROVAL_DEF, (0, write_approval_1.createWriteApprovalExecutor)(deps));
    // T1 新增工具: lazy_deps + result_cache + conversation_compression
    toolRegistry.register(lazy_deps_1.LAZY_DEPS_DEF, (0, lazy_deps_1.createLazyDepsExecutor)());
    toolRegistry.register(result_cache_1.RESULT_CACHE_DEF, (0, result_cache_1.createResultCacheExecutor)());
    toolRegistry.register(conversation_compression_1.CONVERSATION_COMPRESSION_DEF, (0, conversation_compression_1.createConversationCompressionExecutor)({ llm: deps.llm }));
    // T2 新增工具: budget_manage + security_guidance
    toolRegistry.register(budget_manage_1.BUDGET_MANAGE_DEF, (0, budget_manage_1.createBudgetManageExecutor)());
    toolRegistry.register(security_guidance_1.SECURITY_GUIDANCE_DEF, (0, security_guidance_1.createSecurityGuidanceExecutor)());
    // T3 新增工具: project_manager
    toolRegistry.register(project_manager_1.PROJECT_MANAGER_DEF, (0, project_manager_1.createProjectManagerExecutor)());
    // LSP 工具 (5) — Phase 2 集成
    toolRegistry.register(lsp_diagnostics_1.LSP_DIAGNOSTICS_DEF, (0, lsp_diagnostics_1.createLspDiagnosticsExecutor)(deps));
    toolRegistry.register(lsp_completion_1.LSP_COMPLETION_DEF, (0, lsp_completion_1.createLspCompletionExecutor)(deps));
    toolRegistry.register(lsp_hover_1.LSP_HOVER_DEF, (0, lsp_hover_1.createLspHoverExecutor)(deps));
    toolRegistry.register(lsp_definition_1.LSP_DEFINITION_DEF, (0, lsp_definition_1.createLspDefinitionExecutor)(deps));
    toolRegistry.register(lsp_references_1.LSP_REFERENCES_DEF, (0, lsp_references_1.createLspReferencesExecutor)(deps));
    toolRegistry.register(lsp_symbols_1.LSP_SYMBOLS_DEF, (0, lsp_symbols_1.createLspSymbolsExecutor)(deps));
    // 元工具（动态工具自创造）
    const metaDeps = { toolRegistry };
    toolRegistry.register(tool_define_1.TOOL_DEFINE_DEF, (0, tool_define_1.createToolDefineExecutor)(metaDeps));
    toolRegistry.register(tool_inspect_1.TOOL_INSPECT_DEF, (0, tool_inspect_1.createToolInspectExecutor)(metaDeps));
    toolRegistry.register(tool_undefine_1.TOOL_UNDEFINE_DEF, (0, tool_undefine_1.createToolUndefineExecutor)(metaDeps));
    Logger_1.Logger.info(`🔧 Harness 工具注册完成: ${toolRegistry.size} 个工具`, 'HarnessToolRegistrar');
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
function syncToLegacySkillRegistry(toolRegistry, skillRegistry) {
    const tools = toolRegistry.getAll();
    for (const tool of tools) {
        const def = tool.definition;
        skillRegistry.registerInfrastructureTool({
            name: def.name,
            description: def.description,
            parameters: Object.entries(def.parameters).map(([name, paramDef]) => ({
                name,
                type: paramDef.type,
                required: def.requiredParams.includes(name),
                description: paramDef.description,
            })),
            execute: async (args, context) => {
                const userPerms = context?.sessionData?.permissions;
                const permissions = Array.isArray(userPerms) && userPerms.length > 0
                    ? new Set(userPerms)
                    : new Set([
                        types_1.Permission.MEMORY_READ,
                        types_1.Permission.MEMORY_WRITE,
                        types_1.Permission.FILE_READ,
                        types_1.Permission.FILE_WRITE,
                        types_1.Permission.CODE_EXECUTE,
                        types_1.Permission.NETWORK_ACCESS,
                    ]);
                const toolContext = {
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
    Logger_1.Logger.info(`🔄 已同步 ${tools.length} 个 Harness 工具到旧版 SkillRegistry`, 'HarnessToolRegistrar');
}
