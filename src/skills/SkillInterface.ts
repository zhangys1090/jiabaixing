/**
 * 贾百姓技能系统 - 统一技能接口定义
 * 所有技能必须实现此接口
 */

/**
 * 技能执行上下文
 */
export interface SkillContext {
  /** 用户标识 */
  userId?: string;
  /** 追踪标识 */
  traceId?: string;
  /** 会话数据 */
  sessionData?: Record<string, unknown>;
  /** 扩展字段 */
  [key: string]: unknown;
}

/**
 * 技能执行结果
 */
export interface SkillResult {
  /** 是否执行成功 */
  success: boolean;
  /** 输出数据 */
  output?: unknown;
  /** 错误信息 */
  error?: string;
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 技能参数定义
 */
export interface SkillParameter {
  /** 参数名称 */
  name: string;
  /** 参数类型 */
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  /** 是否必填 */
  required: boolean;
  /** 参数描述 */
  description: string;
  /** 默认值 */
  default?: unknown;
}

/**
 * 技能定义元数据
 */
export interface SkillDefinition {
  /** 技能名称（唯一标识） */
  name: string;
  /** 技能描述 */
  description: string;
  /** 分类 */
  category: string;
  /** 参数列表 */
  parameters: SkillParameter[];
  /** 版本号 */
  version: string;
  /** 作者 */
  author?: string;
  /** 标签 */
  tags?: string[];
}

/**
 * 技能接口 - 所有技能必须实现
 */
export interface Skill {
  /** 技能定义元数据 */
  definition: SkillDefinition;
  /**
   * 执行技能
   * @param params 参数键值对
   * @param context 执行上下文
   */
  execute(
    params: Record<string, unknown>,
    context?: SkillContext
  ): Promise<SkillResult>;
  /**
   * 验证参数
   * @param params 参数键值对
   */
  validate(
    params: Record<string, unknown>
  ): Promise<{ valid: boolean; errors: string[] }>;
}

/**
 * 技能权限定义
 */
export interface SkillPermission {
  /** 资源类型 */
  resource: 'file' | 'network' | 'command' | 'memory' | 'browser' | 'database';
  /** 允许的操作 */
  actions: ('read' | 'write' | 'execute' | 'delete')[];
}

/**
 * 外部技能定义（用于第三方注册）
 */
export interface ExternalSkillDefinition {
  /** 技能ID */
  id: string;
  /** 技能名称 */
  name: string;
  /** 技能描述 */
  description: string;
  /** 版本号 */
  version: string;
  /** 作者 */
  author: string;
  /** 分类 */
  category: string;
  /** 参数列表 */
  parameters: SkillParameter[];
  /** 权限列表 */
  permissions: SkillPermission[];
  /** 标签 */
  tags?: string[];
  /** 端点URL */
  endpoint?: string;
  /** 本地代码 */
  localCode?: string;
  /** 超时时间（毫秒） */
  timeoutMs?: number;
}

/**
 * 外部技能执行结果
 */
export interface ExternalSkillResult {
  /** 是否执行成功 */
  success: boolean;
  /** 输出数据 */
  output?: unknown;
  /** 错误信息 */
  error?: string;
  /** 执行耗时（毫秒） */
  executionTime?: number;
  /** 日志 */
  logs?: string[];
}

/**
 * 技能验证结果
 */
export interface SkillValidationResult {
  /** 是否通过 */
  passed: boolean;
  /** 错误信息 */
  errors: string[];
  /** 警告信息 */
  warnings: string[];
}
