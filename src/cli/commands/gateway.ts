import * as readline from 'readline';
import { Logger } from '../../utils/Logger';
import { COLORS, c } from '../constants';
import { getIM } from '../utils';
import { ask } from '../repl';
import { SubcommandOptions } from '../types';

/**
 * 处理 /gateway 命令 — 显示网关状态（REPL 模式）
 */
export async function handleGatewayStatus(): Promise<void> {
  const im = getIM();
  const platforms = im.getPlatforms();
  Logger.info(`\n  ${COLORS.bold}网关状态${COLORS.reset}\n`, 'CLI');
  if (platforms.length === 0) {
    Logger.info(`  ${COLORS.dim}未配置任何平台连接${COLORS.reset}`, 'CLI');
  } else {
    Logger.info(`  已配置 ${platforms.length} 个平台:\n`, 'CLI');
    for (const p of platforms) {
      const s = (p.status?.status as string) || 'disconnected';
      const mark =
        s === 'connected'
          ? '🟢'
          : s === 'connecting'
            ? '🟡'
            : s === 'error'
              ? '🔴'
              : '⚪';
      const statusText =
        s === 'connected'
          ? c(COLORS.green, '已连接')
          : s === 'connecting'
            ? c(COLORS.yellow, '连接中')
            : s === 'error'
              ? c(COLORS.red, '错误')
              : c(COLORS.dim, '未连接');
      Logger.info(`    ${mark} ${p.icon} ${p.name}: ${statusText}`, 'CLI');
    }
  }
  Logger.info(
    `\n  输入 ${COLORS.cyan}/gateway menu${COLORS.reset} 进入配置菜单`,
    'CLI'
  );
  Logger.info('', 'CLI');
}

/**
 * 处理 /gateway 交互菜单（REPL 模式）
 * @param rl - readline 接口
 */
export async function handleGatewayMenu(rl: readline.Interface): Promise<void> {
  while (true) {
    Logger.info(
      `\n  ${COLORS.bold}${COLORS.cyan}GATEWAY 网关配置${COLORS.reset}\n`,
      'CLI'
    );
    Logger.info(`  ${COLORS.cyan}1.${COLORS.reset} 微信 (扫码登录) 🟢`, 'CLI');
    Logger.info(
      `  ${COLORS.cyan}2.${COLORS.reset} 微信 (企业号/公众号 API)`,
      'CLI'
    );
    Logger.info(`  ${COLORS.cyan}3.${COLORS.reset} QQ (Mirai) 🐧`, 'CLI');
    Logger.info(`  ${COLORS.cyan}4.${COLORS.reset} 飞书 ✈️`, 'CLI');
    Logger.info(`  ${COLORS.cyan}5.${COLORS.reset} 钉钉 📌`, 'CLI');
    Logger.info(
      `  ${COLORS.dim}  list  查看连接状态  |  back  返回${COLORS.reset}\n`,
      'CLI'
    );

    const choice = await ask(rl, `  ${COLORS.cyan}gateway${COLORS.reset}> `);
    if (choice === 'back') return;

    const im = getIM();
    switch (choice) {
      case '1': {
        Logger.info(
          '\n  📱 微信扫码登录\n  Playwright 将打开 wx.qq.com 获取二维码',
          'CLI'
        );
        try {
          const ok = await im.connectPlatform('wechat', { mode: 'qr' });
          Logger.info(ok ? '  ✅ 微信扫码模式已启动' : '  ❌ 启动失败', 'CLI');
        } catch (e) {
          Logger.info(`  ❌ 错误: ${(e as Error).message}`, 'CLI');
        }
        break;
      }
      case '2': {
        const appId = await ask(rl, '  AppID: ');
        const appSecret = await ask(rl, '  AppSecret: ');
        const token = await ask(rl, '  Token: ');
        const encodingAESKey = await ask(rl, '  EncodingAESKey (可选): ');
        Logger.info('  ⏳ 连接中...', 'CLI');
        const ok = await im.connectPlatform('wechat', {
          mode: 'official',
          appId,
          appSecret,
          token,
          encodingAESKey: encodingAESKey || undefined,
        });
        Logger.info(ok ? '  ✅ 连接成功' : '  ❌ 连接失败', 'CLI');
        break;
      }
      case '3': {
        Logger.info('\n  🐧 QQ 机器人 (Mirai)\n', 'CLI');
        const host =
          (await ask(rl, '  Mirai HTTP 地址 [localhost]: ')) || 'localhost';
        const port = (await ask(rl, '  Mirai HTTP 端口 [8080]: ')) || '8080';
        const vk = await ask(rl, '  verifyKey: ');
        const qq = await ask(rl, '  QQ 账号: ');
        const qqPassword = await ask(rl, '  QQ 密码 (可选): ');
        Logger.info('  ⏳ 连接中...', 'CLI');
        const ok = await im.connectPlatform('qq', {
          miraiHttpHost: host,
          miraiHttpPort: port,
          miraiVerifyKey: vk,
          qqAccount: qq,
          qqPassword: qqPassword || undefined,
        });
        Logger.info(ok ? '  ✅ QQ 已连接' : '  ❌ 连接失败', 'CLI');
        break;
      }
      case '4': {
        const appId = await ask(rl, '  App ID: ');
        const appSecret = await ask(rl, '  App Secret: ');
        const verificationToken = await ask(
          rl,
          '  Verification Token (可选): '
        );
        const encryptKey = await ask(rl, '  Encrypt Key (可选): ');
        Logger.info('  ⏳ 连接中...', 'CLI');
        const ok = await im.connectPlatform('feishu', {
          appId,
          appSecret,
          verificationToken: verificationToken || undefined,
          encryptKey: encryptKey || undefined,
        });
        Logger.info(ok ? '  ✅ 连接成功' : '  ❌ 连接失败', 'CLI');
        break;
      }
      case '5': {
        const clientId = await ask(rl, '  Client ID: ');
        const clientSecret = await ask(rl, '  Client Secret: ');
        const signatureSecret = await ask(rl, '  签名密钥 (可选): ');
        Logger.info('  ⏳ 连接中...', 'CLI');
        const ok = await im.connectPlatform('dingtalk', {
          appId: clientId,
          appSecret: clientSecret,
          signatureSecret: signatureSecret || undefined,
        });
        Logger.info(ok ? '  ✅ 连接成功' : '  ❌ 连接失败', 'CLI');
        break;
      }
      case 'list': {
        const im2 = getIM();
        const platforms = im2.getPlatforms();
        Logger.info('\n  平台连接状态:\n', 'CLI');
        for (const p of platforms) {
          const s = (p.status?.status as string) || 'disconnected';
          const mark =
            s === 'connected'
              ? '🟢'
              : s === 'connecting'
                ? '🟡'
                : s === 'error'
                  ? '🔴'
                  : '⚪';
          Logger.info(`  ${mark} ${p.icon} ${p.name.padEnd(12)} ${s}`, 'CLI');
        }
        Logger.info('', 'CLI');
        break;
      }
      default:
        Logger.info('  未知选项', 'CLI');
    }
  }
}

