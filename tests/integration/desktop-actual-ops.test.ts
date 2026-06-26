/**
 * 实际桌面操作测试
 * 测试截图、鼠标移动、点击等真实桌面操作
 */

import { ScreenCapture } from '../../src/desktop/ScreenCapture';
import { SystemInput } from '../../src/desktop/SystemInput';
import { NormalizedCoordinateSystem } from '../../src/desktop/NormalizedCoordinates';
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

async function testScreenCapture() {
  console.log('\n📸 测试截图功能...');
  const module = 'ScreenCapture';

  try {
    const capture = ScreenCapture.getInstance();
    await capture.initialize();

    // 测试1: 全屏截图
    const result = await capture.captureFullScreen();
    logResult(
      module,
      '全屏截图',
      result.success && result.buffer.length > 0,
      `大小: ${(result.buffer.length / 1024).toFixed(1)}KB`
    );

    // 测试2: 保存截图到文件
    if (result.success) {
      const testDir = path.join(__dirname, '..', 'test-output');
      if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true });
      }
      const outputPath = path.join(testDir, 'test-screenshot.png');
      fs.writeFileSync(outputPath, result.buffer);
      logResult(
        module,
        '保存截图到文件',
        fs.existsSync(outputPath),
        outputPath
      );
    }
  } catch (error) {
    logResult(module, '截图测试', false, (error as Error).message);
  }
}

async function testSystemInput() {
  console.log('\n🖱️ 测试系统输入（鼠标）...');
  const module = 'SystemInput';

  try {
    const input = SystemInput.getInstance();
    await input.initialize();

    // 测试1: 获取鼠标位置
    const pos = await input.getMousePosition();
    logResult(
      module,
      '获取鼠标位置',
      typeof pos.x === 'number' && typeof pos.y === 'number',
      `位置: (${pos.x}, ${pos.y})`
    );

    // 测试2: 移动鼠标（移动到屏幕中心附近，然后移回来）
    const coords = NormalizedCoordinateSystem.getInstance();
    const centerPixel = coords.toPixel({ x: 500, y: 500 });

    const originalPos = { ...pos };
    const moveResult = await input.moveMouse(
      Math.floor(centerPixel.x),
      Math.floor(centerPixel.y)
    );

    // 等待一下让鼠标移动完成
    await new Promise((r) => setTimeout(r, 200));

    const newPos = await input.getMousePosition();
    const moved =
      Math.abs(newPos.x - originalPos.x) > 10 ||
      Math.abs(newPos.y - originalPos.y) > 10;

    logResult(
      module,
      '移动鼠标',
      moveResult.success && moved,
      `从 (${originalPos.x},${originalPos.y}) → (${newPos.x},${newPos.y})`
    );

    // 测试3: 归一化坐标转换
    const normalized = coords.toNormalized(newPos);
    logResult(
      module,
      '归一化坐标转换',
      normalized.x >= 0 &&
        normalized.x <= 1000 &&
        normalized.y >= 0 &&
        normalized.y <= 1000,
      `归一化: (${normalized.x.toFixed(1)}, ${normalized.y.toFixed(1)})`
    );

    // 把鼠标移回原位
    await input.moveMouse(originalPos.x, originalPos.y);
    await new Promise((r) => setTimeout(r, 200));
  } catch (error) {
    logResult(module, '系统输入测试', false, (error as Error).message);
  }
}

async function testNormalizedCoords() {
  console.log('\n📐 测试归一化坐标系统（实际屏幕）...');
  const module = 'NormalizedCoords';

  try {
    const coords = NormalizedCoordinateSystem.getInstance();

    // 获取实际屏幕尺寸
    const screenSize = coords.getPixelScreenSize();
    logResult(
      module,
      '获取屏幕尺寸',
      screenSize.width > 0 && screenSize.height > 0,
      `${screenSize.width}x${screenSize.height}`
    );

    // 测试边角坐标
    const corners = [
      { name: '左上角', x: 0, y: 0 },
      { name: '右上角', x: 1000, y: 0 },
      { name: '左下角', x: 0, y: 1000 },
      { name: '右下角', x: 1000, y: 1000 },
      { name: '中心', x: 500, y: 500 },
    ];

    let allValid = true;
    for (const corner of corners) {
      const pixel = coords.toPixel(corner);
      const valid =
        pixel.x >= 0 &&
        pixel.x <= screenSize.width &&
        pixel.y >= 0 &&
        pixel.y <= screenSize.height;
      if (!valid) allValid = false;
    }
    logResult(module, '边角坐标转换', allValid, '5个关键点全部在屏幕范围内');
  } catch (error) {
    logResult(module, '坐标系统测试', false, (error as Error).message);
  }
}

async function main() {
  console.log('🚀 实际桌面操作测试');
  console.log('='.repeat(60));
  console.log('⚠️  注意：测试过程中鼠标会移动，请不要操作鼠标');
  console.log('');

  await testScreenCapture();
  await testNormalizedCoords();
  await testSystemInput();

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
}

main().catch(console.error);
