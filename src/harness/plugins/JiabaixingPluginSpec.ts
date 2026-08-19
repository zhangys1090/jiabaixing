/**
 * JiabaixingPlugin — 标准化插件规范
 *
 * Phase 4: 统一插件描述符与 manifest 验证
 * - 定义标准化的插件描述符（兼容现有 PluginManifest）
 * - manifest 验证（schema 校验 + 权限声明 + 依赖检查）
 * - 插件元信息标准化（来源/签名/兼容性）
 * - 插件描述符版本化
 */

import type { PluginPermission, PluginSettingDefinition } from './pluginTypes';

export type PluginSource = 'local' | 'npm' | 'git' | 'url' | 'marketplace' | 'builtin';

export type PluginStatus = 'uninstalled' | 'installed' | 'loaded' | 'active' | 'error' | 'disabled' | 'sandboxed';

export interface JiabaixingPluginDescriptor {
  specVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  icon?: string;
  main: string;
  source: PluginSource;
  sourceUrl?: string;
  checksum?: string;
  signature?: string;
  minHarnessVersion?: string;
  maxHarnessVersion?: string;
  dependencies?: Array<{
    pluginId: string;
    minVersion?: string;
    maxVersion?: string;
    optional?: boolean;
  }>;
  permissions: PluginPermission[];
  settings?: PluginSettingDefinition[];
  provides: {
    tools?: Array<{
      name: string;
      description: string;
    }>;
    hooks?: string[];
    panels?: Array<{
      id: string;
      label: string;
    }>;
    layers?: Array<{
      name: string;
      implementation: string;
    }>;
  };
  sandbox?: {
    enabled: boolean;
    permissions: PluginPermission[];
    maxMemoryMB?: number;
    maxCpuMs?: number;
    networkAccess?: boolean;
    filesystemPaths?: string[];
  };
  tags?: string[];
  category?: string;
}

export interface ManifestValidationResult {
  valid: boolean;
  errors: Array<{
    path: string;
    message: string;
    severity: 'error' | 'warning';
  }>;
  warnings: string[];
}

const REQUIRED_FIELDS: Array<{ path: string; type: string }> = [
  { path: 'id', type: 'string' },
  { path: 'name', type: 'string' },
  { path: 'version', type: 'string' },
  { path: 'description', type: 'string' },
  { path: 'main', type: 'string' },
  { path: 'permissions', type: 'array' },
];

const VERSION_REGEX = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
const PLUGIN_ID_REGEX = /^[a-z0-9][a-z0-9_-]*$/;

