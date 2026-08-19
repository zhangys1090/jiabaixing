/**
 * Harness Persistence Layer - 持久化层
 */

export {
    EventStore, type EventMetadata,
    type EventQuery, type EventStoreEvent,
    type EventStoreEventType, type EventStoreOptions,
    type ProjectionResult, type ReplayOptions, type SnapshotRecord
} from './EventStore';
export {
    EventStoreBridge,
    type EventStoreBridgeOptions
} from './EventStoreBridge';
export { PersistenceService } from './PersistenceService';
export {
    SessionReplay, type DiffResult, type DPOEntry, type ReplayResult, type ReplayStep, type SFTEntry, type TrajectoryExportOptions
} from './SessionReplay';
export {
    ContextSnapshotRecord, ExecutionRecord, ExecutionStats, StateTransitionRecord, ToolInvocationRecord, TrajectoryDatabase
} from './TrajectoryDatabase';
export {
    FlywheelConfig, OptimizationSuggestion, TrajectoryAnalysis, TrajectoryFlywheel
} from './TrajectoryFlywheel';
