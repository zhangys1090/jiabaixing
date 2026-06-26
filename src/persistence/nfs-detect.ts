/**
 * NFS 环境检测与 pragma 降级
 *
 * WAL 模式在 NFS 文件系统上不可靠（锁机制不兼容），
 * 需要检测 NFS 环境并降级为 DELETE 模式。
 *
 * 检测策略:
 *   1. 检查 DB 文件所在挂载点是否为 NFS（Linux: /proc/mounts）
 *   2. 检查环境变量 JIABAIXING_JOURNAL_MODE 显式覆盖
 *   3. 默认返回 wal（非 NFS 环境）
 */

import fs from 'fs';

/**
 * 检测当前数据库路径是否在 NFS 文件系统上
 *
 * @param dbPath - 数据库文件路径
 * @returns true 表示检测到 NFS 环境
 */
export function detectNfsEnvironment(dbPath?: string): boolean {
  // 1. 环境变量显式覆盖
  const envMode = process.env.JIABAIXING_JOURNAL_MODE;
  if (envMode === 'delete' || envMode === 'DELETE') return true;
  if (envMode === 'wal' || envMode === 'WAL') return false;

  // 2. 仅在 Linux 上检测 /proc/mounts
  if (process.platform !== 'linux') return false;

  try {
    const targetPath = dbPath
      ? dbPath.replace(/\\/g, '/').replace(/\/[^/]*$/, '') || '/'
      : process.cwd().replace(/\\/g, '/');

    const mounts = fs.readFileSync('/proc/mounts', 'utf-8');
    const mountPoints: Array<{ path: string; isNfs: boolean }> = [];

    for (const line of mounts.split('\n')) {
      const parts = line.split(/\s+/);
      if (parts.length < 3) continue;
      const mountPath = parts[1];
      const fsType = parts[2];
      mountPoints.push({
        path: mountPath,
        isNfs: fsType === 'nfs' || fsType === 'nfs4',
      });
    }

    // 找到包含目标路径的最长挂载点
    let bestMatch: (typeof mountPoints)[0] | null = null;
    for (const mp of mountPoints) {
      if (targetPath.startsWith(mp.path)) {
        if (!bestMatch || mp.path.length > bestMatch.path.length) {
          bestMatch = mp;
        }
      }
    }

    return bestMatch?.isNfs ?? false;
  } catch {
    // 无法读取 /proc/mounts，假设非 NFS
    return false;
  }
}

/**
 * 解析应使用的 journal_mode
 *
 * @param dbPath - 数据库文件路径
 * @returns 'wal' 或 'delete'
 */
export function resolveJournalMode(dbPath?: string): 'wal' | 'delete' {
  return detectNfsEnvironment(dbPath) ? 'delete' : 'wal';
}
