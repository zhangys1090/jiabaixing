#!/usr/bin/env node

/**
 * 自动修复代码质量问题
 * 处理常见的linting错误
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, 'src');

/**
 * 修复未使用的参数
 */
function fixUnusedParameters(filePath, content) {
  let modified = false;
  let lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 匹配函数参数定义中的未使用参数
    const paramMatch = line.match(/(\w+):\s*(\w+)/g);
    if (paramMatch) {
      let newLine = line;

      // 检查参数是否在函数体中使用
      const functionStart = i;
      let braceCount = 0;
      let inFunction = false;

      for (let j = i; j < lines.length; j++) {
        if (lines[j].includes('{')) braceCount++;
        if (lines[j].includes('}')) braceCount--;

        if (braceCount > 0) inFunction = true;
        if (braceCount === 0 && inFunction) break;
      }

      // 如果参数未使用，添加下划线前缀
      const unusedParams = [];
      paramMatch.forEach((match) => {
        const [paramName, paramType] = match.split(':').map((s) => s.trim());
        if (paramName && !paramName.startsWith('_')) {
          // 检查是否在函数体中使用
          const usedInBody = lines
            .slice(i + 1, i + 50)
            .some(
              (l) =>
                l.includes(paramName) && !l.includes('//') && !l.includes('*')
            );

          if (!usedInBody && paramName !== 'error') {
            unusedParams.push(paramName);
          }
        }
      });

      unusedParams.forEach((param) => {
        newLine = newLine.replace(
          new RegExp(`\\b${param}\\b(?!\\s*:)`, 'g'),
          `_${param}`
        );
      });

      if (newLine !== line) {
        lines[i] = newLine;
        modified = true;
      }
    }
  }

  return modified ? lines.join('\n') : content;
}

/**
 * 修复未使用的变量
 */
function fixUnusedVariables(filePath, content) {
  let modified = false;
  let lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 匹配变量声明
    const varMatch = line.match(/(?:const|let|var)\s+(\w+)\s*=/);
    if (varMatch) {
      const varName = varMatch[1];

      // 检查变量是否在后续代码中使用
      const usedInFile = lines
        .slice(i + 1)
        .some(
          (l) => l.includes(varName) && !l.includes('//') && !l.includes('*')
        );

      if (!usedInFile && !varName.startsWith('_')) {
        lines[i] = line.replace(
          new RegExp(`\\b${varName}\\b`, 'g'),
          `_${varName}`
        );
        modified = true;
      }
    }
  }

  return modified ? lines.join('\n') : content;
}

/**
 * 修复any类型
 */
function fixAnyTypes(filePath, content) {
  let modified = false;
  let lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 替换简单的any类型为unknown
    if (line.includes(': any') || line.includes(':any')) {
      lines[i] = line
        .replace(/: any\b/g, ': unknown')
        .replace(/:any\b/g, ': unknown');
      modified = true;
    }

    // 替换as any为as unknown
    if (line.includes(' as any') || line.includes(' as any')) {
      lines[i] = line
        .replace(/ as any\b/g, ' as unknown')
        .replace(/ as any\b/g, ' as unknown');
      modified = true;
    }
  }

  return modified ? lines.join('\n') : content;
}

/**
 * 修复浮动的Promise
 */
function fixFloatingPromises(filePath, content) {
  let modified = false;
  let lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 检查EventBus.emit调用
    if (
      line.includes('EventBus.emit(') &&
      !line.includes('void ') &&
      !line.includes('await ')
    ) {
      lines[i] = line.replace(/EventBus\.emit\(/, 'void EventBus.emit(');
      modified = true;
    }

    // 检查worker.terminate调用
    if (
      line.includes('worker.terminate()') &&
      !line.includes('void ') &&
      !line.includes('await ')
    ) {
      lines[i] = line.replace(
        /worker\.terminate\(\)/,
        'void worker.terminate()'
      );
      modified = true;
    }
  }

  return modified ? lines.join('\n') : content;
}

/**
 * 处理单个文件
 */
function processFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    let modifiedContent = content;

    // 应用各种修复
    modifiedContent = fixUnusedParameters(filePath, modifiedContent);
    modifiedContent = fixUnusedVariables(filePath, modifiedContent);
    modifiedContent = fixAnyTypes(filePath, modifiedContent);
    modifiedContent = fixFloatingPromises(filePath, modifiedContent);

    // 如果内容被修改，写回文件
    if (modifiedContent !== content) {
      fs.writeFileSync(filePath, modifiedContent, 'utf-8');
      console.log(`✅ 已修复: ${filePath}`);
      return true;
    }

    return false;
  } catch (error) {
    console.error(`❌ 处理文件失败: ${filePath}`, error.message);
    return false;
  }
}

/**
 * 递归遍历目录
 */
function walkDirectory(dir, callback) {
  const files = fs.readdirSync(dir);

  files.forEach((file) => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      // 跳过node_modules和dist目录
      if (!['node_modules', 'dist', '.git'].includes(file)) {
        walkDirectory(filePath, callback);
      }
    } else if (file.endsWith('.ts') || file.endsWith('.tsx')) {
      callback(filePath);
    }
  });
}

/**
 * 主函数
 */
function main() {
  console.log('🔧 开始自动修复代码质量问题...\n');

  let fixedCount = 0;

  // 遍历src目录
  walkDirectory(SRC_DIR, (filePath) => {
    if (processFile(filePath)) {
      fixedCount++;
    }
  });

  console.log(`\n✨ 修复完成！共修复 ${fixedCount} 个文件`);

  // 运行ESLint自动修复
  console.log('\n🔧 运行ESLint自动修复...');
  try {
    execSync('npm run lint:fix', { cwd: ROOT_DIR, stdio: 'inherit' });
    console.log('✅ ESLint自动修复完成');
  } catch (error) {
    console.log('⚠️  ESLint自动修复完成（部分问题需要手动处理）');
  }

  // 运行类型检查
  console.log('\n🔧 运行TypeScript类型检查...');
  try {
    execSync('npm run build', { cwd: ROOT_DIR, stdio: 'inherit' });
    console.log('✅ 类型检查通过');
  } catch (error) {
    console.log('⚠️  类型检查发现错误，请查看详细信息');
  }
}

// 运行主函数
if (require.main === module) {
  main();
}

module.exports = {
  fixUnusedParameters,
  fixUnusedVariables,
  fixAnyTypes,
  fixFloatingPromises,
  processFile,
  walkDirectory,
};
