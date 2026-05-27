import { create } from 'zustand';
import type {
  WsBrainStageUpdateData,
  WsToolTraceData,
  WsAgentExecutionUpdateData,
  WsClarificationRequestData,
  WsExecutionPreviewData,
  WsFileModifiedData,
  WsFileRollbackData,
} from '@shared/contracts';

interface AgentState {
  executionUpdates: WsAgentExecutionUpdateData[];
  brainStageUpdates: WsBrainStageUpdateData[];
  toolTraces: WsToolTraceData[];
  clarificationRequest: WsClarificationRequestData | null;
  executionPreview: WsExecutionPreviewData | null;
  fileEvents: Array<WsFileModifiedData | WsFileRollbackData>;
  crossSessionTasks: Array<{
    id: string;
    name: string;
    status: 'running' | 'paused' | 'completed' | 'cancelled';
  }>;
  fcLoopCount: number;
  fcLoopMax: number;
  tokenBudget: number;
  tokenUsed: number;

  addExecutionUpdate: (update: WsAgentExecutionUpdateData) => void;
  addBrainStageUpdate: (update: WsBrainStageUpdateData) => void;
  addToolTrace: (trace: WsToolTraceData) => void;
  setClarificationRequest: (request: WsClarificationRequestData | null) => void;
  setExecutionPreview: (preview: WsExecutionPreviewData | null) => void;
  addFileEvent: (event: WsFileModifiedData | WsFileRollbackData) => void;
  setCrossSessionTasks: (
    tasks: Array<{
      id: string;
      name: string;
      status: 'running' | 'paused' | 'completed' | 'cancelled';
    }>
  ) => void;
  updateFcLoop: (count: number, tokenUsed: number) => void;
  reset: () => void;
}

const initialState = {
  executionUpdates: [],
  brainStageUpdates: [],
  toolTraces: [],
  clarificationRequest: null,
  executionPreview: null,
  fileEvents: [],
  crossSessionTasks: [],
  fcLoopCount: 0,
  fcLoopMax: 8,
  tokenBudget: 6000,
  tokenUsed: 0,
};

export const useAgentStore = create<AgentState>((set) => ({
  ...initialState,

  addExecutionUpdate: (update) =>
    set((state) => ({
      executionUpdates: [...state.executionUpdates.slice(-49), update],
    })),

  addBrainStageUpdate: (update) =>
    set((state) => ({
      brainStageUpdates: [...state.brainStageUpdates.slice(-49), update],
    })),

  addToolTrace: (trace) =>
    set((state) => ({
      toolTraces: [...state.toolTraces.slice(-99), trace],
    })),

  setClarificationRequest: (request) => set({ clarificationRequest: request }),

  setExecutionPreview: (preview) => set({ executionPreview: preview }),

  addFileEvent: (event) =>
    set((state) => ({
      fileEvents: [...state.fileEvents.slice(-49), event],
    })),

  setCrossSessionTasks: (tasks) => set({ crossSessionTasks: tasks }),

  updateFcLoop: (count, tokenUsed) => set({ fcLoopCount: count, tokenUsed }),

  reset: () => set(initialState),
}));
