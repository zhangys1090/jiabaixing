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
import { FILE_LIST_DEF } from './file/file_list';
import { FILE_SEARCH_DEF } from './file/file_search';
import { GET_ACTIVE_FILE_DEF } from './file/get_active_file';
import { INCREMENTAL_EDIT_DEF } from './file/incremental_edit';
import { MULTI_FILE_EDIT_DEF } from './file/multi_file_edit';

// === 代码工具 ===
import { CODE_ANALYZE_DEF } from './code/code_analyze';
import { CODE_FIX_DEF } from './code/code_fix';
import { CODE_GENERATE_DEF } from './code/code_generate';

// === 日常管理工具 ===
import { NOTE_TAKE_DEF } from './daily/note_take';
import { REMINDER_SET_DEF } from './daily/reminder_set';
import { SYSTEM_STATUS_DEF } from './daily/system_status';
import { TASK_MANAGE_DEF } from './daily/task_manage';

// === 网络工具 ===
import { WEB_SEARCH_DEF } from './network/web_search';
import { SKILL_CREATE_DEF } from './network/skill_create';

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
import { createFileListExecutor, type FileListDeps } from './file/file_list';
import {
  createFileSearchExecutor,
  type FileSearchDeps,
} from './file/file_search';
import { createGetActiveFileExecutor, type GetActiveFileDeps } from './file/get_active_file';
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
import { createNoteTakeExecutor, type NoteTakeDeps } from './daily/note_take';
import { createReminderSetExecutor, type ReminderSetDeps } from './daily/reminder_set';
import { createSystemStatusExecutor, type SystemStatusDeps } from './daily/system_status';
import { createTaskManageExecutor, type TaskManageDeps } from './daily/task_manage';

// === 网络工具执行器工厂 ===
import { createWebSearchExecutor, type WebSearchDeps } from './network/web_search';
import { createSkillCreateExecutor, type SkillCreateDeps } from './network/skill_create';

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
    FileSearchDeps,
    FileListDeps,
    GetActiveFileDeps,
    CodeGenerateDeps,
    CodeAnalyzeDeps,
    CodeFixDeps,
    TaskManageDeps,
    ReminderSetDeps,
    NoteTakeDeps,
    SystemStatusDeps,
    WebSearchDeps,
    SkillCreateDeps {}

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

  // 系统工具 (3)
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

  // 文件工具 (5)
  toolRegistry.register(GET_ACTIVE_FILE_DEF, createGetActiveFileExecutor(deps));
  toolRegistry.register(
    INCREMENTAL_EDIT_DEF,
    createIncrementalEditExecutor(deps)
  );
  toolRegistry.register(MULTI_FILE_EDIT_DEF, createMultiFileEditExecutor(deps));
  toolRegistry.register(FILE_SEARCH_DEF, createFileSearchExecutor(deps));
  toolRegistry.register(FILE_LIST_DEF, createFileListExecutor(deps));

  // 代码工具 (3)
  toolRegistry.register(CODE_GENERATE_DEF, createCodeGenerateExecutor(deps));
  toolRegistry.register(CODE_ANALYZE_DEF, createCodeAnalyzeExecutor(deps));
  toolRegistry.register(CODE_FIX_DEF, createCodeFixExecutor(deps));

  // 日常管理工具 (4)
  toolRegistry.register(TASK_MANAGE_DEF, createTaskManageExecutor(deps));
  toolRegistry.register(REMINDER_SET_DEF, createReminderSetExecutor(deps));
  toolRegistry.register(NOTE_TAKE_DEF, createNoteTakeExecutor(deps));
  toolRegistry.register(SYSTEM_STATUS_DEF, createSystemStatusExecutor(deps));

  // 网络工具 (2)
  toolRegistry.register(WEB_SEARCH_DEF, createWebSearchExecutor(deps));
  toolRegistry.register(SKILL_CREATE_DEF, createSkillCreateExecutor(deps));

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
        const permissions = Array.isArray(userPerms) && userPerms.length > 0
          ? new Set<Permission>(userPerms as Permission[])
          : new Set<Permission>([
              Permission.MEMORY_READ,
              Permission.MEMORY_WRITE,
              Permission.FILE_READ,
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
