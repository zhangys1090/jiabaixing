"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolsetRegistry = exports.resetToolsetRegistry = exports.getToolsetRegistry = exports.registerBuiltinToolsets = exports.getDefaultToolsetForAgent = exports.BUILTIN_TOOLSETS = exports.AGENT_TOOLSET_MAP = void 0;
var builtinToolsets_1 = require("./builtinToolsets");
Object.defineProperty(exports, "AGENT_TOOLSET_MAP", { enumerable: true, get: function () { return builtinToolsets_1.AGENT_TOOLSET_MAP; } });
Object.defineProperty(exports, "BUILTIN_TOOLSETS", { enumerable: true, get: function () { return builtinToolsets_1.BUILTIN_TOOLSETS; } });
Object.defineProperty(exports, "getDefaultToolsetForAgent", { enumerable: true, get: function () { return builtinToolsets_1.getDefaultToolsetForAgent; } });
Object.defineProperty(exports, "registerBuiltinToolsets", { enumerable: true, get: function () { return builtinToolsets_1.registerBuiltinToolsets; } });
var ToolsetRegistry_1 = require("./ToolsetRegistry");
Object.defineProperty(exports, "getToolsetRegistry", { enumerable: true, get: function () { return ToolsetRegistry_1.getToolsetRegistry; } });
Object.defineProperty(exports, "resetToolsetRegistry", { enumerable: true, get: function () { return ToolsetRegistry_1.resetToolsetRegistry; } });
Object.defineProperty(exports, "ToolsetRegistry", { enumerable: true, get: function () { return ToolsetRegistry_1.ToolsetRegistry; } });
