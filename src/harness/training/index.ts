/**
 * Harness Training — 蒸馏管道 + 质量标注
 *
 * Phase 3 核心模块：
 * - DistillationPipeline: 从 EventStore 生成 SFT/DPO/RLHF 训练数据
 * - QualityAnnotator: 多维度质量标注 + 过滤 + 多样性采样
 */

export {
    DistillationPipeline,
    type DistillationConfig,
    type DistillationFormat, type DistillationResult, type DistilledEntry, type DPOEntry,
    type RLHFEntry, type SFTEntry
} from './DistillationPipeline';

export {
    QualityAnnotator, type AnnotatedTrajectory, type DiversitySampleConfig, type QualityAnnotation, type QualityFilterConfig, type QualityLabels
} from './QualityAnnotator';
