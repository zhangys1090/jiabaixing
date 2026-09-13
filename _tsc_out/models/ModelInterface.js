"use strict";
/**
 * 模型接口重新导出
 * 统一从 src/core/ModelInterface.ts 导出，消除重复定义
 * 注意：ModelManager 有独立实现，不从此处导出
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ModelFactory = exports.AbstractModel = void 0;
var ModelInterface_1 = require("../core/ModelInterface");
Object.defineProperty(exports, "AbstractModel", { enumerable: true, get: function () { return ModelInterface_1.AbstractModel; } });
Object.defineProperty(exports, "ModelFactory", { enumerable: true, get: function () { return ModelInterface_1.ModelFactory; } });
