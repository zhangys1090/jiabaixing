"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DependencyResolutionError = exports.SandboxExecutionError = exports.CircuitBreakerOpenError = exports.ConcurrencyError = exports.ValidationError = exports.PythonBackendUnavailableError = exports.PythonBackendError = exports.EvolutionError = exports.MemoryError = exports.SensitiveInfoDetectedError = exports.SecurityViolationError = exports.TokenQuotaExceededError = exports.BudgetExceededError = exports.ToolPermissionDeniedError = exports.ToolNotFoundError = exports.ToolExecutionError = exports.LLMTimeoutError = exports.LLMRateLimitError = exports.LLMError = exports.JiabaixingError = void 0;
exports.isJiabaixingError = isJiabaixingError;
exports.isOperationalError = isOperationalError;
exports.toJiabaixingError = toJiabaixingError;
exports.formatErrorResponse = formatErrorResponse;
exports.safeExecute = safeExecute;
exports.safeExecuteSync = safeExecuteSync;
class JiabaixingError extends Error {
    code;
    statusCode;
    isOperational;
    timestamp;
    context;
    constructor(message, code, statusCode = 500, isOperational = true, context = {}) {
        super(message);
        this.name = this.constructor.name;
        this.code = code;
        this.statusCode = statusCode;
        this.isOperational = isOperational;
        this.timestamp = new Date().toISOString();
        this.context = context;
        Object.setPrototypeOf(this, new.target.prototype);
    }
    toJSON() {
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
exports.JiabaixingError = JiabaixingError;
class LLMError extends JiabaixingError {
    constructor(message, context = {}) {
        super(message, 'LLM_ERROR', 502, true, context);
    }
}
exports.LLMError = LLMError;
class LLMRateLimitError extends LLMError {
    constructor(retryAfterMs, context = {}) {
        super(`LLM速率限制，${retryAfterMs}ms后重试`, { ...context, retryAfterMs });
        this.code = 'LLM_RATE_LIMITED';
        this.statusCode = 429;
    }
}
exports.LLMRateLimitError = LLMRateLimitError;
class LLMTimeoutError extends LLMError {
    constructor(timeoutMs, context = {}) {
        super(`LLM请求超时 (${timeoutMs}ms)`, { ...context, timeoutMs });
        this.code = 'LLM_TIMEOUT';
        this.statusCode = 504;
    }
}
exports.LLMTimeoutError = LLMTimeoutError;
class ToolExecutionError extends JiabaixingError {
    toolName;
    constructor(toolName, message, context = {}) {
        super(message, 'TOOL_EXECUTION_ERROR', 500, true, { ...context, toolName });
        this.toolName = toolName;
        this.code = 'TOOL_EXECUTION_ERROR';
    }
}
exports.ToolExecutionError = ToolExecutionError;
class ToolNotFoundError extends JiabaixingError {
    toolName;
    constructor(toolName, context = {}) {
        super(`工具未找到: ${toolName}`, 'TOOL_NOT_FOUND', 404, true, {
            ...context,
            toolName,
        });
        this.toolName = toolName;
    }
}
exports.ToolNotFoundError = ToolNotFoundError;
class ToolPermissionDeniedError extends JiabaixingError {
    toolName;
    permission;
    constructor(toolName, permission, context = {}) {
        super(`工具权限不足: ${toolName} 需要 ${permission}`, 'TOOL_PERMISSION_DENIED', 403, true, { ...context, toolName, permission });
        this.toolName = toolName;
        this.permission = permission;
    }
}
exports.ToolPermissionDeniedError = ToolPermissionDeniedError;
class BudgetExceededError extends JiabaixingError {
    budgetType;
    current;
    limit;
    constructor(budgetType, current, limit, context = {}) {
        super(`预算超限: ${budgetType} (当前: ${current}, 上限: ${limit})`, 'BUDGET_EXCEEDED', 429, true, { ...context, budgetType, current, limit });
        this.budgetType = budgetType;
        this.current = current;
        this.limit = limit;
    }
}
exports.BudgetExceededError = BudgetExceededError;
class TokenQuotaExceededError extends BudgetExceededError {
    constructor(current, limit, sessionId) {
        super('session_token_quota', current, limit, { sessionId });
        this.code = 'TOKEN_QUOTA_EXCEEDED';
    }
}
exports.TokenQuotaExceededError = TokenQuotaExceededError;
class SecurityViolationError extends JiabaixingError {
    violationType;
    constructor(violationType, message, context = {}) {
        super(message, 'SECURITY_VIOLATION', 403, true, {
            ...context,
            violationType,
        });
        this.violationType = violationType;
    }
}
exports.SecurityViolationError = SecurityViolationError;
class SensitiveInfoDetectedError extends SecurityViolationError {
    constructor(infoType, context = {}) {
        super('sensitive_info', `检测到敏感信息: ${infoType}`, {
            ...context,
            infoType,
        });
        this.code = 'SENSITIVE_INFO_DETECTED';
    }
}
exports.SensitiveInfoDetectedError = SensitiveInfoDetectedError;
class MemoryError extends JiabaixingError {
    constructor(message, context = {}) {
        super(message, 'MEMORY_ERROR', 500, true, context);
    }
}
exports.MemoryError = MemoryError;
class EvolutionError extends JiabaixingError {
    constructor(message, context = {}) {
        super(message, 'EVOLUTION_ERROR', 500, true, context);
    }
}
exports.EvolutionError = EvolutionError;
class PythonBackendError extends JiabaixingError {
    constructor(message, context = {}) {
        super(message, 'PYTHON_BACKEND_ERROR', 502, true, context);
    }
}
exports.PythonBackendError = PythonBackendError;
class PythonBackendUnavailableError extends PythonBackendError {
    constructor(url, context = {}) {
        super(`Python后端不可用: ${url}`, { ...context, url });
        this.code = 'PYTHON_BACKEND_UNAVAILABLE';
    }
}
exports.PythonBackendUnavailableError = PythonBackendUnavailableError;
class ValidationError extends JiabaixingError {
    field;
    constructor(field, message, context = {}) {
        super(message, 'VALIDATION_ERROR', 400, true, { ...context, field });
        this.field = field;
    }
}
exports.ValidationError = ValidationError;
class ConcurrencyError extends JiabaixingError {
    constructor(message, context = {}) {
        super(message, 'CONCURRENCY_ERROR', 409, true, context);
    }
}
exports.ConcurrencyError = ConcurrencyError;
class CircuitBreakerOpenError extends JiabaixingError {
    toolName;
    failureCount;
    constructor(toolName, failureCount, context = {}) {
        super(`工具 ${toolName} 熔断器已打开 (连续失败 ${failureCount} 次)`, 'CIRCUIT_BREAKER_OPEN', 503, true, { ...context, toolName, failureCount });
        this.toolName = toolName;
        this.failureCount = failureCount;
    }
}
exports.CircuitBreakerOpenError = CircuitBreakerOpenError;
class SandboxExecutionError extends JiabaixingError {
    violations;
    constructor(message, violations = [], context = {}) {
        super(message, 'SANDBOX_EXECUTION_ERROR', 500, true, {
            ...context,
            violations,
        });
        this.violations = violations;
        this.code = 'SANDBOX_EXECUTION_ERROR';
    }
}
exports.SandboxExecutionError = SandboxExecutionError;
class DependencyResolutionError extends JiabaixingError {
    token;
    constructor(token, message, context = {}) {
        super(message, 'DEPENDENCY_RESOLUTION_ERROR', 500, true, {
            ...context,
            token,
        });
        this.token = token;
    }
}
exports.DependencyResolutionError = DependencyResolutionError;
function isJiabaixingError(error) {
    return error instanceof JiabaixingError;
}
function isOperationalError(error) {
    if (error instanceof JiabaixingError) {
        return error.isOperational;
    }
    return false;
}
function toJiabaixingError(error, defaultMessage = '未知错误') {
    if (error instanceof JiabaixingError) {
        return error;
    }
    if (error instanceof Error) {
        return new JiabaixingError(error.message || defaultMessage, 'UNKNOWN_ERROR', 500, false, { originalName: error.name, originalStack: error.stack });
    }
    return new JiabaixingError(defaultMessage, 'UNKNOWN_ERROR', 500, false, {
        originalError: String(error),
    });
}
function formatErrorResponse(error) {
    const jxError = toJiabaixingError(error);
    return {
        error: jxError.message,
        code: jxError.code,
        statusCode: jxError.statusCode,
        details: jxError.isOperational ? jxError.context : undefined,
    };
}
async function safeExecute(fn, onError) {
    try {
        const value = await fn();
        return { ok: true, value };
    }
    catch (err) {
        const jxError = toJiabaixingError(err);
        if (onError) {
            const value = onError(jxError);
            return { ok: true, value };
        }
        return { ok: false, error: jxError };
    }
}
function safeExecuteSync(fn, onError) {
    try {
        const value = fn();
        return { ok: true, value };
    }
    catch (err) {
        const jxError = toJiabaixingError(err);
        if (onError) {
            const value = onError(jxError);
            return { ok: true, value };
        }
        return { ok: false, error: jxError };
    }
}
