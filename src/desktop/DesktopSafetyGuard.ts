/**
 * 桌面Agent安全防护系统
 * 参考 Codex Computer Use 安全设计
 *
 * 安全层级：
 * 1. 事前拦截 - 危险操作黑名单
 * 2. 事中监控 - 操作频率、异常行为检测
 * 3. 紧急停止 - 快捷键、鼠标角、超时
 * 4. 事后回滚 - 检查点恢复
 */

import { EventEmitter } from 'events';
import { DesktopEventStream } from './DesktopEventStream';
import { Logger } from '../utils/Logger';

export type SafetyLevel = 'strict' | 'moderate' | 'permissive';

export interface SafetyConfig {
  level?: SafetyLevel;
  maxActionsPerMinute?: number;
  maxActionsPerTask?: number;
  enableMouseCornerStop?: boolean;
  enableKeyboardStop?: boolean;
  emergencyStopKey?: string;
  taskTimeoutMs?: number;
  requireConfirmationForDangerous?: boolean;
  allowedApps?: string[];
  forbiddenApps?: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
}

export interface DangerousAction {
  type: string;
  pattern: RegExp | string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  requireConfirmation: boolean;
}

const DEFAULT_CONFIG: Required<SafetyConfig> = {
  level: 'moderate',
  maxActionsPerMinute: 60,
  maxActionsPerTask: 100,
  enableMouseCornerStop: true,
  enableKeyboardStop: true,
  emergencyStopKey: 'Escape',
  taskTimeoutMs: 300000, // 5分钟
  requireConfirmationForDangerous: true,
  allowedApps: [],
  forbiddenApps: [],
  allowedPaths: [],
  forbiddenPaths: [],
};

// 危险操作定义
const DANGEROUS_ACTIONS: DangerousAction[] = [
  // 系统级危险操作
  {
    type: 'system',
    pattern: /shutdown|restart|halt|poweroff/i,
    severity: 'critical',
    description: '系统关机/重启操作',
    requireConfirmation: true,
  },
  {
    type: 'system',
    pattern: /taskkill.*\/f.*svchost|taskkill.*\/f.*explorer/i,
    severity: 'high',
    description: '终止系统关键进程',
    requireConfirmation: true,
  },
  // 文件删除危险操作
  {
    type: 'file',
    pattern: /rm\s+-rf\s+(\/|\/\*|C:\\Windows|C:\\Windows\\.*)/i,
    severity: 'critical',
    description: '删除系统目录',
    requireConfirmation: true,
  },
  {
    type: 'file',
    pattern: /format\s+[A-Z]:/i,
    severity: 'critical',
    description: '格式化磁盘',
    requireConfirmation: true,
  },
  {
    type: 'file',
    pattern: /del\s+\/s\s+.*\\Windows|del\s+\/s\s+.*\\System32/i,
    severity: 'critical',
    description: '删除系统文件',
    requireConfirmation: true,
  },
  // 注册表危险操作
  {
    type: 'registry',
    pattern: /reg\s+delete|reg\s+add\s+HKLM/i,
    severity: 'high',
    description: '修改系统注册表',
    requireConfirmation: true,
  },
  // 网络危险操作
  {
    type: 'network',
    pattern: /netsh\s+firewall|netsh\s+advfirewall/i,
    severity: 'medium',
    description: '修改防火墙规则',
    requireConfirmation: true,
  },
  // 用户管理危险操作
  {
    type: 'user',
    pattern: /net\s+user\s+.*\/add|net\s+localgroup\s+administrators/i,
    severity: 'high',
    description: '用户账户管理操作',
    requireConfirmation: true,
  },
  // 加密/擦除操作
  {
    type: 'security',
    pattern: /cipher\s+\/w/i,
    severity: 'high',
    description: '安全擦除磁盘空闲空间',
    requireConfirmation: true,
  },
  {
    type: 'security',
    pattern: /diskpart|bcdedit/i,
    severity: 'high',
    description: '磁盘分区/启动配置修改',
    requireConfirmation: true,
  },
];

export class DesktopSafetyGuard extends EventEmitter {
  private static instance: DesktopSafetyGuard | null = null;
  private config: Required<SafetyConfig>;
  private eventStream: DesktopEventStream;
  private isRunning: boolean = false;
  private isPaused: boolean = false;
  private isStopped: boolean = false;

  // 操作计数
  private actionCount: number = 0;
  private actionTimestamps: number[] = [];
  private taskStartTime: number = 0;

  // 紧急停止回调
  private emergencyStopCallbacks: Array<() => void> = [];

