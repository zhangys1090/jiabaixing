/**
 * 统一文件系统 IO 抽象层
 * 提供异步文件操作、缓存、批量写入能力
 * 所有模块的文件操作应通过此层进行
 */

import fsSync from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger } from '../utils/Logger';

export interface FileReadOptions {
  encoding?: BufferEncoding;
  cache?: boolean;
  cacheTtlMs?: number;
}

export interface FileWriteOptions {
  encoding?: BufferEncoding;
  mode?: number;
  append?: boolean;
  atomic?: boolean;
}

interface CacheEntry {
  content: string | Buffer;
  timestamp: number;
  ttlMs: number;
}

export class FileSystem {
  private static instance: FileSystem;
  private cache: Map<string, CacheEntry> = new Map();
  private writeQueue: Map<string, Promise<void>> = new Map();
  private readonly defaultCacheTtl = 30000;

  static create(): FileSystem {
    return new FileSystem();
  }

  static getInstance(): FileSystem {
    if (!FileSystem.instance) {
      FileSystem.instance = new FileSystem();
    }
    return FileSystem.instance;
  }

  /**
   * 异步读取文件（带缓存）
   */
  async readFile(
    filePath: string,
    options: FileReadOptions = {}
  ): Promise<string> {
    const { encoding = 'utf-8', cache = false, cacheTtlMs } = options;
    const absolutePath = path.resolve(filePath);

    // 检查缓存
    if (cache) {
      const cached = this.cache.get(absolutePath);
      if (cached && Date.now() - cached.timestamp < cached.ttlMs) {
        return cached.content as string;
      }
    }

    try {
      const content = await fs.readFile(absolutePath, { encoding });

      if (cache) {
        this.cache.set(absolutePath, {
          content,
          timestamp: Date.now(),
          ttlMs: cacheTtlMs || this.defaultCacheTtl,
        });
      }

      return content;
    } catch (error) {
      throw new Error(
        `读取文件失败 ${absolutePath}: ${(error as Error).message}`
      );
    }
  }

  /**
   * 异步读取二进制文件
   */
  async readFileBuffer(filePath: string): Promise<Buffer> {
    const absolutePath = path.resolve(filePath);
    try {
      return await fs.readFile(absolutePath);
    } catch (error) {
      throw new Error(
        `读取文件失败 ${absolutePath}: ${(error as Error).message}`
      );
    }
  }

