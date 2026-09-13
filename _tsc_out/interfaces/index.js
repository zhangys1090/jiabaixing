"use strict";
/**
 * jiabaixing 统一接口定义
 * 定义所有模块间的接口规范和数据格式
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskComplexity = exports.MultimodalOutputType = exports.MultimodalInputType = exports.MemoryType = exports.PersonaScene = void 0;
exports.isStringContent = isStringContent;
exports.isObjectContent = isObjectContent;
exports.isArrayContent = isArrayContent;
/**
 * 统一场景类型枚举（全项目使用）
 */
var PersonaScene;
(function (PersonaScene) {
    PersonaScene["DEVELOPMENT"] = "development";
    PersonaScene["DAILY"] = "daily";
    PersonaScene["COMFORT"] = "comfort";
    PersonaScene["WORK"] = "work";
    PersonaScene["GREETING"] = "greeting";
    PersonaScene["BRIEFING"] = "briefing";
    PersonaScene["IDLE"] = "idle";
    PersonaScene["LEISURE"] = "leisure";
    PersonaScene["MEETING"] = "meeting";
    PersonaScene["DRIVING"] = "driving";
})(PersonaScene || (exports.PersonaScene = PersonaScene = {}));
// ====================== 记忆引擎接口 ======================
/**
 * 记忆类型枚举
 */
var MemoryType;
(function (MemoryType) {
    MemoryType["INSTANT"] = "instant";
    MemoryType["SHORT_TERM"] = "short_term";
    MemoryType["LONG_TERM"] = "long_term";
})(MemoryType || (exports.MemoryType = MemoryType = {}));
function isStringContent(content) {
    return typeof content === 'string';
}
function isObjectContent(content) {
    return (typeof content === 'object' && content !== null && !Array.isArray(content));
}
function isArrayContent(content) {
    return Array.isArray(content);
}
// ====================== 多模态输入输出接口 ======================
/**
 * 多模态输入类型
 */
var MultimodalInputType;
(function (MultimodalInputType) {
    MultimodalInputType["TEXT"] = "text";
    MultimodalInputType["VOICE"] = "voice";
    MultimodalInputType["IMAGE"] = "image";
    MultimodalInputType["VIDEO"] = "video";
    MultimodalInputType["FILE"] = "file";
})(MultimodalInputType || (exports.MultimodalInputType = MultimodalInputType = {}));
/**
 * 多模态输出类型
 */
var MultimodalOutputType;
(function (MultimodalOutputType) {
    MultimodalOutputType["TEXT"] = "text";
    MultimodalOutputType["VOICE"] = "voice";
    MultimodalOutputType["IMAGE"] = "image";
    MultimodalOutputType["VIDEO"] = "video";
    MultimodalOutputType["FILE"] = "file";
})(MultimodalOutputType || (exports.MultimodalOutputType = MultimodalOutputType = {}));
// ====================== 推理引擎共享类型 ======================
/**
 * 任务复杂度
 */
var TaskComplexity;
(function (TaskComplexity) {
    TaskComplexity["SIMPLE"] = "simple";
    TaskComplexity["NORMAL"] = "normal";
    TaskComplexity["COMPLEX"] = "complex";
})(TaskComplexity || (exports.TaskComplexity = TaskComplexity = {}));
