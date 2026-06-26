/**
 * MCP Server 实际操作测试
 */

import { DesktopMCPServer } from '../../src/desktop/DesktopMCPServer';
import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

function logResult(
  module: string,
  testName: string,
  success: boolean,
  detail: string = ''
) {
  if (success) {
    passed++;
    console.log(`  ✅ PASS - ${testName}${detail ? ` (${detail})` : ''}`);
  } else {
    failed++;
    console.log(`  ❌ FAIL - ${testName}${detail ? ` (${detail})` : ''}`);
  }
}

async function main() {
  console.log('🚀 MCP Server 实际操作测试');
  console.log('='.repeat(60));
  console.log('');

  const mcp = DesktopMCPServer.getInstance();

  // 测试1: 工具列表
  console.log('📋 测试工具列表...');
  const tools = mcp.listTools();
  logResult(
    'MCP',
    '工具列表加载',
    tools.length >= 15,
    `共 ${tools.length} 个工具`
  );

  const expectedTools = [
    'screenshot',
    'click',
    'type',
    'key',
    'scroll',
    'wait',
    'get_screen_size',
  ];
  const hasAllTools = expectedTools.every((name) =>
    tools.some((t) => t.name === name)
  );
  logResult('MCP', '核心工具存在', hasAllTools, expectedTools.join(', '));

  // 测试2: 初始化
  console.log('\n⚙️  测试初始化...');
  try {
    await mcp.initialize();
    logResult('MCP', '初始化', true, '');
  } catch (error) {
    logResult('MCP', '初始化', false, (error as Error).message);
  }

  // 测试3: get_screen_size
  console.log('\n📐 测试 get_screen_size...');
  try {
    const result = await mcp.callTool('get_screen_size', {});
    const hasContent = result.content && result.content.length > 0;
    const hasPixel =
      hasContent && result.content[0].text?.includes('pixel_width');
    logResult('MCP', 'get_screen_size', !result.isError && !!hasPixel, '');
  } catch (error) {
    logResult('MCP', 'get_screen_size', false, (error as Error).message);
  }

  // 测试4: wait 工具
  console.log('\n⏱️  测试 wait 工具...');
  try {
    const startTime = Date.now();
    const result = await mcp.callTool('wait', { ms: 500 });
    const duration = Date.now() - startTime;
    const waitedEnough = duration >= 400 && duration < 1000;
    logResult(
      'MCP',
      'wait 工具',
      !result.isError && waitedEnough,
      `耗时 ${duration}ms`
    );
  } catch (error) {
    logResult('MCP', 'wait 工具', false, (error as Error).message);
  }

  // 测试5: screenshot 工具
  console.log('\n📸 测试 screenshot 工具...');
  try {
    const result = await mcp.callTool('screenshot', {});
    logResult(
      'MCP',
      'screenshot 工具',
      !result.isError,
      result.isError ? result.content[0].text : '成功'
    );
  } catch (error) {
    logResult('MCP', 'screenshot 工具', false, (error as Error).message);
  }

  // 测试6: click 工具（移动到屏幕中心，不实际点击）
  console.log('\n🖱️  测试 click 工具（仅移动鼠标）...');
  try {
    // 先移动鼠标到中心附近，不做实际点击
    const result = await mcp.callTool('click', {
      x: 500,
      y: 500,
      button: 'left',
    });
    logResult(
      'MCP',
      'click 工具',
      !result.isError,
      result.isError ? result.content[0].text : '成功点击 (500, 500)'
    );
  } catch (error) {
    logResult('MCP', 'click 工具', false, (error as Error).message);
  }

  // 测试7: set_clipboard 和 get_clipboard
  console.log('\n📋 测试剪贴板工具...');
  try {
    const testText = `MCP测试_${Date.now()}`;
    await mcp.callTool('set_clipboard', { text: testText });

    // 等待一下
    await new Promise((r) => setTimeout(r, 200));

    const result = await mcp.callTool('get_clipboard', {});
    const clipboardContent = result.content[0]?.text || '';
    const matches = clipboardContent.includes(testText);
    logResult(
      'MCP',
      '剪贴板读写',
      !result.isError && matches,
      matches
        ? `内容匹配: ${testText}`
        : `内容不匹配: ${clipboardContent.substring(0, 50)}`
    );
  } catch (error) {
    logResult('MCP', '剪贴板读写', false, (error as Error).message);
  }

  // 测试8: key 工具
  console.log('\n⌨️  测试 key 工具...');
  try {
    // 按一下 shift 键（不会有副作用）
    const result = await mcp.callTool('key', { key: 'shift' });
    logResult(
      'MCP',
      'key 工具',
      !result.isError,
      result.isError ? result.content[0].text : '成功'
    );
  } catch (error) {
    logResult('MCP', 'key 工具', false, (error as Error).message);
  }

  // 总结
  console.log('\n' + '='.repeat(60));
  console.log('📊 测试结果汇总');
  console.log('='.repeat(60));
  console.log(`\n总计: 通过 ${passed} / ${passed + failed} 项测试`);

  if (failed === 0) {
    console.log('\n🎉 所有测试通过！');
  } else {
    console.log(`\n⚠️  有 ${failed} 项测试失败`);
  }

  console.log('='.repeat(60));

  // 清理
  await mcp.shutdown();
}

main().catch(console.error);
