/**
 * 工具集系统（Toolsets）
 *
 * 按场景/角色预组装的工具包，避免把全部工具传给 LLM
 *
 * 用法:
 *   import { getToolsetRegistry, registerBuiltinToolsets } from './toolsets';
 *   registerBuiltinToolsets();
 *   const tools = getToolsetRegistry().resolveToOpenAI('coding', toolRegistry);
 */

export {
  AGENT_TOOLSET_MAP,
  BUILTIN_TOOLSETS,
  getDefaultToolsetForAgent,
  registerBuiltinToolsets,
} from './builtinToolsets';
export {
  getToolsetRegistry,
  resetToolsetRegistry,
  ToolsetRegistry,
} from './ToolsetRegistry';
export type {
  ResolvedToolset,
  ToolsetDefinition,
  ToolsetEntry,
} from './ToolsetRegistry';
