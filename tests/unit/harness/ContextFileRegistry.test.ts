import {
  ContextFileRegistry,
  CONTEXT_FILE_PRIORITY,
  SOUL_FILE_NAME,
} from '../../../src/harness/context/ContextFileRegistry';

describe('ContextFileRegistry 增强发现', () => {
  it('应包含 .hermes.md 在优先级列表中', () => {
    const fileNames = CONTEXT_FILE_PRIORITY as readonly string[];
    expect(fileNames).toContain('.hermes.md');
  });

  it('应包含 .cursorrules 在优先级列表中', () => {
    const fileNames = CONTEXT_FILE_PRIORITY as readonly string[];
    expect(fileNames).toContain('.cursorrules');
  });

  it('优先级顺序应为: JIABAIXING.md > .hermes.md > AGENTS.md > CLAUDE.md > .cursorrules', () => {
    const fileNames = [...CONTEXT_FILE_PRIORITY];
    expect(fileNames.indexOf('JIABAIXING.md')).toBeLessThan(
      fileNames.indexOf('.hermes.md')
    );
    expect(fileNames.indexOf('.hermes.md')).toBeLessThan(
      fileNames.indexOf('AGENTS.md')
    );
    expect(fileNames.indexOf('AGENTS.md')).toBeLessThan(
      fileNames.indexOf('CLAUDE.md')
    );
    expect(fileNames.indexOf('CLAUDE.md')).toBeLessThan(
      fileNames.indexOf('.cursorrules')
    );
  });

  it('SOUL_FILE_NAME 应为 SOUL.md', () => {
    expect(SOUL_FILE_NAME).toBe('SOUL.md');
  });

  it('isAllowedFileName 应识别新增文件', () => {
    const registry = new ContextFileRegistry();
    expect(registry.isAllowedFileName('.hermes.md')).toBe(true);
    expect(registry.isAllowedFileName('.cursorrules')).toBe(true);
  });

  it('getAllowedFileNames 应包含新增文件', () => {
    const registry = new ContextFileRegistry();
    const allowed = registry.getAllowedFileNames();
    expect(allowed).toContain('.hermes.md');
    expect(allowed).toContain('.cursorrules');
  });
});
