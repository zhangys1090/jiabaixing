import * as crypto from 'crypto';
import * as path from 'path';
import { FileSystem } from '../../io/FileSystem';
import { Logger } from '../../utils/Logger';
import {
  DesktopStateSnapshot,
  SnapshotListOptions,
  SnapshotMetadata,
  SnapshotStatus,
  StateSnapshotManagerConfig,
} from './types';

const fileSystem = FileSystem.getInstance();

export class SnapshotStorage {
  private static instance: SnapshotStorage | null = null;
  private config: Required<StateSnapshotManagerConfig>;
  private metadataIndex: Map<string, SnapshotMetadata> = new Map();
  private indexFilePath: string;

  private constructor(config: Required<StateSnapshotManagerConfig>) {
    this.config = config;
    this.indexFilePath = path.join(this.config.storageDir, 'index.json');
  }

  public static getInstance(
    config?: Required<StateSnapshotManagerConfig>
  ): SnapshotStorage {
    if (!SnapshotStorage.instance) {
      SnapshotStorage.instance = new SnapshotStorage(
        config || ({} as Required<StateSnapshotManagerConfig>)
      );
    }
    return SnapshotStorage.instance;
  }

  public static reset(): void {
    SnapshotStorage.instance = null;
  }

  public updateConfig(config: Required<StateSnapshotManagerConfig>): void {
    this.config = config;
    this.indexFilePath = path.join(this.config.storageDir, 'index.json');
  }

  public getMetadataIndex(): Map<string, SnapshotMetadata> {
    return this.metadataIndex;
  }

  public setMetadataIndex(index: Map<string, SnapshotMetadata>): void {
    this.metadataIndex = index;
  }

  public getMetadata(snapshotId: string): SnapshotMetadata | undefined {
    return this.metadataIndex.get(snapshotId);
  }

  public setMetadata(snapshotId: string, metadata: SnapshotMetadata): void {
    this.metadataIndex.set(snapshotId, metadata);
  }

  public deleteMetadata(snapshotId: string): boolean {
    return this.metadataIndex.delete(snapshotId);
  }

  public async ensureStorageDir(): Promise<void> {
    await fileSystem.ensureDir(this.config.storageDir);
  }

  public async loadIndex(): Promise<void> {
    try {
      const data = await fileSystem.readFile(this.indexFilePath);
      const indexData = JSON.parse(data) as SnapshotMetadata[];
      this.metadataIndex = new Map(
        indexData.map((meta) => [meta.snapshotId, meta])
      );
    } catch {
      this.metadataIndex = new Map();
    }
  }

  public async saveIndex(): Promise<void> {
    const indexData = Array.from(this.metadataIndex.values());
    await fileSystem.writeFile(
      this.indexFilePath,
      JSON.stringify(indexData, null, 2)
    );
  }

  public async saveSnapshotToFile(
    snapshot: DesktopStateSnapshot
  ): Promise<string> {
    const fileName = `${snapshot.snapshotId}.json`;
    const filePath = path.join(this.config.storageDir, fileName);
    const data = JSON.stringify(snapshot, null, 2);

    if (this.config.compressStorage) {
      const zlib = await import('zlib');
      const compressed = zlib.deflateSync(Buffer.from(data));
      await fileSystem.writeFile(filePath + '.gz', compressed);
      return filePath + '.gz';
    }

    await fileSystem.writeFile(filePath, data, { atomic: false });
    return filePath;
  }

  public async loadSnapshot(
    snapshotId: string
  ): Promise<DesktopStateSnapshot | null> {
    const meta = this.metadataIndex.get(snapshotId);
    if (!meta) return null;

    try {
      let data: string;

      if (meta.filePath.endsWith('.gz')) {
        const zlib = await import('zlib');
        const compressed = await fileSystem.readFileBuffer(meta.filePath);
        data = zlib.inflateSync(compressed).toString('utf-8');
      } else {
        data = await fileSystem.readFile(meta.filePath);
      }

      const snapshot = JSON.parse(data) as DesktopStateSnapshot;

      if (this.config.enableChecksum && meta.checksum) {
        const actualChecksum = this.calculateChecksum(data);
        if (actualChecksum !== meta.checksum) {
          Logger.error(
            `⚠️ 快照校验和不匹配: ${snapshotId}`,
            new Error(
              `Checksum mismatch: expected ${meta.checksum}, got ${actualChecksum}`
            ),
            'SnapshotStorage'
          );
          meta.status = SnapshotStatus.CORRUPTED;
          await this.saveIndex();
          return null;
        }
      }

      return snapshot;
    } catch (error) {
      Logger.error(
        `❌ 加载快照失败: ${snapshotId}`,
        error as Error,
        'SnapshotStorage'
      );
      return null;
    }
  }

  public async deleteSnapshotFile(snapshotId: string): Promise<boolean> {
    const meta = this.metadataIndex.get(snapshotId);
    if (!meta) return false;

    try {
      await fileSystem.deleteFile(meta.filePath);
      this.metadataIndex.delete(snapshotId);
      await this.saveIndex();
      Logger.info(`🗑️ 快照已删除: ${snapshotId}`, 'SnapshotStorage');
      return true;
    } catch (error) {
      Logger.error(
        `❌ 删除快照失败: ${snapshotId}`,
        error as Error,
        'SnapshotStorage'
      );
      return false;
    }
  }

  public async listSnapshots(
    options: SnapshotListOptions = {}
  ): Promise<SnapshotMetadata[]> {
    let results = Array.from(this.metadataIndex.values());

    if (options.startTime) {
      results = results.filter((m) => m.timestamp >= options.startTime!);
    }
    if (options.endTime) {
      results = results.filter((m) => m.timestamp <= options.endTime!);
    }
    if (options.triggerTypes?.length) {
      results = results.filter((m) =>
        options.triggerTypes!.includes(m.triggerType)
      );
    }
    if (options.tags?.length) {
      results = results.filter((m) =>
        options.tags!.some((tag) => m.tags.includes(tag))
      );
    }
    if (options.status) {
      results = results.filter((m) => m.status === options.status);
    }

    results.sort((a, b) => b.timestamp - a.timestamp);

    const offset = options.offset || 0;
    const limit = options.limit || results.length;
    return results.slice(offset, offset + limit);
  }

  public async getLatestSnapshot(): Promise<SnapshotMetadata | null> {
    const snapshots = await this.listSnapshots({ limit: 1 });
    return snapshots[0] || null;
  }

  public async cleanupExpiredSnapshots(
    snapshotExpiryMs: number
  ): Promise<number> {
    if (snapshotExpiryMs <= 0) return 0;

    const now = Date.now();
    const expired: string[] = [];

    for (const [id, meta] of this.metadataIndex) {
      if (now - meta.timestamp > snapshotExpiryMs) {
        expired.push(id);
      }
    }

    for (const id of expired) {
      await this.deleteSnapshotFile(id);
    }

    Logger.info(`🧹 清理 ${expired.length} 个过期快照`, 'SnapshotStorage');
    return expired.length;
  }

  public async getSnapshotFileSize(
    filePath: string
  ): Promise<number> {
    const info = await fileSystem.getFileInfo(filePath);
    return info.size;
  }

  public calculateChecksum(data: string): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  public async enforceMaxSnapshotCount(maxCount: number): Promise<void> {
    const all = Array.from(this.metadataIndex.values()).sort(
      (a, b) => a.timestamp - b.timestamp
    );

    if (all.length > maxCount) {
      const toDelete = all.slice(0, all.length - maxCount);
      for (const meta of toDelete) {
        await this.deleteSnapshotFile(meta.snapshotId);
      }
    }
  }
}
