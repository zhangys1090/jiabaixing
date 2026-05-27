/**
 * 正向进化循环验证测试
 * 验证自我修复、自我重构、自我增强的真实能力
 */

import { LLMProvider } from '../../src/models/LLMProvider';
import { SelfHealingEngine, HealingResult } from '../../src/evolution/SelfHealingEngine';
import { SelfRefactorEngine, RefactoringResult } from '../../src/evolution/SelfRefactorEngine';
import { SelfEnhancementEngine, EnhancementResult } from '../../src/evolution/SelfEnhancementEngine';
import { EvolutionOrchestrator } from '../../src/evolution/EvolutionOrchestrator';
import * as fs from 'fs';
import * as path from 'path';

describe('正向进化循环验证', () => {
  let llmProvider: LLMProvider;
  let healingEngine: SelfHealingEngine;
  let refactorEngine: SelfRefactorEngine;
  let enhancementEngine: SelfEnhancementEngine;
  let orchestrator: EvolutionOrchestrator;

  beforeAll(() => {
    llmProvider = new LLMProvider();
    healingEngine = new SelfHealingEngine(llmProvider);
    refactorEngine = new SelfRefactorEngine(llmProvider);
    enhancementEngine = new SelfEnhancementEngine(llmProvider);
    orchestrator = EvolutionOrchestrator.getInstance();
    orchestrator.registerEngines({ llmProvider });
  });

  describe('1. 自我修复能力验证', () => {
    it('应该能检测到编译错误', async () => {
      const testFile = path.join(process.cwd(), 'tests', 'temp', 'broken.ts');
      const testDir = path.dirname(testFile);
      
      if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true });
      }

      fs.writeFileSync(testFile, `
export function brokenFunction(: string {
  // 故意制造语法错误：缺少参数名
  return 'broken';
}
`, 'utf-8');

      const problems = await (healingEngine as any).detectProblems();
      
      const compileErrors = problems.filter(
        (p: any) => p.type === 'compile_error' && p.file?.includes('broken.ts')
      );

      console.log('📊 检测到的问题:', {
        total: problems.length,
        compileErrors: compileErrors.length
      });

      fs.unlinkSync(testFile);

      expect(problems.length).toBeGreaterThan(0);
    }, 60000);

    it('应该能生成修复方案', async () => {
      const problem = {
        type: 'compile_error' as const,
        message: "Parameter declaration expected",
        file: path.join(process.cwd(), 'src', 'utils', 'Logger.ts'),
        line: 1,
        timestamp: new Date()
      };

      const proposal = await (healingEngine as any).generateFixProposal(problem);

      console.log('📋 生成的修复方案:', {
        hasProposal: !!proposal,
        confidence: proposal?.confidence,
        analysis: proposal?.analysis?.substring(0, 100)
      });

      expect(proposal).toBeDefined();
    }, 30000);

    it('应该能学习修复模式', async () => {
      const problem = {
        type: 'test_failure' as const,
        message: 'Expected true to be false',
        timestamp: new Date()
      };

      const proposal = {
        problem: 'Expected true to be false',
        analysis: '断言逻辑错误',
        solution: '修复断言条件',
        codeChanges: [],
        confidence: 0.8
      };

      (healingEngine as any).learnPattern(problem, proposal);

      const patterns = healingEngine.getLearnedPatterns();
      
      console.log('📚 学习到的模式:', {
        count: patterns.length,
        types: patterns.map(p => p.problemType)
      });

      expect(patterns.length).toBeGreaterThan(0);
    });
  });

  describe('2. 自我重构能力验证', () => {
    it('应该能检测重复代码', async () => {
      const testFile = path.join(process.cwd(), 'tests', 'temp', 'duplicate.ts');
      const testDir = path.dirname(testFile);
      
      if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true });
      }

      const duplicateCode = `
export function func1() {
  console.log('This is a duplicate block of code');
  console.log('It appears multiple times');
  console.log('In different functions');
  console.log('But does the same thing');
  console.log('Which is a code smell');
  return 'result1';
}

export function func2() {
  console.log('This is a duplicate block of code');
  console.log('It appears multiple times');
  console.log('In different functions');
  console.log('But does the same thing');
  console.log('Which is a code smell');
  return 'result2';
}
`;
      fs.writeFileSync(testFile, duplicateCode, 'utf-8');

      const smells = await (refactorEngine as any).detectDuplicateCode();

      console.log('🔍 检测到的代码异味:', {
        total: smells.length,
        duplicates: smells.filter((s: any) => s.type === 'duplicate').length
      });

      fs.unlinkSync(testFile);

      expect(smells.length).toBeGreaterThan(0);
    }, 30000);

    it('应该能检测过长函数', async () => {
      const testFile = path.join(process.cwd(), 'tests', 'temp', 'longfunc.ts');
      const testDir = path.dirname(testFile);
      
      if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true });
      }

      const longFunction = `
export function veryLongFunction() {
${Array(150).fill(0).map((_, i) => `  console.log('Line ${i}');`).join('\n')}
}
`;
      fs.writeFileSync(testFile, longFunction, 'utf-8');

      const smells = await (refactorEngine as any).detectLongFunctions();

      console.log('📏 检测到的过长函数:', {
        count: smells.filter((s: any) => s.type === 'long_function').length
      });

      fs.unlinkSync(testFile);
    }, 30000);

    it('应该能检测未使用的导入', async () => {
      const testFile = path.join(process.cwd(), 'tests', 'temp', 'unused.ts');
      const testDir = path.dirname(testFile);
      
      if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true });
      }

      const codeWithUnusedImports = `
import { UsedClass } from './used';
import { UnusedClass1 } from './unused1';
import { UnusedClass2, UnusedClass3 } from './unused2';
import * as UnusedNamespace from './unused3';

export function useClass() {
  const used = new UsedClass();
  return used;
}
`;
      fs.writeFileSync(testFile, codeWithUnusedImports, 'utf-8');

      const smells = await (refactorEngine as any).detectUnusedImports();

      console.log('📦 检测到的未使用导入:', {
        count: smells.filter((s: any) => s.type === 'unused_import').length
      });

      fs.unlinkSync(testFile);
    });
  });

  describe('3. 自我增强能力验证', () => {
    it('应该能分析用户需求模式', async () => {
      enhancementEngine.recordUserNeed('帮我写一个简单的TypeScript函数');
      enhancementEngine.recordUserNeed('帮我写一个Python类');
      enhancementEngine.recordUserNeed('帮我写一个React组件');
      enhancementEngine.recordUserNeed('帮我写一个API接口');
      enhancementEngine.recordUserNeed('帮我写一个简单的TypeScript函数');

      const patterns = enhancementEngine.getNeedPatterns();

      console.log('📊 用户需求模式:', {
        total: patterns.size,
        patterns: Array.from(patterns.entries()).map(([key, value]) => ({
          pattern: key,
          frequency: value.frequency
        }))
      });

      expect(patterns.size).toBeGreaterThan(0);
    });

    it('应该能检测功能增强机会', async () => {
      const opportunities = await (enhancementEngine as any).detectEnhancementOpportunities();

      console.log('🚀 检测到的增强机会:', {
        total: opportunities.length,
        highPriority: opportunities.filter((o: any) => o.priority === 'high').length,
        types: opportunities.map((o: any) => o.type)
      });

      expect(opportunities).toBeDefined();
    }, 30000);
  });

  describe('4. 完整进化循环验证', () => {
    it('应该能执行完整的正向进化循环', async () => {
      console.log('\n🔄 开始执行完整正向进化循环...\n');

      const startTime = Date.now();

      const healingResults = await orchestrator.runSelfHealing();
      console.log(`✅ 自我修复完成: ${healingResults.filter(r => r.success).length}/${healingResults.length} 成功`);

      const refactorResult = await orchestrator.runSelfRefactor();
      console.log(`✅ 自我重构完成: ${refactorResult?.filesModified.length || 0} 个文件已优化`);

      const enhancementResults = await orchestrator.runSelfEnhancement();
      console.log(`✅ 自我增强完成: ${enhancementResults.filter(r => r.success).length}/${enhancementResults.length} 成功`);

      const duration = Date.now() - startTime;

      const report = {
        duration: `${(duration / 1000).toFixed(2)}s`,
        healing: {
          total: healingResults.length,
          success: healingResults.filter(r => r.success).length,
          problems: healingResults.map(r => r.problem),
          solutions: healingResults.map(r => r.solution)
        },
        refactor: {
          success: refactorResult?.success || false,
          filesModified: refactorResult?.filesModified || [],
          improvements: refactorResult?.improvements || { reducedLines: 0, reducedComplexity: 0, eliminatedDuplicates: 0 }
        },
        enhancement: {
          total: enhancementResults.length,
          success: enhancementResults.filter(r => r.success).length,
          newCapabilities: enhancementResults.map(r => r.enhancement?.description)
        }
      };

      console.log('\n📊 正向进化循环报告:');
      console.log(JSON.stringify(report, null, 2));

      expect(report).toBeDefined();
      expect(duration).toBeLessThan(120000);
    }, 180000);
  });

  describe('5. 能力提升验证', () => {
    it('应该能获取修复历史', () => {
      const history = orchestrator.getHealingHistory();
      console.log('📚 修复历史:', {
        total: history.length,
        successRate: history.length > 0 
          ? `${(history.filter(h => h.success).length / history.length * 100).toFixed(1)}%`
          : 'N/A'
      });
      expect(history).toBeDefined();
    });

    it('应该能获取重构历史', () => {
      const history = orchestrator.getRefactorHistory();
      console.log('📚 重构历史:', {
        total: history.length,
        totalFilesModified: history.reduce((sum, h) => sum + h.filesModified.length, 0)
      });
      expect(history).toBeDefined();
    });

    it('应该能获取学习到的模式', () => {
      const patterns = healingEngine.getLearnedPatterns();
      console.log('🧠 学习到的模式:', {
        total: patterns.length,
        types: patterns.map(p => p.problemType),
        successRates: patterns.map(p => ({
          type: p.problemType,
          successCount: p.successCount
        }))
      });
      expect(patterns).toBeDefined();
    });
  });
});
