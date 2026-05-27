#!/bin/bash

# 测试运行脚本
echo "========================================"
echo "开始执行测试套件"
echo "========================================"

# 1. 运行单元测试
echo "\n1. 运行单元测试..."
npm run test:coverage

# 2. 运行集成测试
echo "\n2. 运行集成测试..."
npm run test:integration

# 3. 运行性能测试
echo "\n3. 运行性能测试..."
if [ -f "tests/performance/run-performance-test.sh" ]; then
    bash tests/performance/run-performance-test.sh
else
    echo "性能测试脚本不存在，跳过性能测试"
fi

# 4. 运行端到端测试
echo "\n4. 运行端到端测试..."
if [ -f "tests/e2e/cypress.config.js" ]; then
    npm run test:e2e
else
    echo "端到端测试配置不存在，跳过分端到端测试"
fi

echo "\n========================================"
echo "测试套件执行完成"
echo "========================================"
