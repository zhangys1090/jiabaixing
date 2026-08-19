export class JiabaixingError extends Error {
  public code: string;
  public statusCode: number;
  public isOperational: boolean;
  public timestamp: string;
  public context: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    statusCode: number = 500,
    isOperational: boolean = true,
    context: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.timestamp = new Date().toISOString();
    this.context = context;

    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      isOperational: this.isOperational,
      timestamp: this.timestamp,
      context: this.context,
    };
  }
}

export class LLMError extends JiabaixingError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'LLM_ERROR', 502, true, context);
  }
}

export class LLMRateLimitError extends LLMError {
  constructor(retryAfterMs: number, context: Record<string, unknown> = {}) {
    super(`LLM速率限制，${retryAfterMs}ms后重试`, { ...context, retryAfterMs });
    this.code = 'LLM_RATE_LIMITED';
    this.statusCode = 429;
  }
}

export class LLMTimeoutError extends LLMError {
  constructor(timeoutMs: number, context: Record<string, unknown> = {}) {
    super(`LLM请求超时 (${timeoutMs}ms)`, { ...context, timeoutMs });
    this.code = 'LLM_TIMEOUT';
    this.statusCode = 504;
  }
}

export class ToolExecutionError extends JiabaixingError {
  public readonly toolName: string;

  constructor(
    toolName: string,
    message: string,
    context: Record<string, unknown> = {}
  ) {
    super(message, 'TOOL_EXECUTION_ERROR', 500, true, { ...context, toolName });
    this.toolName = toolName;
    this.code = 'TOOL_EXECUTION_ERROR';
  }
}

export class ToolNotFoundError extends JiabaixingError {
  public readonly toolName: string;

  constructor(toolName: string, context: Record<string, unknown> = {}) {
    super(`工具未找到: ${toolName}`, 'TOOL_NOT_FOUND', 404, true, {
      ...context,
      toolName,
    });
    this.toolName = toolName;
  }
}

export class ToolPermissionDeniedError extends JiabaixingError {
  public readonly toolName: string;
  public readonly permission: string;

  constructor(
    toolName: string,
    permission: string,
    context: Record<string, unknown> = {}
  ) {
    super(
      `工具权限不足: ${toolName} 需要 ${permission}`,
      'TOOL_PERMISSION_DENIED',
      403,
      true,
      { ...context, toolName, permission }
    );
    this.toolName = toolName;
    this.permission = permission;
  }
}

export class BudgetExceededError extends JiabaixingError {
  public readonly budgetType: string;
  public readonly current: number;
  public readonly limit: number;

  constructor(
    budgetType: string,
    current: number,
    limit: number,
    context: Record<string, unknown> = {}
  ) {
    super(
      `预算超限: ${budgetType} (当前: ${current}, 上限: ${limit})`,
      'BUDGET_EXCEEDED',
      429,
      true,
      { ...context, budgetType, current, limit }
    );
    this.budgetType = budgetType;
    this.current = current;
    this.limit = limit;
  }
}

export class TokenQuotaExceededError extends BudgetExceededError {
  constructor(current: number, limit: number, sessionId: string) {
    super('session_token_quota', current, limit, { sessionId });
    this.code = 'TOKEN_QUOTA_EXCEEDED';
  }
}

export class SecurityViolationError extends JiabaixingError {
  public readonly violationType: string;

  constructor(
    violationType: string,
    message: string,
    context: Record<string, unknown> = {}
  ) {
    super(message, 'SECURITY_VIOLATION', 403, true, {
      ...context,
      violationType,
    });
    this.violationType = violationType;
  }
}

export class SensitiveInfoDetectedError extends SecurityViolationError {
  constructor(infoType: string, context: Record<string, unknown> = {}) {
    super('sensitive_info', `检测到敏感信息: ${infoType}`, {
      ...context,
      infoType,
    });
    this.code = 'SENSITIVE_INFO_DETECTED';
  }
}

export class MemoryError extends JiabaixingError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'MEMORY_ERROR', 500, true, context);
  }
}

