/**
 * 技能包测试
 */

import { DesktopSkillRegistry } from '../../src/desktop/DesktopSkillRegistry';

function main() {
  console.log('🎯 技能包测试');
  console.log('='.repeat(60));

  const registry = DesktopSkillRegistry.getInstance();
  const skills = registry.getAllSkills();
  const categories = registry.getCategories();

  console.log(`\n📦 技能总数: ${skills.length}`);
  console.log(`📂 技能分类: ${categories.join(', ')}`);

  console.log('\n📋 技能列表:');
  skills.forEach((skill) => {
    console.log(`  - [${skill.category}] ${skill.name} (${skill.id})`);
  });

  // 测试技能匹配
  console.log('\n🔍 技能匹配测试:');

  const testInputs = [
    '搜索天气',
    '打开记事本写点东西',
    '截图',
    '最大化窗口',
    '最小化窗口',
    '关闭窗口',
    '打开文件管理器',
    '打开计算器',
    '打开任务管理器',
    '打开画图',
    '打开设置',
    '刷新页面',
    '打开vscode',
    '打开微信',
    '全选',
    '撤销',
    '显示桌面',
    '复制粘贴',
  ];

  testInputs.forEach((input) => {
    const match = registry.matchSkill(input);
    if (match) {
      console.log(
        `  "${input}" → ${match.skill.name} (${Math.round(match.confidence)}%)`
      );
    } else {
      console.log(`  "${input}" → 未匹配`);
    }
  });

  console.log('\n' + '='.repeat(60));
  console.log('✅ 技能包测试完成');
  console.log('='.repeat(60));
}

main();
