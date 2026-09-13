"use strict";
/**
 * A2A 协议 TS 端类型定义（薄壳层）。
 *
 * 以 Python `agent/a2a/types.py` 为唯一事实来源，TS 侧类型与之逐一对应
 * （camelCase 字段映射 Python 的 snake_case，见 types.py 的 to_dict/from_dict）。
 *
 * 为避免双端类型定义漂移，本文件直接复用 `AgentRegistry.ts` 中已存在的
 * 权威 TS 类型（types.py 注释明确指向 AgentRegistry.ts 第 851–959 行）。
 * 若未来需要拆分，可在此处定义规范类型并让 AgentRegistry 反向 re-export。
 */
Object.defineProperty(exports, "__esModule", { value: true });
