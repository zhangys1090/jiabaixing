/**
 * 错误监控系统
 */

export enum ErrorLevel {
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
  CRITICAL = 'critical',
}

export enum ErrorType {
  RUNTIME = 'runtime',
  RESOURCE = 'resource',
  NETWORK = 'network',
  UNKNOWN = 'unknown',
}

interface ErrorData {
  message: string;
  stack?: string;
  level: ErrorLevel;
  type: ErrorType;
  url?: string;
  line?: number;
  column?: number;
  statusCode?: number;
  timestamp: number;
  userAgent: string;
  pageUrl: string;
  additionalData?: Record<string, unknown>;
}

class ErrorMonitor {
  private isInitialized = false;

  public initialize(): void {
    if (this.isInitialized) return;

    window.addEventListener('error', this.handleRuntimeError.bind(this));

    window.addEventListener('unhandledrejection', this.handlePromiseRejection.bind(this));

    window.addEventListener('error', this.handleResourceError.bind(this), true);

    this.isInitialized = true;
    console.log('[ErrorMonitor] 错误监控系统已初始化');
  }

  private handleRuntimeError(event: ErrorEvent): void {
    if (event.target instanceof Element || event.target instanceof HTMLElement) {
      return;
    }

    const errorData: ErrorData = {
      message: event.message,
      stack: event.error?.stack,
      level: ErrorLevel.ERROR,
      type: ErrorType.RUNTIME,
      url: event.filename,
      line: event.lineno,
      column: event.colno,
      timestamp: Date.now(),
      userAgent: navigator.userAgent,
      pageUrl: window.location.href,
    };

    void this.reportError(errorData);
  }

  private handleResourceError(event: ErrorEvent): void {
    if (event.target instanceof Element || event.target instanceof HTMLElement) {
      const target = event.target as HTMLElement;
      const tagName = target.tagName.toLowerCase();

      if (
        tagName === 'script' ||
        tagName === 'link' ||
        tagName === 'img' ||
        tagName === 'video' ||
        tagName === 'audio'
      ) {
        const errorData: ErrorData = {
          message: `资源加载失败: ${(target as unknown as { src?: string }).src || (target as unknown as { href?: string }).href}`,
          level: ErrorLevel.WARN,
          type: ErrorType.RESOURCE,
          url: (target as unknown as { src?: string }).src || (target as unknown as { href?: string }).href,
          timestamp: Date.now(),
          userAgent: navigator.userAgent,
          pageUrl: window.location.href,
          additionalData: {
            tagName,
          },
        };

        void this.reportError(errorData);
      }
    }
  }

  private handlePromiseRejection(event: PromiseRejectionEvent): void {
    const errorData: ErrorData = {
      message: (event.reason as { message?: string })?.message || String(event.reason),
      stack: (event.reason as { stack?: string })?.stack,
      level: ErrorLevel.ERROR,
      type: ErrorType.RUNTIME,
      timestamp: Date.now(),
      userAgent: navigator.userAgent,
      pageUrl: window.location.href,
      additionalData: {
        reason: event.reason,
      },
    };

    void this.reportError(errorData);
  }

  public reportNetworkError(url: string, statusCode: number, message: string): void {
    const errorData: ErrorData = {
      message: `网络请求失败: ${url} (${statusCode}) - ${message}`,
      level: statusCode >= 500 ? ErrorLevel.ERROR : ErrorLevel.WARN,
      type: ErrorType.NETWORK,
      url,
      statusCode,
      timestamp: Date.now(),
      userAgent: navigator.userAgent,
      pageUrl: window.location.href,
    };

    void this.reportError(errorData);
  }

  public reportCustomError(
    message: string,
    level: ErrorLevel = ErrorLevel.ERROR,
    additionalData?: Record<string, unknown>
  ): void {
    const errorData: ErrorData = {
      message,
      level,
      type: ErrorType.UNKNOWN,
      timestamp: Date.now(),
      userAgent: navigator.userAgent,
      pageUrl: window.location.href,
      additionalData,
    };

    void this.reportError(errorData);
  }

  private async reportError(errorData: ErrorData): Promise<void> {
    try {
      const apiBaseUrl = process.env.REACT_APP_API_BASE_URL || window.location.origin;
      const normalizedBaseUrl = apiBaseUrl.endsWith('/api') ? apiBaseUrl : `${apiBaseUrl}/api`;

      await fetch(`${normalizedBaseUrl}/error/monitoring`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(errorData),
      });
    } catch (error) {
      console.error('发送错误报告失败:', error);
    }
  }
}

export const errorMonitor = new ErrorMonitor();