/**
 * 处理 gateway 子命令 — 网关管理
 * @param subArgs - 子命令参数
 * @param options - 子命令选项
 */
export async function handleGatewayCommandCLI(
  subArgs: string[],
  options: SubcommandOptions
): Promise<void> {
  const action = subArgs[0] || 'list';

  switch (action) {
    case 'list': {
      try {
        const im = getIM();
        const platforms = im.getPlatforms();

        if (options.json) {
          process.stdout.write(JSON.stringify(platforms, null, 2) + '\n');
        } else {
          if (!options.quiet) {
            process.stdout.write(`网关状态 (${platforms.length} 个平台)\n\n`);
          }
          if (platforms.length === 0) {
            process.stdout.write(`  未配置任何平台连接\n`);
          } else {
            for (const p of platforms) {
              const s = (p.status?.status as string) || 'disconnected';
              const mark =
                s === 'connected'
                  ? '🟢'
                  : s === 'connecting'
                    ? '🟡'
                    : s === 'error'
                      ? '🔴'
                      : '⚪';
              process.stdout.write(`  ${mark} ${p.icon} ${p.name}: ${s}\n`);
            }
          }
        }
      } catch (err) {
        Logger.error('获取网关状态失败', err as Error, 'GatewayCommand');
        process.stderr.write(`获取网关状态失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    case 'connect': {
      const platform = subArgs[1];
      if (!platform) {
        process.stderr.write('错误: gateway connect 需要提供平台名称\n');
        process.stderr.write('可用平台: wechat, qq, feishu, dingtalk\n');
        process.exit(1);
      }

      Logger.info(`连接平台: ${platform}`, 'GatewayCommand');

      try {
        const im = getIM();
        const ok = await im.connectPlatform(
          platform as 'wechat' | 'qq' | 'feishu' | 'dingtalk',
          {}
        );

        if (options.json) {
          process.stdout.write(
            JSON.stringify({ success: ok, platform }, null, 2) + '\n'
          );
        } else {
          process.stdout.write(
            ok ? `✅ ${platform} 已连接\n` : `❌ ${platform} 连接失败\n`
          );
        }
      } catch (err) {
        Logger.error('连接平台失败', err as Error, 'GatewayCommand');
        process.stderr.write(`连接平台失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    default:
      process.stderr.write(`未知 gateway 子命令: ${action}\n`);
      process.stderr.write('用法: gateway list | gateway connect <平台>\n');
      process.exit(1);
  }
}