  private constructor(config?: SafetyConfig) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.eventStream = DesktopEventStream.getInstance();
  }

  public static getInstance(config?: SafetyConfig): DesktopSafetyGuard {
    if (!DesktopSafetyGuard.instance) {
      DesktopSafetyGuard.instance = new DesktopSafetyGuard(config);
    }
    return DesktopSafetyGuard.instance;
  }

  /**
   * 初始化安全防护
   */
  public async initialize(): Promise<void> {
    Logger.info('🛡️  安全防护系统初始化', 'SafetyGuard');
    Logger.info(`   安全级别: ${this.config.level}`, 'SafetyGuard');
    Logger.info(
      `   每分钟最大操作数: ${this.config.maxActionsPerMinute}`,
      'SafetyGuard'
    );
    Logger.info(
      `   任务超时: ${this.config.taskTimeoutMs / 1000}秒`,
      'SafetyGuard'
    );

    // 设置紧急停止监听
    if (this.config.enableKeyboardStop) {
      this.setupKeyboardStop();
    }

    if (this.config.enableMouseCornerStop) {
      this.setupMouseCornerStop();
    }

    this.isRunning = true;
    Logger.info('✅ 安全防护系统已启动', 'SafetyGuard');
  }

  /**
   * 开始任务前检查
   */
  public startTask(): void {
    this.actionCount = 0;
    this.actionTimestamps = [];
    this.taskStartTime = Date.now();
    this.isStopped = false;
    this.isPaused = false;
  }

  /**
   * 检查操作是否允许执行
   * 返回 { allowed: boolean, reason?: string, requireConfirmation?: boolean }
   */
  public checkAction(
    actionType: string,
    actionDescription: string,
    actionParams?: Record<string, unknown>
  ): {
    allowed: boolean;
    reason?: string;
    severity?: string;
    requireConfirmation?: boolean;
  } {
    if (this.isStopped) {
      return { allowed: false, reason: '已触发紧急停止' };
    }

    if (this.isPaused) {
      return { allowed: false, reason: '任务已暂停' };
    }

    // 1. 检查操作频率
    const rateCheck = this.checkRateLimit();
    if (!rateCheck.allowed) {
      return rateCheck;
    }

    // 2. 检查任务超时
    const timeoutCheck = this.checkTaskTimeout();
    if (!timeoutCheck.allowed) {
      return timeoutCheck;
    }

    // 3. 检查任务操作数限制
    if (this.actionCount >= this.config.maxActionsPerTask) {
      return {
        allowed: false,
        reason: `已达到单任务最大操作数: ${this.config.maxActionsPerTask}`,
        severity: 'medium',
      };
    }

    // 4. 检查危险操作
    const dangerCheck = this.checkDangerousAction(
      actionType,
      actionDescription,
      actionParams
    );
    if (dangerCheck.found) {
      const danger = dangerCheck.danger!;
      this.eventStream.emitSafetyWarning(
        danger.type,
        danger.description,
        danger.severity
      );

      if (this.config.level === 'strict') {
        return {
          allowed: false,
          reason: `危险操作已拦截: ${danger.description}`,
          severity: danger.severity,
        };
      }

      if (
        danger.requireConfirmation &&
        this.config.requireConfirmationForDangerous
      ) {
        return {
          allowed: false,
          reason: `需要用户确认: ${danger.description}`,
          severity: danger.severity,
          requireConfirmation: true,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * 记录操作执行
   */
  public recordAction(): void {
    this.actionCount++;
    this.actionTimestamps.push(Date.now());

    // 清理超过1分钟的时间戳
    const oneMinuteAgo = Date.now() - 60000;
    this.actionTimestamps = this.actionTimestamps.filter(
      (t) => t > oneMinuteAgo
    );
  }

  /**
   * 紧急停止
   */
  public emergencyStop(reason: string = '用户触发'): void {
    if (this.isStopped) return;

    this.isStopped = true;
    this.isRunning = false;

    Logger.warn(`🚨 紧急停止: ${reason}`, 'SafetyGuard');
    this.eventStream.emitSafetyWarning('emergency_stop', reason, 'high');

    // 调用所有紧急停止回调
    this.emergencyStopCallbacks.forEach((callback) => {
      try {
        callback();
      } catch (err) {
        Logger.error(
          `紧急停止回调错误: ${(err as Error).message}`,
          err as Error,
          'SafetyGuard'
        );
      }
    });

    this.emit('emergency_stop', { reason });
  }

  /**
   * 暂停任务
   */
  public pause(reason: string = '用户暂停'): void {
    this.isPaused = true;
    Logger.info(`⏸️  任务暂停: ${reason}`, 'SafetyGuard');
    this.emit('paused', { reason });
  }

  /**
   * 恢复任务
   */
  public resume(): void {
    this.isPaused = false;
    Logger.info('▶️  任务恢复', 'SafetyGuard');
    this.emit('resumed');
  }

  /**
   * 注册紧急停止回调
   */
  public onEmergencyStop(callback: () => void): () => void {
    this.emergencyStopCallbacks.push(callback);
    return () => {
      const index = this.emergencyStopCallbacks.indexOf(callback);
      if (index > -1) {
        this.emergencyStopCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * 更新安全配置
   */
  public updateConfig(config: Partial<SafetyConfig>): void {
    this.config = { ...this.config, ...config };
    Logger.info(
      `⚙️  安全配置已更新，级别: ${this.config.level}`,
      'SafetyGuard'
    );
  }

  /**
   * 获取当前安全状态
   */
  public getStatus(): {
    isRunning: boolean;
    isPaused: boolean;
    isStopped: boolean;
    actionCount: number;
    actionsPerMinute: number;
    level: SafetyLevel;
  } {
    const oneMinuteAgo = Date.now() - 60000;
    const actionsInLastMinute = this.actionTimestamps.filter(
      (t) => t > oneMinuteAgo
    ).length;

    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      isStopped: this.isStopped,
      actionCount: this.actionCount,
      actionsPerMinute: actionsInLastMinute,
      level: this.config.level,
    };
  }

  /**
   * 检查操作频率限制
   */
  private checkRateLimit(): { allowed: boolean; reason?: string } {
    const oneMinuteAgo = Date.now() - 60000;
    const actionsInLastMinute = this.actionTimestamps.filter(
      (t) => t > oneMinuteAgo
    ).length;

    if (actionsInLastMinute >= this.config.maxActionsPerMinute) {
      return {
        allowed: false,
        reason: `操作频率过高: ${actionsInLastMinute}次/分钟，限制: ${this.config.maxActionsPerMinute}次/分钟`,
      };
    }

    return { allowed: true };
  }

  /**
   * 检查任务超时
   */
  private checkTaskTimeout(): { allowed: boolean; reason?: string } {
    if (this.taskStartTime === 0) return { allowed: true };

    const elapsed = Date.now() - this.taskStartTime;
    if (elapsed >= this.config.taskTimeoutMs) {
      return {
        allowed: false,
        reason: `任务超时: ${Math.round(elapsed / 1000)}秒，限制: ${this.config.taskTimeoutMs / 1000}秒`,
      };
    }

    return { allowed: true };
  }

  /**
   * 检查是否为危险操作
   */
  private checkDangerousAction(
    actionType: string,
    description: string,
    params?: Record<string, unknown>
  ): { found: boolean; danger?: DangerousAction } {
    const checkText = `${actionType} ${description} ${JSON.stringify(params || {})}`;

    for (const danger of DANGEROUS_ACTIONS) {
      if (danger.pattern instanceof RegExp) {
        if (danger.pattern.test(checkText)) {
          return { found: true, danger };
        }
      } else {
        if (checkText.toLowerCase().includes(danger.pattern.toLowerCase())) {
          return { found: true, danger };
        }
      }
    }

    return { found: false };
  }

  /**
   * 设置键盘紧急停止
   */
  private setupKeyboardStop(): void {
    // 注意：实际实现需要全局键盘钩子
    // 这里提供框架，具体实现依赖系统输入模块
    Logger.info(
      `⌨️  键盘紧急停止已启用，按 ${this.config.emergencyStopKey} 键停止`,
      'SafetyGuard'
    );

    // 可以通过 SystemInput 模块注册全局快捷键
    this.emit('keyboard_stop_setup', { key: this.config.emergencyStopKey });
  }

  /**
   * 设置鼠标角紧急停止
   * 当鼠标移动到屏幕左上角时触发停止
   */
  private setupMouseCornerStop(): void {
    // 注意：实际实现需要持续监控鼠标位置
    // 这里提供框架
    Logger.info('🖱️  鼠标角紧急停止已启用（移到左上角停止）', 'SafetyGuard');
    this.emit('mouse_corner_stop_setup');
  }

  /**
   * 检查鼠标是否在停止角落
   * 可在每次操作前调用
   */
  public checkMouseCorner(x: number, y: number): boolean {
    // 左上角 20x20 像素区域为停止区域
    const CORNER_SIZE = 20;
    return x < CORNER_SIZE && y < CORNER_SIZE;
  }
}

// 便捷导出
export const safetyGuard = DesktopSafetyGuard.getInstance();
