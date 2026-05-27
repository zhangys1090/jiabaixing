#!/bin/bash

# 运行集成测试脚本

echo "=== 运行集成测试 ==="

# 运行核心推理引擎与记忆引擎集成测试
echo "\n1. 运行核心推理引擎与记忆引擎集成测试"
npm test tests/integration/CoreMemoryIntegration.test.ts

# 运行交互引擎与核心推理引擎集成测试
echo "\n2. 运行交互引擎与核心推理引擎集成测试"
npm test tests/integration/InteractionCoreIntegration.test.ts

# 运行工具执行层与核心推理引擎集成测试
echo "\n3. 运行工具执行层与核心推理引擎集成测试"
npm test tests/integration/ToolCoreIntegration.test.ts

# 运行多模态输入处理与各模块集成测试
echo "\n4. 运行多模态输入处理与各模块集成测试"
npm test tests/integration/MultimodalIntegration.test.ts

echo "\n=== 集成测试完成 ==="
