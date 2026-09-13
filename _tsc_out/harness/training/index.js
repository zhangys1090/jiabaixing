"use strict";
/**
 * Harness Training — 蒸馏管道 + 质量标注
 *
 * Phase 3 核心模块：
 * - DistillationPipeline: 从 EventStore 生成 SFT/DPO/RLHF 训练数据
 * - QualityAnnotator: 多维度质量标注 + 过滤 + 多样性采样
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.QualityAnnotator = exports.DistillationPipeline = void 0;
var DistillationPipeline_1 = require("./DistillationPipeline");
Object.defineProperty(exports, "DistillationPipeline", { enumerable: true, get: function () { return DistillationPipeline_1.DistillationPipeline; } });
var QualityAnnotator_1 = require("./QualityAnnotator");
Object.defineProperty(exports, "QualityAnnotator", { enumerable: true, get: function () { return QualityAnnotator_1.QualityAnnotator; } });
