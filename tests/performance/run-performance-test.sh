#!/bin/bash

# 性能测试运行脚本
echo "========================================"
echo "开始执行性能测试"
echo "========================================"

# 检查Artillery是否安装
if ! command -v artillery &> /dev/null; then
    echo "Artillery未安装，尝试安装..."
    npm install -g artillery
    if [ $? -ne 0 ]; then
        echo "Artillery安装失败，跳过性能测试"
        exit 1
    fi
fi

# 检查测试配置文件是否存在
if [ ! -f "tests/performance/performance-test.yml" ]; then
    echo "性能测试配置文件不存在，跳过性能测试"
    exit 1
fi

# 检查测试数据文件是否存在
if [ ! -f "tests/performance/test-data.csv" ]; then
    echo "测试数据文件不存在，创建默认测试数据..."
    cat > tests/performance/test-data.csv << EOF
input
帮我写一个简单的TypeScript函数
计算1+1等于多少
打开客厅的灯
关闭卧室的灯
帮我查一下天气
设置明天早上7点的闹钟
播放我喜欢的音乐
帮我写一封邮件
搜索最近的餐厅
设置一个25分钟的定时器
EOF
    echo "默认测试数据创建完成"
fi

# 执行性能测试
echo "执行性能测试..."
artillery run tests/performance/performance-test.yml

echo "\n========================================"
echo "性能测试执行完成"
echo "========================================"
