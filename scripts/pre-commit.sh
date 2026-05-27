#!/bin/sh
# Pre-commit Hook
# 在提交代码前自动运行代码检查和测试

echo "Running pre-commit hooks..."

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 检查是否需要跳过钩子
if [ "$SKIP_HOOKS" = "true" ]; then
    echo "${YELLOW}Skipping hooks...${NC}"
    exit 0
fi

# 获取暂存的文件
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM)
BACKEND_FILES=$(echo "$STAGED_FILES" | grep -E '\.(ts|js)$' | grep -v 'node_modules/' | grep -v 'dist/' | grep -v 'build/')
FRONTEND_FILES=$(echo "$STAGED_FILES" | grep -E '\.(tsx|jsx|ts|js)$' | grep -E 'src/frontend/' | grep -v 'node_modules/')

# 运行ESLint检查
echo "${YELLOW}Running ESLint...${NC}"
if [ -n "$BACKEND_FILES" ]; then
    npx eslint $BACKEND_FILES --max-warnings=0 2>/dev/null
    if [ $? -ne 0 ]; then
        echo "${RED}✗ ESLint check failed${NC}"
        echo "${YELLOW}Please fix the ESLint errors before committing.${NC}"
        exit 1
    fi
    echo "${GREEN}✓ ESLint check passed${NC}"
fi

# 运行Prettier检查
echo "${YELLOW}Running Prettier check...${NC}"
if [ -n "$STAGED_FILES" ]; then
    npx prettier --check $STAGED_FILES 2>/dev/null
    if [ $? -ne 0 ]; then
        echo "${RED}✗ Prettier check failed${NC}"
        echo "${YELLOW}Please run 'npm run format' to format your code.${NC}"
        exit 1
    fi
    echo "${GREEN}✓ Prettier check passed${NC}"
fi

# 运行TypeScript类型检查
echo "${YELLOW}Running TypeScript check...${NC}"
if [ -n "$BACKEND_FILES" ]; then
    npx tsc --noEmit 2>/dev/null
    if [ $? -ne 0 ]; then
        echo "${RED}✗ TypeScript check failed${NC}"
        echo "${YELLOW}Please fix the TypeScript errors before committing.${NC}"
        exit 1
    fi
    echo "${GREEN}✓ TypeScript check passed${NC}"
fi

# 运行测试
echo "${YELLOW}Running tests...${NC}"
if [ -n "$BACKEND_FILES" ]; then
    npm test -- --passWithNoTests --ci 2>/dev/null
    if [ $? -ne 0 ]; then
        echo "${RED}✗ Tests failed${NC}"
        echo "${YELLOW}Please fix the failing tests before committing.${NC}"
        exit 1
    fi
    echo "${GREEN}✓ Tests passed${NC}"
fi

echo "${GREEN}✓ All pre-commit checks passed!${NC}"
exit 0