export class JiabaixingPluginSpec {
  static validate(descriptor: unknown): ManifestValidationResult {
    const errors: ManifestValidationResult['errors'] = [];
    const warnings: string[] = [];

    if (!descriptor || typeof descriptor !== 'object') {
      return {
        valid: false,
        errors: [{ path: '', message: '描述符必须为对象', severity: 'error' }],
        warnings,
      };
    }

    const desc = descriptor as Record<string, unknown>;

    for (const field of REQUIRED_FIELDS) {
      const value = desc[field.path];
      if (value === undefined || value === null || value === '') {
        errors.push({
          path: field.path,
          message: `缺少必填字段: ${field.path}`,
          severity: 'error',
        });
      } else if (field.type === 'array' && !Array.isArray(value)) {
        errors.push({
          path: field.path,
          message: `${field.path} 必须为数组`,
          severity: 'error',
        });
      } else if (field.type === 'string' && typeof value !== 'string') {
        errors.push({
          path: field.path,
          message: `${field.path} 必须为字符串`,
          severity: 'error',
        });
      }
    }

    if (desc.id && typeof desc.id === 'string') {
      if (!PLUGIN_ID_REGEX.test(desc.id)) {
        errors.push({
          path: 'id',
          message: `插件 ID 必须匹配: ${PLUGIN_ID_REGEX.source}`,
          severity: 'error',
        });
      }
      if (desc.id.length > 64) {
        errors.push({
          path: 'id',
          message: '插件 ID 不能超过 64 字符',
          severity: 'error',
        });
      }
    }

    if (desc.version && typeof desc.version === 'string') {
      if (!VERSION_REGEX.test(desc.version)) {
        errors.push({
          path: 'version',
          message: '版本号必须为 semver 格式 (x.y.z)',
          severity: 'error',
        });
      }
    }

    if (desc.permissions && Array.isArray(desc.permissions)) {
      const validPermissions = new Set<PluginPermission>([
        'file:read', 'file:write', 'network:request', 'system:exec',
        'memory:read', 'memory:write', 'tool:register', 'tool:call',
        'ui:panel', 'ui:notification',
      ]);

      for (const perm of desc.permissions) {
        if (!validPermissions.has(perm as PluginPermission)) {
          errors.push({
            path: 'permissions',
            message: `未知权限: ${perm}`,
            severity: 'warning',
          });
        }
      }

      if ((desc.permissions as string[]).includes('system:exec')) {
        warnings.push('插件请求 system:exec 权限，建议启用沙箱');
      }
    }

    if (desc.dependencies && Array.isArray(desc.dependencies)) {
      for (let i = 0; i < desc.dependencies.length; i++) {
        const dep = desc.dependencies[i] as Record<string, unknown>;
        if (!dep.pluginId) {
          errors.push({
            path: `dependencies[${i}].pluginId`,
            message: '依赖缺少 pluginId',
            severity: 'error',
          });
        }
        if (dep.minVersion && typeof dep.minVersion === 'string' && !VERSION_REGEX.test(dep.minVersion)) {
          errors.push({
            path: `dependencies[${i}].minVersion`,
            message: '依赖版本号必须为 semver 格式',
            severity: 'error',
          });
        }
      }
    }

    if (desc.sandbox && typeof desc.sandbox === 'object') {
      const sandbox = desc.sandbox as Record<string, unknown>;
      if (sandbox.enabled === true && Array.isArray(sandbox.permissions)) {
        const sandboxPerms = sandbox.permissions as string[];
        const declaredPerms = (desc.permissions as string[]) ?? [];
        for (const perm of sandboxPerms) {
          if (!declaredPerms.includes(perm)) {
            warnings.push(`沙箱权限 ${perm} 未在主权限列表中声明`);
          }
        }
      }
    }

    if (!desc.author) {
      warnings.push('建议提供 author 字段');
    }
    if (!desc.license) {
      warnings.push('建议提供 license 字段');
    }

    return {
      valid: errors.filter((e) => e.severity === 'error').length === 0,
      errors,
      warnings,
    };
  }

  static fromLegacyManifest(manifest: {
    id: string;
    name: string;
    version: string;
    description: string;
    author?: string;
    homepage?: string;
    main: string;
    icon?: string;
    permissions?: PluginPermission[];
    hooks?: string[];
    settings?: PluginSettingDefinition[];
  }): JiabaixingPluginDescriptor {
    return {
      specVersion: 1,
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      homepage: manifest.homepage,
      main: manifest.main,
      icon: manifest.icon,
      source: 'local',
      permissions: manifest.permissions ?? [],
      settings: manifest.settings,
      provides: {
        hooks: manifest.hooks,
      },
      sandbox: {
        enabled: false,
        permissions: [],
      },
    };
  }

  static createBuiltin(descriptor: Partial<JiabaixingPluginDescriptor>): JiabaixingPluginDescriptor {
    return {
      specVersion: 1,
      id: descriptor.id ?? 'unknown',
      name: descriptor.name ?? descriptor.id ?? 'unknown',
      version: descriptor.version ?? '0.0.0',
      description: descriptor.description ?? '',
      main: descriptor.main ?? 'index.js',
      source: 'builtin',
      permissions: descriptor.permissions ?? [],
      provides: descriptor.provides ?? {},
      sandbox: { enabled: false, permissions: [] },
      ...descriptor,
    } as JiabaixingPluginDescriptor;
  }
}
