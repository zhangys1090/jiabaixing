import { useCallback, useEffect, useRef, useState } from 'react';

export interface SSEChunk {
  traceId: string;
  chunk: string;
  offset: number;
  timestamp: number;
}

export interface SSEState {
  connected: boolean;
  buffer: string;
  chunks: SSEChunk[];
  activeTraceId: string | null;
  error: string | null;
}

interface UseSSEOptions {
  url?: string;
  onChunk?: (chunk: SSEChunk) => void;
  onDone?: (fullText: string) => void;
  onError?: (err: string) => void;
}

export function useSSE(options: UseSSEOptions = {}) {
  const { url = '/api/sse/stream', onChunk, onDone, onError } = options;

  const [state, setState] = useState<SSEState>({
    connected: false,
    buffer: '',
    chunks: [],
    activeTraceId: null,
    error: null,
  });

  const esRef = useRef<EventSource | null>(null);
  const bufferRef = useRef('');

  const connect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
    }

    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      setState((prev) => ({ ...prev, connected: true, error: null }));
    };

    es.addEventListener('stream_start', (event) => {
      const payload = JSON.parse((event as MessageEvent).data);
      setState((prev) => ({ ...prev, activeTraceId: payload.traceId, buffer: '' }));
      bufferRef.current = '';
    });

    es.addEventListener('stream_chunk', (event) => {
      const payload = JSON.parse((event as MessageEvent).data);
      const chunk: SSEChunk = {
        traceId: payload.traceId,
        chunk: payload.chunk,
        offset: payload.offset,
        timestamp: payload.timestamp,
      };
      bufferRef.current += chunk.chunk;
      setState((prev) => ({
        ...prev,
        buffer: bufferRef.current,
        chunks: [...prev.chunks, chunk],
      }));
      onChunk?.(chunk);
    });

    es.addEventListener('stream_done', (event) => {
      const payload = JSON.parse((event as MessageEvent).data);
      const fullText = bufferRef.current;
      setState((prev) => ({
        ...prev,
        activeTraceId: null,
        buffer: fullText,
      }));
      onDone?.(fullText);
    });

    es.onerror = () => {
      const errMsg = 'SSE connection lost, retrying...';
      setState((prev) => ({ ...prev, connected: false, error: errMsg }));
      onError?.(errMsg);
    };
  }, [url, onChunk, onDone, onError]);

  const disconnect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    setState((prev) => ({ ...prev, connected: false }));
  }, []);

  useEffect(() => {
    return () => {
      esRef.current?.close();
    };
  }, []);

  return { state, connect, disconnect };
}
