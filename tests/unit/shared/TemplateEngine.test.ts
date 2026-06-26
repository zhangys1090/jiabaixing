/**
 * TemplateEngine 单元测试
 */
import { TemplateEngine } from '../../../src/shared/TemplateEngine';

describe('TemplateEngine', () => {
  const engine = new TemplateEngine();

  it('应替换简单变量', () => {
    const result = engine.render('Hello {name}', { name: 'World' });
    expect(result).toBe('Hello World');
  });

  it('应替换嵌套路径', () => {
    const result = engine.render('PR #{pull_request.number}', {
      pull_request: { number: 42 },
    });
    expect(result).toBe('PR #42');
  });

  it('应替换多级嵌套', () => {
    const result = engine.render(
      '{repository.full_name} #{pull_request.number}',
      {
        repository: { full_name: 'user/repo' },
        pull_request: { number: 7 },
      }
    );
    expect(result).toBe('user/repo #7');
  });

  it('未匹配的占位符应保留原样', () => {
    const result = engine.render('Hello {unknown}', { name: 'World' });
    expect(result).toBe('Hello {unknown}');
  });

  it('{__raw__} 应返回完整 JSON', () => {
    const result = engine.render('Full: {__raw__}', { hello: 'world' });
    expect(result).toContain('"hello"');
    expect(result).toContain('"world"');
  });

  it('对象值应序列化为 JSON', () => {
    const result = engine.render('Labels: {issue.labels}', {
      issue: { labels: ['bug', 'priority'] },
    });
    expect(result).toContain('bug');
  });

  it('多变量替换', () => {
    const result = engine.render('Repo: {repo}, PR: #{pr}, Author: {author}', {
      repo: 'org/repo',
      pr: 99,
      author: 'alice',
    });
    expect(result).toBe('Repo: org/repo, PR: #99, Author: alice');
  });

  it('无变量的字符串应返回原样', () => {
    const result = engine.render('Hello World', {});
    expect(result).toBe('Hello World');
  });

  it('空模板应返回空', () => {
    const result = engine.render('', { a: 1 });
    expect(result).toBe('');
  });

  it('数字应转为字符串', () => {
    const result = engine.render('Count: {count}', { count: 42 });
    expect(result).toBe('Count: 42');
  });
});
