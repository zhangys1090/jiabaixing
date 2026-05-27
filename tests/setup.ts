/**
 * Jest 测试设置文件
 * 在每个测试文件执行前运行
 */

// 加载环境变量
import 'dotenv/config';

// 抑制日志输出
global.console.error = jest.fn();
global.console.warn = jest.fn();
global.console.log = jest.fn();
global.console.info = jest.fn();
