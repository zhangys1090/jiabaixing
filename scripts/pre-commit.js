/**
 * Pre-commit Hook
 * 在提交代码前自动运行代码检查和测试
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 颜色定义
const colors = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m',
  reset: '\x1b[0m',
};

const log = {
  info: (msg) => console.log(`${colors.blue}ℹ ${msg}${colors.reset}`),
  success: (msg) => console.log(`${colors.green}✓ ${msg}${colors.reset}`),
  warn: (msg) => console.log(`${colors.yellow}⚠ ${msg}${colors.reset}`),
  error: (msg) => console.log(`${colors.red}✗ ${msg}${colors.reset}`),
};

// 检查是否需要跳过钩子
if (process.env.SKIP_HOOKS === 'true') {
  log.info('Skipping hooks...');
  process.exit(0);
}

/**
 * 检查跨语言依赖一致性
 * 确保项目不会引入无关的 Python 依赖文件
 */
function checkLanguageConsistency() {
  log.info('Checking language dependency consistency...');

  const rootDir = path.join(__dirname, '..');
  const forbiddenFiles = ['requirements.txt', 'setup.py', 'pyproject.toml', 'Pipfile', 'poetry.lock'];
  const found = [];

  for (const file of forbiddenFiles) {
    const filePath = path.join(rootDir, file);
    if (fs.existsSync(filePath)) {
      found.push(file);
    }
  }

  if (found.length > 0) {
    log.error('Found Python dependency files in a Node.js project:');
    for (const file of found) {
      log.error(`  - ${file}`);
    }
    log.warn('This project uses npm/package.json for dependency management.');
    log.warn('Please remove these Python files or add them to .gitignore.');
    return false;
  }

  log.success('Language dependency consistency check passed');
  return true;
}

// 获取暂存的文件
function getStagedFiles() {
  try {
    const output = execSync('git diff --cached --name-only --diff-filter=ACM', {
      encoding: 'utf-8',
    });
    return output.split('\n').filter(Boolean);
  } catch (error) {
    log.error('Failed to get staged files');
    return [];
  }
}

// 过滤文件
function filterFiles(files, pattern) {
  return files.filter((file) => {
    const regex = new RegExp(pattern);
    return regex.test(file);
  });
}

// 运行命令
function runCommand(command, options = {}) {
  try {
    log.info(`Running: ${command}`);
    execSync(command, {
      stdio: 'inherit',
      ...options,
    });
    return true;
  } catch (error) {
    if (!options.ignoreError) {
      return false;
    }
  }
  return true;
}

// 主函数
async function main() {
  log.info('Running pre-commit hooks...');

  // 跨语言依赖一致性检查
  if (!checkLanguageConsistency()) {
    process.exit(1);
  }

  const stagedFiles = getStagedFiles();
  const backendFiles = filterFiles(stagedFiles, '\\.(ts|js)$');
  const frontendFiles = filterFiles(stagedFiles, '\\.(tsx|jsx|ts|js)$');

  // 过滤掉不需要检查的文件
  const excludePatterns = ['node_modules/', 'dist/', 'build/', 'coverage/'];
  const filteredBackendFiles = backendFiles.filter(
    (file) => !excludePatterns.some((pattern) => file.includes(pattern))
  );
  const filteredFrontendFiles = frontendFiles.filter(
    (file) => !excludePatterns.some((pattern) => file.includes(pattern))
  );

  // 运行ESLint检查
  if (filteredBackendFiles.length > 0) {
    log.info('Running ESLint...');
    const eslintCmd = `npx eslint ${filteredBackendFiles.join(' ')} --max-warnings=0`;
    if (!runCommand(eslintCmd, { stdio: 'inherit' })) {
      log.error('ESLint check failed');
      log.warn('Please fix the ESLint errors before committing.');
      process.exit(1);
    }
    log.success('ESLint check passed');
  }

  // 运行Prettier检查
  if (stagedFiles.length > 0) {
    log.info('Running Prettier check...');
    const prettierCmd = `npx prettier --check ${stagedFiles.join(' ')}`;
    if (!runCommand(prettierCmd, { stdio: 'inherit', ignoreError: true })) {
      log.error('Prettier check failed');
      log.warn('Please run "npm run format" to format your code.');
      process.exit(1);
    }
    log.success('Prettier check passed');
  }

  // 运行TypeScript类型检查
  if (filteredBackendFiles.length > 0) {
    log.info('Running TypeScript check...');
    if (!runCommand('npx tsc --noEmit', { stdio: 'inherit', ignoreError: true })) {
      log.error('TypeScript check failed');
      log.warn('Please fix the TypeScript errors before committing.');
      process.exit(1);
    }
    log.success('TypeScript check passed');
  }

  // 运行测试
  if (filteredBackendFiles.length > 0) {
    log.info('Running tests...');
    if (!runCommand('npm test -- --passWithNoTests --ci', { stdio: 'inherit' })) {
      log.error('Tests failed');
      log.warn('Please fix the failing tests before committing.');
      process.exit(1);
    }
    log.success('Tests passed');
  }

  log.success('All pre-commit checks passed!');
  process.exit(0);
}

// 运行主函数
main().catch((error) => {
  log.error(`Pre-commit hook failed: ${error.message}`);
  process.exit(1);
});
