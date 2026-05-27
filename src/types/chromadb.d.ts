// Type declaration for @chroma-core/chromadb (missing dependency)
declare module '@chroma-core/chromadb' {
  export class ChromaClient {
    constructor(config: { path: string });
    getOrCreateCollection(params: {
      name: string;
      metadata?: Record<string, unknown>;
    }): Promise<ChromaCollection>;
  }

  export interface ChromaCollection {
    add(params: {
      ids: string[];
      embeddings?: number[][];
      metadatas?: Array<Record<string, unknown> | undefined>;
      documents?: string[];
    }): Promise<void>;
    query(params: {
      queryEmbeddings: number[][];
      nResults: number;
      where?: Record<string, unknown>;
    }): Promise<{
      ids: string[][];
      distances: number[][];
      metadatas: Array<Array<Record<string, unknown> | null>>;
      documents: Array<Array<string | null>>;
    }>;
    delete(params: { ids: string[] }): Promise<void>;
  }
}
