/**
 * 代码统计工具
 * 统计项目的代码行数、文件数、模块数等信息
 */

const fs = require('fs');
const path = require('path');

// 统计配置
const config = {
  excludeDirs: [
    'node_modules',
    'dist',
    'build',
    'coverage',
    '.git',
    '.vscode',
    '.github',
    'tests',
    'docs',
  ],
  excludeExtensions: ['.json', '.md', '.yml', '.yaml', '.lock', '.log'],
  includeExtensions: ['.ts', '.tsx', '.js', '.jsx'],
};

// 统计结果
const stats = {
  totalFiles: 0,
  totalLines: 0,
  totalBlankLines: 0,
  totalCodeLines: 0,
  totalCommentLines: 0,
  byFileType: {},
  byModule: {},
  largestFiles: [],
};

// 递归遍历目录
function walkDir(dir, callback) {
  const files = fs.readdirSync(dir);

  files.forEach((file) => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      // 检查是否应该排除目录
      if (!config.excludeDirs.includes(file)) {
        walkDir(filePath, callback);
      }
    } else {
      callback(filePath, stat);
    }
  });
}

// 统计单个文件
function statFile(filePath) {
  const ext = path.extname(filePath);

  // 检查文件扩展名
  if (!config.includeExtensions.includes(ext)) {
    return;
  }

  // 检查是否应该排除
  if (config.excludeExtensions.includes(ext)) {
    return;
  }

  // 读取文件内容
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  // 统计行数
  let blankLines = 0;
  let commentLines = 0;
  let codeLines = 0;
  let inBlockComment = false;

  lines.forEach((line) => {
    const trimmedLine = line.trim();

    // 空行
    if (trimmedLine === '') {
      blankLines++;
      return;
    }

    // 注释行
    if (trimmedLine.startsWith('//') || trimmedLine.startsWith('/*') || trimmedLine.startsWith('*')) {
      commentLines++;
      return;
    }

    // 块注释开始/结束
    if (trimmedLine.includes('/*')) {
      inBlockComment = true;
    }
    if (trimmedLine.includes('*/')) {
      inBlockComment = false;
      commentLines++;
      return;
    }

    // 块注释内
    if (inBlockComment) {
      commentLines++;
      return;
    }

    // 代码行
    codeLines++;
  });

  // 更新统计结果
  stats.totalFiles++;
  stats.totalLines += lines.length;
  stats.totalBlankLines += blankLines;
  stats.totalCodeLines += codeLines;
  stats.totalCommentLines += commentLines;

  // 按文件类型统计
  if (!stats.byFileType[ext]) {
    stats.byFileType[ext] = {
      files: 0,
      lines: 0,
      codeLines: 0,
      commentLines: 0,
      blankLines: 0,
    };
  }
  stats.byFileType[ext].files++;
  stats.byFileType[ext].lines += lines.length;
  stats.byFileType[ext].codeLines += codeLines;
  stats.byFileType[ext].commentLines += commentLines;
  stats.byFileType[ext].blankLines += blankLines;

  // 按模块统计
  const module = filePath.split(path.sep)[1] || 'root';
  if (!stats.byModule[module]) {
    stats.byModule[module] = {
      files: 0,
      lines: 0,
      codeLines: 0,
    };
  }
  stats.byModule[module].files++;
  stats.byModule[module].lines += lines.length;
  stats.byModule[module].codeLines += codeLines;

  // 记录最大文件
  stats.largestFiles.push({
    path: filePath,
    lines: lines.length,
    codeLines,
  });
}

// 格式化数字
function formatNumber(num) {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// 打印统计报告
function printReport() {
  console.log('\n');
  console.log('='.repeat(60));
  console.log('📊 代码统计报告');
  console.log('='.repeat(60));
  console.log('\n');

  console.log('📈 总体统计');
  console.log('-'.repeat(40));
  console.log(`  总文件数:     ${formatNumber(stats.totalFiles)}`);
  console.log(`  总代码行数:   ${formatNumber(stats.totalCodeLines)}`);
  console.log(`  总注释行数:   ${formatNumber(stats.totalCommentLines)}`);
  console.log(`  总空行数:     ${formatNumber(stats.totalBlankLines)}`);
  console.log(`  总行数:       ${formatNumber(stats.totalLines)}`);
  console.log(`  注释比例:     ${((stats.totalCommentLines / stats.totalLines) * 100).toFixed(2)}%`);
  console.log('\n');

  console.log('📁 按文件类型统计');
  console.log('-'.repeat(40));
  console.log(
    '  类型      文件数      代码行      注释行      空行      总行数'
  );
  Object.keys(stats.byFileType)
    .sort()
    .forEach((ext) => {
      const data = stats.byFileType[ext];
      console.log(
        `  ${ext.padEnd(8)} ${formatNumber(data.files).padStart(8)}   ${formatNumber(data.codeLines).padStart(10)}   ${formatNumber(data.commentLines).padStart(10)}   ${formatNumber(data.blankLines).padStart(6)}   ${formatNumber(data.lines).padStart(8)}`
      );
    });
  console.log('\n');

  console.log('📦 按模块统计');
  console.log('-'.repeat(40));
  console.log('  模块          文件数      代码行');
  Object.keys(stats.byModule)
    .sort()
    .forEach((module) => {
      const data = stats.byModule[module];
      console.log(
        `  ${module.padEnd(14)} ${formatNumber(data.files).padStart(8)}   ${formatNumber(data.codeLines).padStart(10)}`
      );
    });
  console.log('\n');

  console.log('📄 最大文件 TOP 10');
  console.log('-'.repeat(40));
  stats.largestFiles
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 10)
    .forEach((file, index) => {
      console.log(
        `  ${(index + 1).toString().padStart(2)}. ${file.path.padEnd(40)} ${formatNumber(file.lines)} 行`
      );
    });
  console.log('\n');

  console.log('='.repeat(60));
  console.log('');
}

// 主函数
function main() {
  console.log('开始统计代码...');

  // 遍历src目录
  const srcDir = path.join(__dirname, '..', 'src');
  if (fs.existsSync(srcDir)) {
    walkDir(srcDir, statFile);
  }

  // 打印报告
  printReport();
}

// 运行主函数
main();