export class EvolutionError extends JiabaixingError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'EVOLUTION_ERROR', 500, true, context);
  }
}

export class PythonBackendError extends JiabaixingError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'PYTHON_BACKEND_ERROR', 502, true, context);
  }
}

export class PythonBackendUnavailableError extends PythonBackendError {
  constructor(url: string, context: Record<string, unknown> = {}) {
    super(`Python后端不可用: ${url}`, { ...context, url });
    this.code = 'PYTHON_BACKEND_UNAVAILABLE';
  }
}

export class ValidationError extends JiabaixingError {
  public readonly field: string;

  constructor(
    field: string,
    message: string,
    context: Record<string, unknown> = {}
  ) {
    super(message, 'VALIDATION_ERROR', 400, true, { ...context, field });
    this.field = field;
  }
}

export class ConcurrencyError extends JiabaixingError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'CONCURRENCY_ERROR', 409, true, context);
  }
}

export class CircuitBreakerOpenError extends JiabaixingError {
  public readonly toolName: string;
  public readonly failureCount: number;

  constructor(toolName: string, failureCount: number, context: Record<string, unknown> = {}) {
    super(`工具 ${toolName} 熔断器已打开 (连续失败 ${failureCount} 次)`, 'CIRCUIT_BREAKER_OPEN', 503, true, { ...context, toolName, failureCount });
    this.toolName = toolName;
    this.failureCount = failureCount;
  }
}

export class SandboxExecutionError extends JiabaixingError {
  public readonly violations: string[];

  constructor(message: string, violations: string[] = [], context: Record<string, unknown> = {}) {
    super(message, 'SANDBOX_EXECUTION_ERROR', 500, true, { ...context, violations });
    this.violations = violations;
    this.code = 'SANDBOX_EXECUTION_ERROR';
  }
}

export class DependencyResolutionError extends JiabaixingError {
  public readonly token: string;

  constructor(token: string, message: string, context: Record<string, unknown> = {}) {
    super(message, 'DEPENDENCY_RESOLUTION_ERROR', 500, true, { ...context, token });
    this.token = token;
  }
}

export function isJiabaixingError(error: unknown): error is JiabaixingError {
  return error instanceof JiabaixingError;
}

export function isOperationalError(error: unknown): boolean {
  if (error instanceof JiabaixingError) {
    return error.isOperational;
  }
  return false;
}

export function toJiabaixingError(
  error: unknown,
  defaultMessage: string = '未知错误'
): JiabaixingError {
  if (error instanceof JiabaixingError) {
    return error;
  }

  if (error instanceof Error) {
    return new JiabaixingError(
      error.message || defaultMessage,
      'UNKNOWN_ERROR',
      500,
      false,
      { originalName: error.name, originalStack: error.stack }
    );
  }

  return new JiabaixingError(defaultMessage, 'UNKNOWN_ERROR', 500, false, {
    originalError: String(error),
  });
}

export function formatErrorResponse(error: unknown): {
  error: string;
  code: string;
  statusCode: number;
  details?: Record<string, unknown>;
} {
  const jxError = toJiabaixingError(error);

  return {
    error: jxError.message,
    code: jxError.code,
    statusCode: jxError.statusCode,
    details: jxError.isOperational ? jxError.context : undefined,
  };
}

export async function safeExecute<T>(
  fn: () => Promise<T>,
  onError?: (error: JiabaixingError) => T
): Promise<{ ok: true; value: T } | { ok: false; error: JiabaixingError }> {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (err) {
    const jxError = toJiabaixingError(err);
    if (onError) {
      const value = onError(jxError);
      return { ok: true, value };
    }
    return { ok: false, error: jxError };
  }
}

export function safeExecuteSync<T>(
  fn: () => T,
  onError?: (error: JiabaixingError) => T
): { ok: true; value: T } | { ok: false; error: JiabaixingError } {
  try {
    const value = fn();
    return { ok: true, value };
  } catch (err) {
    const jxError = toJiabaixingError(err);
    if (onError) {
      const value = onError(jxError);
      return { ok: true, value };
    }
    return { ok: false, error: jxError };
  }
}
