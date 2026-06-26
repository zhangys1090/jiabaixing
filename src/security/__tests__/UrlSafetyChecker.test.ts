import { UrlSafetyChecker } from '../UrlSafetyChecker';

describe('UrlSafetyChecker - URL安全检查器', () => {
  let checker: UrlSafetyChecker;

  beforeEach(() => {
    checker = UrlSafetyChecker.getInstance();
    checker.addToAllowlist('https://api.openai.com');
    checker.addBlocklistPattern('evil\\.com');
  });

  afterEach(() => {
    checker['allowlist'].clear();
    checker['blocklist'].clear();
    checker['customRules'] = [];
  });

  describe('基础功能', () => {
    test('应该检测正常URL为安全', () => {
      const result = checker.check('https://www.example.com/path');
      expect(result.safe).toBe(true);
      expect(result.riskLevel).toBe('safe');
      expect(result.category).toBe('正常');
    });

    test('应该检测IP直连URL', () => {
      const result = checker.check('http://192.168.1.1/admin');
      expect(result.safe).toBe(false);
      expect(result.riskLevel).toBe('medium');
      expect(result.category).toBe('IP直连');
    });

    test('应该检测高风险TLD', () => {
      const result = checker.check('https://phishing.tk/login');
      expect(result.safe).toBe(false);
      expect(result.riskLevel).toBe('high');
      expect(result.category).toBe('高风险TLD');
    });

    test('应该检测短链接', () => {
      const result = checker.check('https://bit.ly/abc123');
      expect(result.safe).toBe(false);
      expect(result.riskLevel).toBe('medium');
      expect(result.category).toBe('短链接');
    });

    test('应该检测javascript协议（critical）', () => {
      const result = checker.check('javascript:alert(1)');
      expect(result.safe).toBe(false);
      expect(result.riskLevel).toBe('critical');
      expect(result.category).toBe('JavaScript协议');
    });

    test('应该检测Data URI注入', () => {
      const result = checker.check('data:text/html,<script>alert(1)</script>');
      expect(result.safe).toBe(false);
      expect(result.riskLevel).toBe('critical');
      expect(result.category).toBe('Data URI');
    });
  });

  describe('白名单机制', () => {
    test('白名单中的URL应该直接放行', () => {
      const result = checker.check(
        'https://api.openai.com/v1/chat/completions'
      );
      expect(result.safe).toBe(true);
      expect(result.category).toBe('白名单');
    });

    test('白名单根路径也应放行', () => {
      const result = checker.check('https://api.openai.com');
      expect(result.safe).toBe(true);
      expect(result.category).toBe('白名单');
    });
  });

  describe('黑名单机制', () => {
    test('黑名单模式匹配的URL应该拦截', () => {
      const result = checker.check('https://evil.com/malware');
      expect(result.safe).toBe(false);
      expect(result.riskLevel).toBe('critical');
      expect(result.category).toBe('黑名单');
    });
  });

  describe('凭证暴露检测', () => {
    test('应该检测URL中的明文凭证', () => {
      const result = checker.check('https://user:password@example.com/api');
      expect(result.safe).toBe(false);
      expect(result.category).toBe('凭证暴露');
    });
  });

  describe('批量检查', () => {
    test('应该支持批量URL安全检查', () => {
      const urls = [
        'https://safe.com',
        'http://192.168.1.1/',
        'javascript:void(0)',
        'https://phishing.xyz/',
      ];
      const results = checker.checkBatch(urls);
      expect(results).toHaveLength(4);
      expect(results[0].safe).toBe(true);
      expect(results[1].safe).toBe(false);
      expect(results[2].safe).toBe(false);
      expect(results[3].safe).toBe(false);
    });
  });

  describe('文本扫描', () => {
    test('应该从文本中提取并检查URL', () => {
      const text = '请访问 https://example.com 和 http://192.168.1.1/';
      const scanResult = checker.scanTextForUnsafeUrls(text);
      expect(scanResult.totalUrls).toBe(2);
      expect(scanResult.unsafeResults.length).toBe(1);
      expect(scanResult.unsafeResults[0].category).toBe('IP直连');
    });
  });

  describe('自定义规则', () => {
    test('应该支持添加自定义规则', () => {
      checker.addCustomRule({
        pattern: /test-danger/i,
        category: '测试危险',
        risk: 'high',
        reason: '测试用危险规则',
      });
      const result = checker.check('https://test-danger.example.com');
      expect(result.safe).toBe(false);
      expect(result.category).toBe('测试危险');
    });
  });

  describe('边界情况', () => {
    test('空输入应返回错误', () => {
      const result = checker.check('');
      expect(result.safe).toBe(false);
      expect(result.riskLevel).toBe('critical');
    });

    test('null/undefined应返回错误', () => {
      const result = checker.check(null as unknown as string);
      expect(result.safe).toBe(false);
    });
  });
});
