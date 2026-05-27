/**
 * 依赖版本审计脚本
 * 检查项目依赖版本一致性，识别潜在兼容性问题
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class DependencyAuditor {
  constructor() {
    this.packageJsonPath = path.join(__dirname, '../package.json');
    this.packageLockPath = path.join(__dirname, '../package-lock.json');
    this.packageJson = JSON.parse(fs.readFileSync(this.packageJsonPath, 'utf8'));
    this.packageLock = fs.existsSync(this.packageLockPath)
      ? JSON.parse(fs.readFileSync(this.packageLockPath, 'utf8'))
      : null;
  }

  /**
   * 检查是否存在无关的 Python 依赖文件
   */
  checkPythonArtifacts() {
    const artifacts = [];
    const rootDir = path.join(__dirname, '..');
    const filesToCheck = ['requirements.txt', 'setup.py', 'pyproject.toml', 'Pipfile'];

    for (const file of filesToCheck) {
      const filePath = path.join(rootDir, file);
      if (fs.existsSync(filePath)) {
        artifacts.push(file);
      }
    }

    // 检查是否有 .py 文件（排除 node_modules）
    const checkPyFiles = (dir, depth = 0) => {
      if (depth > 2 || path.basename(dir) === 'node_modules') return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name !== 'node_modules') {
            checkPyFiles(path.join(dir, entry.name), depth + 1);
          } else if (entry.name.endsWith('.py')) {
            artifacts.push(path.relative(rootDir, path.join(dir, entry.name)));
          }
        }
      } catch {
        // 忽略无权限目录
      }
    };
    checkPyFiles(rootDir);

    return artifacts;
  }

  /**
   * 执行完整审计
   */
  async audit() {
    console.log('🔍 开始依赖版本审计...\n');

    const results = {
      totalDependencies: 0,
      outdatedDependencies: [],
      missingInLock: [],
      versionConflicts: [],
      securityIssues: [],
    };

    // 检查 package.json 和 package-lock.json 一致性
    results.totalDependencies = Object.keys(this.packageJson.dependencies || {}).length +
      Object.keys(this.packageJson.devDependencies || {}).length;

    // 检查锁定文件
    if (!this.packageLock) {
      console.warn('⚠️ 未找到 package-lock.json，无法进行版本锁定验证');
    } else {
      results.outdatedDependencies = this.checkOutdatedDependencies();
      results.missingInLock = this.checkMissingInLock();
      results.versionConflicts = this.checkVersionConflicts();
    }

    // 检查安全漏洞
    results.securityIssues = await this.checkSecurityVulnerabilities();

    // 检查 Python 无关文件
    results.pythonArtifacts = this.checkPythonArtifacts();

    // 生成报告
    this.generateReport(results);

    return results;
  }

  /**
   * 检查过时的依赖
   */
  checkOutdatedDependencies() {
    try {
      const output = execSync('npm outdated --json', { stdio: ['pipe', 'pipe', 'pipe'] });
      const outdated = JSON.parse(output.toString());
      return Object.entries(outdated).map(([name, info]) => ({
        name,
        current: info.current,
        wanted: info.wanted,
        latest: info.latest,
        type: this.packageJson.dependencies[name] ? 'production' : 'development',
      }));
    } catch {
      return [];
    }
  }

  /**
   * 检查锁定文件中缺失的依赖
   */
  checkMissingInLock() {
    const missing = [];
    const allDeps = {
      ...this.packageJson.dependencies,
      ...this.packageJson.devDependencies,
    };

    if (this.packageLock && this.packageLock.packages) {
      for (const [dep, version] of Object.entries(allDeps)) {
        if (!this.packageLock.packages[`node_modules/${dep}`]) {
          missing.push({ name: dep, expected: version });
        }
      }
    }

    return missing;
  }

  /**
   * 检查版本冲突
   */
  checkVersionConflicts() {
    const conflicts = [];
    const allDeps = {
      ...this.packageJson.dependencies,
      ...this.packageJson.devDependencies,
    };

    // 检查是否有同一依赖的不同版本
    const depVersions = {};
    for (const [dep, version] of Object.entries(allDeps)) {
      if (!depVersions[version]) {
        depVersions[version] = [];
      }
      depVersions[version].push(dep);
    }

    // 如果有多个版本，标记为冲突
    if (Object.keys(depVersions).length > 1) {
      conflicts.push({
        type: 'version_mismatch',
        details: depVersions,
      });
    }

    return conflicts;
  }

  /**
   * 检查安全漏洞
   */
  async checkSecurityVulnerabilities() {
    try {
      const output = execSync('npm audit --json', { stdio: ['pipe', 'pipe', 'pipe'] });
      const audit = JSON.parse(output.toString());
      return Object.values(audit.vulnerabilities || {}).map(vuln => ({
        name: vuln.name,
        severity: vuln.severity,
        vulnerableVersions: vuln.vulnerableVersions,
        patchedVersions: vuln.patchedVersions,
        recommendation: vuln.recommendation,
      }));
    } catch {
      return [];
    }
  }

  /**
   * 生成审计报告
   */
  generateReport(results) {
    const reportPath = path.join(__dirname, '../logs/dependency-audit.json');
    fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));

    console.log('📊 审计结果:');
    console.log(`   总依赖数: ${results.totalDependencies}`);
    console.log(`   过时依赖: ${results.outdatedDependencies.length}`);
    console.log(`   缺失依赖: ${results.missingInLock.length}`);
    console.log(`   版本冲突: ${results.versionConflicts.length}`);
    console.log(`   安全问题: ${results.securityIssues.length}`);

    if (results.pythonArtifacts.length > 0) {
      console.log(`\n⚠️  发现 Python 无关文件（项目无 Python 运行时依赖）:`);
      for (const artifact of results.pythonArtifacts) {
        console.log(`     - ${artifact}`);
      }
      console.log('   建议：删除这些文件或在 .gitignore 中忽略');
    }

    console.log(`\n📄 详细报告已保存至: ${reportPath}`);
  }
}

// 执行审计
if (require.main === module) {
  const auditor = new DependencyAuditor();
  auditor.audit().catch(console.error);
}

module.exports = DependencyAuditor;
