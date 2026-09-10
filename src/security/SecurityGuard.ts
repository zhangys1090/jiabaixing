/**
 * 安全守卫
 * 为工具执行提供安全防护：输入校验、权限检查、沙箱执行、超时控制、结果过滤
 */

import { Logger } from '../utils/Logger';

/**
 * 安全校验结果
 */
export interface SecurityCheckResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * 安全执行上下文
 */
export interface SecurityContext {
  userId?: string;
  traceId?: string;
  timeout?: number;
  maxOutputSize?: number;
}

/**
 * 用户角色
 */
export type UserRole = 'admin' | 'developer' | 'user' | 'guest';

/**
 * 权限配置
 */
export interface PermissionConfig {
  roles: Record<string, string[]>;
  resources: Record<
    string,
    {
      allowedRoles: string[];
      allowedActions: string[];
    }
  >;
}

/**
 * 安全守卫类
 * 提供统一的安全防护接口
 */
export class SecurityGuard {
  private static instance: SecurityGuard | null = null;
  private static instanceLock: boolean = false;

  // 安全红线模式
  private securityRedlines: RegExp[] = [
    /(system access|system control|bypass security)/i,
    /(delete all data|format disk|system shutdown)/i,
    /(unauthorized access|privilege escalation)/i,
    /(data exfiltration|data theft)/i,
    /(malware|virus|trojan)/i,
  ];

