import { create } from 'zustand';
import type { ConnectionStatus, DialogStateValue } from '@shared/contracts';

interface ConnectionState {
  connected: boolean;
  connectionStatus: ConnectionStatus;
  dialogState: DialogStateValue;
  model: string;
  uptime: number;
  clientCount: number;

  setConnected: (connected: boolean) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  setDialogState: (state: DialogStateValue) => void;
  setStatusData: (data: { status: string; model: string; uptime: number; clients: number }) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  connected: false,
  connectionStatus: 'disconnected',
  dialogState: 'idle',
  model: '',
  uptime: 0,
  clientCount: 0,

  setConnected: (connected) =>
    set({
      connected,
      connectionStatus: connected ? 'connected' : 'disconnected',
    }),

  setConnectionStatus: (status) => set({ connectionStatus: status }),

  setDialogState: (state) => set({ dialogState: state }),

  setStatusData: (data) =>
    set({
      model: data.model,
      uptime: data.uptime,
      clientCount: data.clients,
    }),
}));
