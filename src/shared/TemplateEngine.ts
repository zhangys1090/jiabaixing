/**
 * TemplateEngine — 简单模板变量替换
 *
 * 将字符串中的 {variable.path} 替换为 payload 对象中的对应值。
 * 支持嵌套路径（dot notation）、完整 JSON 注入（{__raw__}）、默认值。
 */

export class TemplateEngine {
  /**
   * 替换字符串中的所有 {variable.path} 占位符
   *
   * 用法:
   *   const engine = new TemplateEngine();
   *   engine.render("Hello {name}", { name: "World" });
   *   // → "Hello World"
   *
   *   engine.render("PR #{pull_request.number}: {pull_request.title}", {
   *     pull_request: { number: 42, title: "Fix bug" }
   *   });
   *   // → "PR #42: Fix bug"
   *
   *   engine.render("Full: {__raw__}", { foo: "bar" });
   *   // → 'Full: {"foo":"bar"}'
   */
  render(template: string, payload: Record<string, unknown>): string {
    return template.replace(/\{(\w[\w.]*)\}/g, (_match, path: string) => {
      if (path === '__raw__') {
        return JSON.stringify(payload, null, 2).substring(0, 4000);
      }
      const value = this.resolvePath(payload, path);
      if (value === undefined) {
        return `{${path}}`; // 保留未匹配的占位符
      }
      if (typeof value === 'object') {
        return JSON.stringify(value);
      }
      return String(value);
    });
  }

  /**
   * 递归解析嵌套路径
   * resolvePath({ a: { b: "c" } }, "a.b") → "c"
   */
  private resolvePath(obj: unknown, path: string): unknown {
    const parts = path.split('.');
    let current = obj;

    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      if (typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }

    return current;
  }
}
