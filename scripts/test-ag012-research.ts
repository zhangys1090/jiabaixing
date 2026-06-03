/**
 * AG012 研究闭环测试
 * 用真实 bootstrap 流程跑一次完整的研究任务
 * 运行: npx ts-node --transpile-only scripts/test-ag012-research.ts
 */

import 'dotenv/config';

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  AG012 研究闭环测试');
  console.log('═══════════════════════════════════════════\n');

  // 1. 完整 bootstrap
  console.log('⏳ 完整 bootstrap...');
  const { bootstrap } = await import('../src/server/bootstrap');
  const core = await bootstrap();

  const harness = core.getHarness();
  console.log('\n🏗️ Harness:', harness ? '✅ 已注入' : '❌ 未注入');

  if (!harness) {
    console.error('Harness 未注入，无法测试');
    process.exit(1);
  }

  // 2. 测试 web_search 工具（通过 Harness）
  console.log('\n🔍 测试 web_search (通过 Harness ToolRegistry):');
  const toolRegistry = harness.getToolRegistry();
  if (toolRegistry) {
    const searchResult = await toolRegistry.execute('web_search', {
      query: '2026年智慧养老AI发展趋势',
      search_type: 'general',
      max_results: 3,
      language: 'zh-CN',
    }, { permissions: new Set(['network:access'] as const), metadata: {} });
    console.log('  成功:', searchResult.success);
    if (searchResult.success) {
      const lines = String(searchResult.output).split('\n').slice(0, 10);
      lines.forEach((l: string) => console.log('  ', l));
    } else {
      console.log('  失败:', searchResult.error);
    }
  }

  // 3. 测试完整 processInput
  console.log('\n🏗️ 测试 processInput (研究指令):');
  console.log('  发送: "帮我搜索一下2026年智慧养老AI的发展趋势，简单总结3个要点"');
  const startTime = Date.now();
  const result = await core.processInput(
    '帮我搜索一下2026年智慧养老AI的发展趋势，简单总结3个要点',
    'test-user',
    `ag012-${Date.now()}`
  );
  const duration = Date.now() - startTime;

  console.log('\n  ── 结果 ──');
  console.log('  用时:', duration + 'ms');
  console.log('  意图:', result.intent);
  console.log('  质量:', result.quality?.toFixed(2));
  console.log('  轮次:', result.loopRounds);
  console.log('  工具调用:', result.toolCallsCount);
  console.log('  响应长度:', result.response.length, '字符');
  console.log('\n  ── 响应内容 ──');
  console.log(result.response.substring(0, 800));

  console.log('\n═══════════════════════════════════════════');
  console.log('  AG012 测试完成');
  console.log('═══════════════════════════════════════════');

  process.exit(0);
}

main().catch((e) => {
  console.error('AG012 测试失败:', e.message);
  console.error(e.stack?.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
});
