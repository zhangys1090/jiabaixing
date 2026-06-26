import {
  checkDangerousCommand,
  checkSensitiveInfo,
  sanitizeText,
} from '../SensitiveDetector';

describe('SensitiveDetector - 敏感信息检测器', () => {
  describe('checkSensitiveInfo - 敏感信息检测', () => {
    test('正常文本应返回安全', () => {
      const result = checkSensitiveInfo('这是一段正常的文本内容');
      expect(result.safe).toBe(true);
      expect(result.riskLevel).toBe('none');
      expect(result.violations).toHaveLength(0);
    });

    test('应该检测API密钥', () => {
      const result = checkSensitiveInfo('sk-abc123def456ghi789jkl012mno345');
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.name === 'API密钥')).toBe(true);
    });

    test('应该检测AWS访问密钥', () => {
      const result = checkSensitiveInfo('AKIAIOSFODNN7EXAMPLE');
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.name === 'AWS访问密钥')).toBe(
        true
      );
    });

    test('应该检测密码泄露', () => {
      const result = checkSensitiveInfo('密码: mySecretPassword123');
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.name === '密码泄露')).toBe(true);
    });

    test('应该检测手机号码', () => {
      const result = checkSensitiveInfo('手机号: 13812345678');
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.name === '手机号码')).toBe(true);
    });

    test('应该检测邮箱地址', () => {
      const result = checkSensitiveInfo('联系: user@example.com');
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.name === '邮箱地址')).toBe(true);
    });

    test('应该检测银行卡号', () => {
      const result = checkSensitiveInfo('卡号: 6222021234567890123');
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.name === '银行卡号')).toBe(true);
    });

    test('应该检测身份证号', () => {
      const result = checkSensitiveInfo('身份证: 110101199001011234');
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.name.includes('身份证'))).toBe(
        true
      );
    });

    test('应该检测Bearer认证头', () => {
      const result = checkSensitiveInfo(
        'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9'
      );
      expect(result.safe).toBe(false);
      expect(result.violations.some((v) => v.name === '认证头泄露')).toBe(true);
    });

    test('应该返回脱敏后的文本', () => {
      const result = checkSensitiveInfo('密码: mySecretPassword123');
      expect(result.sanitizedOutput).toBeDefined();
      expect(result.sanitizedOutput).toContain('[已脱敏]');
      expect(result.sanitizedOutput).not.toContain('mySecretPassword123');
    });

    test('不同场景应使用不同模式子集', () => {
      const outputResult = checkSensitiveInfo('Bearer token123', 'output');
      const storageResult = checkSensitiveInfo('Bearer token123', 'storage');
      expect(outputResult.safe).toBe(false);
      expect(storageResult.safe).toBe(true);
    });
  });

  describe('checkDangerousCommand - 危险命令检测', () => {
    test('正常命令应返回安全', () => {
      const result = checkDangerousCommand('ls -la');
      expect(result.dangerous).toBe(false);
    });

    test('应该检测 rm -rf /', () => {
      const result = checkDangerousCommand('rm -rf /');
      expect(result.dangerous).toBe(true);
      expect(result.reason).toBeDefined();
    });

    test('应该检测 DROP TABLE', () => {
      const result = checkDangerousCommand('DROP TABLE users;');
      expect(result.dangerous).toBe(true);
    });

    test('应该检测 shutdown', () => {
      const result = checkDangerousCommand('shutdown -h now');
      expect(result.dangerous).toBe(true);
    });

    test('应该检测 format', () => {
      const result = checkDangerousCommand('format C:');
      expect(result.dangerous).toBe(true);
    });

    test('正常npm命令应通过', () => {
      const result = checkDangerousCommand('npm install express');
      expect(result.dangerous).toBe(false);
    });
  });

  describe('sanitizeText - 文本脱敏', () => {
    test('应该脱敏API密钥', () => {
      const result = sanitizeText('key: sk-abc123def456ghi789jkl012mno345');
      expect(result).toContain('[API密钥-已脱敏]');
      expect(result).not.toContain('sk-abc123def456ghi789jkl012mno345');
    });

    test('应该脱敏手机号', () => {
      const result = sanitizeText('手机: 13812345678');
      expect(result).toContain('[手机号-已脱敏]');
    });

    test('应该脱敏邮箱', () => {
      const result = sanitizeText('邮箱: user@example.com');
      expect(result).toContain('[邮箱-已脱敏]');
    });

    test('应该脱敏银行卡号', () => {
      const result = sanitizeText('卡号: 6222021234567890123');
      expect(result).toContain('[银行卡-已脱敏]');
    });

    test('应该脱敏密码值', () => {
      const result = sanitizeText('密码: myPassword123');
      expect(result).toContain('[已脱敏]');
      expect(result).not.toContain('myPassword123');
    });

    test('正常文本不应被修改', () => {
      const text = '这是一段正常的文本';
      expect(sanitizeText(text)).toBe(text);
    });
  });
});