  // SQL注入模式 - 精确匹配，避免自然语言误报
  // P0-3 修复: 缩窄模式范围，仅匹配真正的 SQL 注入特征
  // P1-4 修复: 1=1 仅在 SQL 上下文（WHERE/OR/AND 后）匹配，避免数学表达式误报
  private sqlInjectionPatterns: RegExp[] = [
    /(\bunion\s+(all\s+)?select\b[\s\S]{0,80}\bfrom\b)/i,
    /(\binsert\s+into\b[\s\S]{0,40}\bvalues\b)/i,
    /(\bupdate\s+\w+\s+set\b[\s\S]{0,40}=)/i,
    /(\bdelete\s+from\b[\s\S]{0,20}\bwhere\b)/i,
    /(\bdrop\s+table\b)/i,
    /(\balter\s+table\b)/i,
    /('\s*or\s+'[^']*'\s*=\s*')/i,
    /(\b(?:where|or|and)\s+1\s*=\s*1\b)/i,
    /('\s*;\s*(drop|delete|update|insert|select)\b)/i,
    /(--\s*;\s*(drop|delete|update|insert)\b)/i,
  ];

  // XSS攻击模式 - P1-7 修复: on\w+= 改为仅匹配事件属性在HTML标签内
  private xssPatterns: RegExp[] = [
    /<script[^>]*>.*?<\/script>/i,
    /javascript:/i,
    /<[^>]+\bon\w+\s*=/i,
    /eval\s*\(/i,
    /document\.(cookie|write|location)/i,
  ];

  // 命令注入模式 - P0-9 修复: 缩窄至真正的注入特征，不再误杀正常命令
  private commandInjectionPatterns: RegExp[] = [
    /\b(rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|--no-preserve-root\s+)\/)/i,
    /\b(format\s+[A-Za-z]:)/i,
    /\b(shutdown\b|\breboot\b)/i,
    /\b(cat|type)\s+\/etc\/(passwd|shadow|sudoers)/i,
    /\b(curl|wget)\s+.+\s*\|\s*(ba)?sh/i,
    /\$\(\s*(rm|del|format|shutdown|reboot|kill)/i,
    /\b(chmod|chown)\s+[0-7]{3,4}\s+\/(etc|var|usr|bin|sbin)\b/i,
    /\bdd\s+if=/i,
  ];

  // 代码沙箱危险模式
  private dangerousCodePatterns: Record<string, RegExp[]> = {
    eval: [
      /eval\s*\(/,
      /new\s+Function\s*\(/,
      /setTimeout\s*\(\s*["']/,
      /setInterval\s*\(\s*["']/,
    ],
    network: [
      /fetch\s*\(/,
      /XMLHttpRequest/,
      /WebSocket/,
      /navigator\.sendBeacon/,
    ],
    filesystem: [
      /fs\./,
      /require\s*\(\s*["']fs["']\)/,
      /readFile/,
      /writeFile/,
    ],
    infinite_loop: [/while\s*\(\s*true\s*\)/, /for\s*\(\s*;\s*;\s*\)/],
    child_process: [
      /child_process/,
      /spawn\s*\(/,
      /exec\s*\(/,
      /execSync\s*\(/,
    ],
    global_pollution: [/global\./, /process\.env/, /__proto__/],
    prototype_escape: [
      /\.constructor\s*\.\s*constructor/,
      /arguments\s*\.\s*callee/,
      /this\s*\.\s*constructor/,
    ],
    reflection_escape: [
      /\bReflect\s*\./,
      /\bProxy\b/,
      /\bWeakRef\b/,
      /\bSharedArrayBuffer\b/,
      /\bAtomics\b/,
    ],
    worker_escape: [/\bWorker\b/, /\bparentPort\b/, /\bglobalThis\b/],
  };

  // 权限配置
  private permissionConfig: PermissionConfig = {
    roles: {
      admin: ['*'],
      developer: [
        'code:read',
        'code:write',
        'code:execute',
        'file:read',
        'file:write',
        'tool:use',
      ],
      user: ['code:read', 'file:read', 'tool:use'],
      guest: ['code:read'],
    },
    resources: {
      code: {
        allowedRoles: ['admin', 'developer', 'user', 'guest'],
        allowedActions: ['read', 'write', 'execute', 'delete'],
      },
      file: {
        allowedRoles: ['admin', 'developer', 'user'],
        allowedActions: ['read', 'write', 'delete'],
      },
      tool: {
        allowedRoles: ['admin', 'developer', 'user'],
        allowedActions: ['use', 'configure'],
      },
      system: {
        allowedRoles: ['admin'],
        allowedActions: ['read', 'write', 'execute'],
      },
    },
  };

  // 用户角色映射
  private userRoles: Map<string, UserRole> = new Map();

  // 安全审计日志 - P0-4 修复: 增加上限常量，使用环形缓冲策略
  private static readonly AUDIT_LOG_MAX = 2000;
  private static readonly AUDIT_LOG_TRIM_TO = 1500;
  private auditLogs: Array<{
    timestamp: Date;
    userId: string;
    action: string;
    resource: string;
    result: 'allow' | 'deny';
    reason?: string;
    traceId?: string;
  }> = [];

  constructor() {
    // 私有构造函数，使用单例模式
  }

  public static create(): SecurityGuard {
    return new SecurityGuard();
  }

  public static getInstance(): SecurityGuard {
    if (!SecurityGuard.instance) {
      if (SecurityGuard.instanceLock) {
        while (!SecurityGuard.instance) {
          void 0;
        }
        return SecurityGuard.instance;
      }
      SecurityGuard.instanceLock = true;
      try {
        if (!SecurityGuard.instance) {
          SecurityGuard.instance = new SecurityGuard();
        }
      } finally {
        SecurityGuard.instanceLock = false;
      }
    }
    return SecurityGuard.instance;
  }

  public static resetInstance(): void {
    SecurityGuard.instance = null;
    SecurityGuard.instanceLock = false;
  }

  /**
   * 设置用户角色
   */
  public setUserRole(userId: string, role: UserRole): void {
    this.userRoles.set(userId, role);
    Logger.info(`👤 设置用户角色: ${userId} -> ${role}`, 'SecurityGuard');
  }

  /**
   * 获取用户角色
   */
  public getUserRole(userId: string): UserRole {
    return this.userRoles.get(userId) || 'guest';
  }

  /**
   * 校验输入内容
   * @param input 输入内容
   * @param maxLength 最大长度限制
   * @returns 校验结果
   */
  public validateInput(
    input: string,
    maxLength: number = 10000
  ): SecurityCheckResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. 空值检查
    if (!input || input.trim().length === 0) {
      errors.push('输入不能为空');
      return { valid: false, errors, warnings };
    }

    // 2. 长度检查
    if (input.length > maxLength) {
      errors.push(`输入长度超过限制 (${input.length} > ${maxLength})`);
      return { valid: false, errors, warnings };
    }

    // 3. SQL注入检查
    for (const pattern of this.sqlInjectionPatterns) {
      if (pattern.test(input)) {
        errors.push(`检测到潜在的SQL注入模式`);
        warnings.push(`匹配模式: ${pattern.source}`);
      }
    }

    // 4. XSS攻击检查
    for (const pattern of this.xssPatterns) {
      if (pattern.test(input)) {
        errors.push(`检测到潜在的XSS攻击模式`);
        warnings.push(`匹配模式: ${pattern.source}`);
      }
    }

    // 5. 安全红线检查
    for (const pattern of this.securityRedlines) {
      if (pattern.test(input)) {
        errors.push(`违反安全红线规则`);
        warnings.push(`匹配模式: ${pattern.source}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * 校验命令参数
   * @param command 命令字符串
   * @returns 校验结果
   */
  public validateCommand(command: string): SecurityCheckResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. 空值检查
    if (!command || command.trim().length === 0) {
      errors.push('命令不能为空');
      return { valid: false, errors, warnings };
    }

    // 2. 命令注入检查
    for (const pattern of this.commandInjectionPatterns) {
      if (pattern.test(command)) {
        errors.push(`检测到潜在的命令注入模式`);
        warnings.push(`匹配模式: ${pattern.source}`);
      }
    }

    // 3. 危险命令检查
    const dangerousCommands = [
      'rm -rf',
      'del /s',
      'format',
      'shutdown',
      'reboot',
      'kill',
    ];
    for (const dangerous of dangerousCommands) {
      if (command.toLowerCase().includes(dangerous)) {
        errors.push(`检测到危险命令: ${dangerous}`);
      }
    }

    // 4. 路径遍历检查
    if (command.includes('../') || command.includes('..\\')) {
      errors.push('检测到路径遍历尝试');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * 清理shell输入中的特殊字符
   * @param input 输入字符串
   * @returns 清理后的字符串
   */
  public sanitizeShellInput(input: string): string {
    if (!input) return '';

    // 转义特殊字符
    return input
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/'/g, "\\'")
      .replace(/`/g, '\\`')
      .replace(/\$/g, '\\$')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}')
      .replace(/\|/g, '\\|')
      .replace(/;/g, '\\;')
      .replace(/&/g, '\\&')
      .replace(/</g, '\\<')
      .replace(/>/g, '\\>');
  }

  /**
   * 沙箱检查 - 检查代码安全性
   * @param code 要执行的代码
   * @param language 代码语言
   * @returns 检查结果
   */
  public sandboxCheck(
    code: string,
    _language: string = 'javascript'
  ): SecurityCheckResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!code || code.trim().length === 0) {
      errors.push('代码不能为空');
      return { valid: false, errors, warnings };
    }

    // 检查危险代码模式
    for (const [category, patterns] of Object.entries(
      this.dangerousCodePatterns
    )) {
      for (const pattern of patterns) {
        if (pattern.test(code)) {
          const categoryNames: Record<string, string> = {
            eval: '动态代码执行',
            network: '网络请求',
            filesystem: '文件系统操作',
            infinite_loop: '无限循环',
            child_process: '子进程调用',
            global_pollution: '全局变量污染',
            prototype_escape: '原型链逃逸',
            reflection_escape: '反射API逃逸',
            worker_escape: 'Worker/线程逃逸',
          };

          if (
            category === 'eval' ||
            category === 'child_process' ||
            category === 'prototype_escape' ||
            category === 'reflection_escape' ||
            category === 'worker_escape'
          ) {
            errors.push(
              `检测到危险操作: ${categoryNames[category] || category}`
            );
          } else {
            warnings.push(
              `检测到潜在风险: ${categoryNames[category] || category}`
            );
          }
        }
      }
    }

    // 检查无限循环（简单启发式）
    const loopMatches = code.match(/while\s*\([^)]*\)/g);
    if (loopMatches) {
      for (const loop of loopMatches) {
        // 检查是否有退出条件
        if (loop.includes('true') && !code.includes('break')) {
          warnings.push('检测到可能的无退出循环，建议添加 break 条件');
        }
      }
    }

    // 检查内存泄漏风险
    if (code.includes('setInterval') && !code.includes('clearInterval')) {
      warnings.push('使用 setInterval 但未清理，可能导致内存泄漏');
    }

    // 检查敏感信息泄露
    const sensitivePatterns = [
      /password\s*[:=]/i,
      /secret\s*[:=]/i,
      /token\s*[:=]/i,
      /api[_-]?key\s*[:=]/i,
    ];
    for (const pattern of sensitivePatterns) {
      if (pattern.test(code)) {
        warnings.push('代码中可能包含敏感信息，请检查');
        break;
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * 权限检查 - 基于角色的访问控制
   * @param userId 用户ID
   * @param resource 资源
   * @param action 操作
   * @returns 是否有权限
   */
  public permissionCheck(
    userId: string,
    resource: string,
    action: string
  ): boolean {
    const role = this.getUserRole(userId);
    const userPermissions = this.permissionConfig.roles[role] || [];

    // admin 拥有所有权限
    if (userPermissions.includes('*')) {
      this.logAudit(userId, action, resource, 'allow', 'admin权限');
      return true;
    }

    // 检查资源权限配置
    const resourceConfig = this.permissionConfig.resources[resource];
    if (!resourceConfig) {
      this.logAudit(userId, action, resource, 'deny', '资源未配置');
      return false;
    }

    // 检查角色是否允许访问该资源
    if (!resourceConfig.allowedRoles.includes(role)) {
      this.logAudit(
        userId,
        action,
        resource,
        'deny',
        `角色 ${role} 无权访问资源 ${resource}`
      );
      return false;
    }

    // 检查操作是否被允许
    if (!resourceConfig.allowedActions.includes(action)) {
      this.logAudit(
        userId,
        action,
        resource,
        'deny',
        `操作 ${action} 不被允许`
      );
      return false;
    }

    // 检查用户是否有具体权限
    const requiredPermission = `${resource}:${action}`;
    const hasPermission =
      userPermissions.includes(requiredPermission) ||
      userPermissions.includes(`${resource}:*`);

    if (!hasPermission) {
      this.logAudit(
        userId,
        action,
        resource,
        'deny',
        `缺少权限: ${requiredPermission}`
      );
      return false;
    }

    this.logAudit(userId, action, resource, 'allow');
    return true;
  }

  /**
   * 记录安全审计日志
   */
  private logAudit(
    userId: string,
    action: string,
    resource: string,
    result: 'allow' | 'deny',
    reason?: string
  ): void {
    this.auditLogs.push({
      timestamp: new Date(),
      userId,
      action,
      resource,
      result,
      reason,
    });

    // 限制日志数量 - P0-4 修复: 使用常量控制，避免抖动
    if (this.auditLogs.length > SecurityGuard.AUDIT_LOG_MAX) {
      this.auditLogs = this.auditLogs.slice(-SecurityGuard.AUDIT_LOG_TRIM_TO);
    }

    Logger.debug(
      `🔐 权限检查: ${userId} ${action} ${resource} -> ${result}${reason ? ` (${reason})` : ''}`,
      'SecurityGuard'
    );
  }

  /**
   * 获取审计日志
   */
  public getAuditLogs(options?: {
    userId?: string;
    resource?: string;
    startTime?: Date;
    endTime?: Date;
    limit?: number;
  }): typeof this.auditLogs {
    let logs = [...this.auditLogs];

    if (options?.userId) {
      logs = logs.filter((log) => log.userId === options.userId);
    }

    if (options?.resource) {
      logs = logs.filter((log) => log.resource === options.resource);
    }

    if (options?.startTime) {
      logs = logs.filter((log) => log.timestamp >= options.startTime!);
    }

    if (options?.endTime) {
      logs = logs.filter((log) => log.timestamp <= options.endTime!);
    }

    if (options?.limit) {
      logs = logs.slice(-options.limit);
    }

    return logs;
  }

  /**
   * 验证生成代码的安全性（针对 AI 生成代码的专用检查）
   * @param code 生成的代码
   * @param language 代码语言
   * @returns 验证结果
   */
  public validateGeneratedCode(
    code: string,
    language: string = 'javascript'
  ): SecurityCheckResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!code || code.trim().length === 0) {
      errors.push('生成的代码为空');
      return { valid: false, errors, warnings };
    }

    const trimmedCode = code.trim();

    // 1. 先执行常规沙箱检查
    const sandboxResult = this.sandboxCheck(trimmedCode, language);
    errors.push(...sandboxResult.errors);
    warnings.push(...sandboxResult.warnings);

    // 2. 检查代码完整性 - 括号匹配
    const openBraces = (trimmedCode.match(/\{/g) || []).length;
    const closeBraces = (trimmedCode.match(/\}/g) || []).length;
    const openParens = (trimmedCode.match(/\(/g) || []).length;
    const closeParens = (trimmedCode.match(/\)/g) || []).length;

    if (openBraces !== closeBraces) {
      warnings.push(
        `花括号不匹配: 开 ${openBraces} 个, 关 ${closeBraces} 个，代码可能不完整`
      );
    }
    if (openParens !== closeParens) {
      warnings.push(
        `圆括号不匹配: 开 ${openParens} 个, 关 ${closeParens} 个，代码可能不完整`
      );
    }

    // 3. 检查未完成的代码标记
    const incompleteMarkers = [
      'TODO',
      'FIXME',
      'XXX',
      'HACK',
      'PLACEHOLDER',
      'IMPLEMENT',
    ];
    for (const marker of incompleteMarkers) {
      const regex = new RegExp(`\\b${marker}\\b`, 'i');
      if (regex.test(trimmedCode)) {
        warnings.push(`代码包含 ${marker} 标记，生成可能未完成`);
      }
    }

    // 4. 检查硬编码敏感信息
    const sensitivePatterns = [
      {
        pattern: /password\s*[:=]\s*['"][^'"]+['"]/i,
        message: '检测到硬编码密码',
      },
      {
        pattern: /secret\s*[:=]\s*['"][^'"]+['"]/i,
        message: '检测到硬编码密钥',
      },
      {
        pattern: /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i,
        message: '检测到硬编码 API Key',
      },
      {
        pattern: /token\s*[:=]\s*['"][^'"]+['"]/i,
        message: '检测到硬编码 Token',
      },
      {
        pattern: /private[_-]?key\s*[:=]\s*['"][^'"]+['"]/i,
        message: '检测到硬编码私钥',
      },
    ];

    for (const { pattern, message } of sensitivePatterns) {
      if (pattern.test(trimmedCode)) {
        warnings.push(message);
      }
    }

    // 5. 检查未处理的 Promise（TypeScript/JavaScript）
    if (
      language.toLowerCase() === 'typescript' ||
      language.toLowerCase() === 'javascript'
    ) {
      if (
        /new\s+Promise|\.then\s*\(|async\s+function|async\s*\(/.test(
          trimmedCode
        ) &&
        !/catch\s*\(|\.catch\s*\(/.test(trimmedCode)
      ) {
        warnings.push('检测到异步操作但缺少错误处理（catch）');
      }
    }

    // 6. 检查潜在的无限递归
    const functionMatches = trimmedCode.match(/function\s+(\w+)\s*\(/g) || [];
    for (const fnMatch of functionMatches) {
      const fnName = fnMatch.replace(/function\s+/, '').replace(/\s*\($/, '');
      const fnBodyRegex = new RegExp(
        `function\\s+${fnName}\\s*\\([^)]*\\)\\s*\\{([^}]*)\\}`,
        's'
      );
      const fnBodyMatch = trimmedCode.match(fnBodyRegex);
      if (fnBodyMatch && fnBodyMatch[1]) {
        const selfCallRegex = new RegExp(`\\b${fnName}\\s*\\(`);
        if (selfCallRegex.test(fnBodyMatch[1])) {
          if (!/if\s*\(|return\s+/.test(fnBodyMatch[1])) {
            warnings.push(`函数 ${fnName} 可能包含无限递归，缺少终止条件`);
          }
        }
      }
    }

    // 7. 检查是否有实际实现内容
    const codeLines = trimmedCode.split('\n').filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed.length > 0 &&
        !trimmed.startsWith('//') &&
        !trimmed.startsWith('#') &&
        !trimmed.startsWith('/*') &&
        !trimmed.startsWith('*')
      );
    });

    if (codeLines.length === 0) {
      errors.push('代码没有实际实现内容（仅包含注释）');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * 资源限制检查
   * @param resourceType 资源类型
   * @param usage 使用量
   * @returns 是否超过限制
   */
  public resourceLimitCheck(
    resourceType: string,
    usage: number
  ): { allowed: boolean; limit: number } {
    const limits: Record<string, number> = {
      memory: 512 * 1024 * 1024, // 512MB
      disk: 1024 * 1024 * 1024, // 1GB
      cpu: 80, // 80%
      time: 30000, // 30秒
    };

    const limit = limits[resourceType] || Infinity;
    const allowed = usage <= limit;

    if (!allowed) {
      Logger.warn(
        `⚠️ 安全守卫：资源使用超过限制 - ${resourceType}: ${usage} > ${limit}`,
        'SecurityGuard'
      );
    }

    return { allowed, limit };
  }

  /**
   * 带安全防护的执行
   * @param callback 要执行的回调函数
   * @param context 安全上下文
   * @returns 执行结果
   */
  public async executeWithProtection<T>(
    callback: () => Promise<T>,
    context: SecurityContext = {}
  ): Promise<T> {
    const timeout = context.timeout || 30000;
    const userId = context.userId || 'anonymous';
    const traceId = context.traceId || 'unknown';

    Logger.debug(
      `🛡️ 安全守卫：开始执行保护 - userId=${userId}, traceId=${traceId}`,
      'SecurityGuard'
    );

    try {
      // 1. 超时控制
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`执行超时 (${timeout}ms)`)), timeout);
      });

      // 2. 执行回调并应用超时
      const result = await Promise.race([callback(), timeoutPromise]);

      // 3. 结果过滤（可选：检查结果大小）
      const maxOutputSize = context.maxOutputSize || 1024 * 1024 * 10; // 10MB
      const resultStr = JSON.stringify(result);
      if (resultStr.length > maxOutputSize) {
        Logger.warn(
          `⚠️ 安全守卫：输出大小超过限制 (${resultStr.length} > ${maxOutputSize})`,
          'SecurityGuard'
        );
      }

      Logger.debug(`✅ 安全守卫：执行完成 - userId=${userId}`, 'SecurityGuard');
      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // 记录安全事件
      Logger.error(
        `❌ 安全守卫：执行失败 - ${errorMessage}`,
        error as Error,
        'SecurityGuard'
      );

      throw error;
    }
  }
}
