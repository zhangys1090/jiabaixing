/**
 * 模型接口重新导出
 * 统一从 src/core/ModelInterface.ts 导出，消除重复定义
 * 注意：ModelManager 有独立实现，不从此处导出
 */

export {
  AbstractModel,
  AuthConfig,
  Model,
  ModelConfig,
  ModelFactory,
  ModelInput,
  ModelManagerInterface,
  ModelOutput,
  ModelStatus,
} from '../core/ModelInterface';
