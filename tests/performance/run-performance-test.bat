@echo off

:: 性能测试运行脚本
echo =========================================
echo 开始执行性能测试
echo =========================================

:: 检查Artillery是否安装
where artillery >nul 2>nul
if %errorlevel% neq 0 (
    echo Artillery未安装，尝试安装...
    npm install -g artillery
    if %errorlevel% neq 0 (
        echo Artillery安装失败，跳过性能测试
        exit /b 1
    )
)

:: 检查测试配置文件是否存在
if not exist "tests\performance\performance-test.yml" (
    echo 性能测试配置文件不存在，跳过性能测试
    exit /b 1
)

:: 检查测试数据文件是否存在
if not exist "tests\performance\test-data.csv" (
    echo 测试数据文件不存在，创建默认测试数据...
    echo input> tests\performance\test-data.csv
    echo 帮我写一个简单的TypeScript函数>> tests\performance\test-data.csv
    echo 计算1+1等于多少>> tests\performance\test-data.csv
    echo 打开客厅的灯>> tests\performance\test-data.csv
    echo 关闭卧室的灯>> tests\performance\test-data.csv
    echo 帮我查一下天气>> tests\performance\test-data.csv
    echo 设置明天早上7点的闹钟>> tests\performance\test-data.csv
    echo 播放我喜欢的音乐>> tests\performance\test-data.csv
    echo 帮我写一封邮件>> tests\performance\test-data.csv
    echo 搜索最近的餐厅>> tests\performance\test-data.csv
    echo 设置一个25分钟的定时器>> tests\performance\test-data.csv
    echo 默认测试数据创建完成
)

:: 执行性能测试
echo 执行性能测试...
artillery run tests\performance\performance-test.yml

echo.
echo =========================================
echo 性能测试执行完成
echo =========================================