  /**
   * 异步写入文件（支持原子写入）
   */
  async writeFile(
    filePath: string,
    content: string | Buffer,
    options: FileWriteOptions = {}
  ): Promise<void> {
    const { encoding = 'utf-8', mode, atomic = true } = options;
    const absolutePath = path.resolve(filePath);

    // 确保目录存在
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });

    if (atomic) {
      // 原子写入：先写入临时文件，再重命名
      const tempPath = `${absolutePath}.tmp`;
      await fs.writeFile(tempPath, content, { encoding, mode });
      await fs.rename(tempPath, absolutePath);
    } else {
      await fs.writeFile(absolutePath, content, { encoding, mode });
    }

    // 清除缓存
    this.cache.delete(absolutePath);
  }

  /**
   * 异步追加写入
   */
  async appendFile(
    filePath: string,
    content: string,
    options: { encoding?: BufferEncoding } = {}
  ): Promise<void> {
    const { encoding = 'utf-8' } = options;
    const absolutePath = path.resolve(filePath);

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.appendFile(absolutePath, content, { encoding });

    // 清除缓存
    this.cache.delete(absolutePath);
  }

  /**
   * 检查文件是否存在
   */
  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(path.resolve(filePath));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 读取 JSON 文件
   */
  async readJson<T = unknown>(
    filePath: string,
    options?: FileReadOptions
  ): Promise<T> {
    const content = await this.readFile(filePath, options);
    return JSON.parse(content) as T;
  }

  /**
   * 写入 JSON 文件
   */
  async writeJson(
    filePath: string,
    data: unknown,
    options?: FileWriteOptions
  ): Promise<void> {
    const content = JSON.stringify(data, null, 2);
    await this.writeFile(filePath, content, options);
  }

  /**
   * 批量读取文件
   */
  async readFiles(
    filePaths: string[],
    options?: FileReadOptions
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    const errors: string[] = [];

    await Promise.all(
      filePaths.map(async (fp) => {
        try {
          const content = await this.readFile(fp, options);
          results.set(fp, content);
        } catch (error) {
          errors.push(`${fp}: ${(error as Error).message}`);
        }
      })
    );

    if (errors.length > 0) {
      Logger.warn(`批量读取中有 ${errors.length} 个文件失败`, 'FileSystem');
    }

    return results;
  }

  /**
   * 批量写入文件（串行，避免磁盘争用）
   */
  async writeFiles(
    files: Array<{
      path: string;
      content: string | Buffer;
      options?: FileWriteOptions;
    }>
  ): Promise<void> {
    for (const file of files) {
      await this.writeFile(file.path, file.content, file.options);
    }
  }

  /**
   * 清除缓存
   */
  clearCache(filePath?: string): void {
    if (filePath) {
      this.cache.delete(path.resolve(filePath));
    } else {
      this.cache.clear();
    }
  }

  /**
   * 读取目录
   */
  async readDir(dirPath: string): Promise<string[]> {
    const absolutePath = path.resolve(dirPath);
    try {
      return await fs.readdir(absolutePath);
    } catch (error) {
      throw new Error(
        `读取目录失败 ${absolutePath}: ${(error as Error).message}`
      );
    }
  }

  /**
   * 获取文件状态
   */
  async stat(filePath: string): Promise<{
    size: number;
    mtime: Date;
    isFile: boolean;
    isDirectory: boolean;
  }> {
    const absolutePath = path.resolve(filePath);
    try {
      const stats = await fs.stat(absolutePath);
      return {
        size: stats.size,
        mtime: stats.mtime,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
      };
    } catch (error) {
      throw new Error(
        `获取文件状态失败 ${absolutePath}: ${(error as Error).message}`
      );
    }
  }

  /**
   * 重命名文件
   */
  async rename(oldPath: string, newPath: string): Promise<void> {
    const absoluteOldPath = path.resolve(oldPath);
    const absoluteNewPath = path.resolve(newPath);
    try {
      await fs.rename(absoluteOldPath, absoluteNewPath);
    } catch (error) {
      throw new Error(
        `重命名文件失败 ${absoluteOldPath} -> ${absoluteNewPath}: ${(error as Error).message}`
      );
    }
  }

  /**
   * 删除文件
   */
  async unlink(filePath: string): Promise<void> {
    const absolutePath = path.resolve(filePath);
    try {
      await fs.unlink(absolutePath);
      this.cache.delete(absolutePath);
    } catch (error) {
      throw new Error(
        `删除文件失败 ${absolutePath}: ${(error as Error).message}`
      );
    }
  }

  /**
   * 删除文件（别名）
   */
  async deleteFile(filePath: string): Promise<void> {
    return this.unlink(filePath);
  }

  /**
   * 确保目录存在（递归创建）
   */
  async ensureDir(dirPath: string): Promise<void> {
    const absolutePath = path.resolve(dirPath);
    try {
      await fs.mkdir(absolutePath, { recursive: true });
    } catch (error) {
      throw new Error(
        `创建目录失败 ${absolutePath}: ${(error as Error).message}`
      );
    }
  }

  /**
   * 获取文件信息
   */
  async getFileInfo(filePath: string): Promise<{
    size: number;
    mtime: Date;
    isFile: boolean;
    isDirectory: boolean;
  }> {
    return this.stat(filePath);
  }

  /**
   * 同步读取文件（用于解析场景）
   */
  readFileSync(filePath: string, encoding: BufferEncoding = 'utf-8'): string {
    const absolutePath = path.resolve(filePath);
    try {
      return fsSync.readFileSync(absolutePath, { encoding });
    } catch (error) {
      throw new Error(
        `同步读取文件失败 ${absolutePath}: ${(error as Error).message}`
      );
    }
  }

  /**
   * 获取缓存统计
   */
  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}

// 便捷导出
