"use strict";
/**
 * 记忆引擎接口（避免循环依赖）
 * 从 JiabaixingCore.ts 提取，供全系统统一引用
 *
 * E2-V2: EpisodicMemoryStore 是 rogue store，不再从它 import 类型。
 * 情景记忆相关类型在此内联定义，消除对 rogue store 的编译依赖。
 */
Object.defineProperty(exports, "__esModule", { value: true });
