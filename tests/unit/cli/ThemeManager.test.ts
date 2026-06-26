import { ThemeManager, Theme } from '../../../src/cli/themes/ThemeManager';

describe('ThemeManager', () => {
  let manager: ThemeManager;

  beforeEach(() => {
    manager = new ThemeManager();
  });

  it('应加载预定义主题', () => {
    const theme = manager.getTheme('default');

    expect(theme).toBeDefined();
    expect(theme!.bannerColor).toBeDefined();
    expect(theme!.loadingIcon).toBeDefined();
    expect(theme!.responseLabel).toBeDefined();
  });

  it('应支持自定义主题', () => {
    const custom: Partial<Theme> = {
      bannerColor: '#ff0000',
      responseLabel: '家百星',
    };

    manager.setTheme('custom', custom);
    const loaded = manager.getTheme('custom');

    expect(loaded).toBeDefined();
    expect(loaded!.bannerColor).toBe('#ff0000');
    expect(loaded!.responseLabel).toBe('家百星');
  });

  it('应列出所有可用主题', () => {
    const themes = manager.listThemes();

    expect(themes.length).toBeGreaterThan(0);
    expect(themes.map((t) => t.name)).toContain('default');
    expect(themes.map((t) => t.name)).toContain('dark');
    expect(themes.map((t) => t.name)).toContain('minimal');
  });

  it('应切换激活主题', () => {
    const result = manager.setActiveTheme('dark');

    expect(result).toBe(true);
    expect(manager.getActiveTheme().name).toBe('dark');
  });

  it('切换不存在的主题应返回 false', () => {
    const result = manager.setActiveTheme('nonexistent');

    expect(result).toBe(false);
    expect(manager.getActiveTheme().name).toBe('default');
  });

  it('应格式化横幅文字', () => {
    const banner = manager.formatBanner();

    expect(banner).toContain('家百星');
  });

  it('应格式化加载文字', () => {
    const loading = manager.formatLoading();

    expect(loading).toContain('思考中');
  });

  it('应格式化响应标签', () => {
    const label = manager.formatResponseLabel();

    expect(label).toContain('家百星');
  });

  it('应格式化工具活动', () => {
    const activity = manager.formatToolActivity('file_read');

    expect(activity).toContain('file_read');
  });

  it('自定义主题应继承默认值', () => {
    manager.setTheme('partial', { bannerColor: '#00ff00' });
    const theme = manager.getTheme('partial');

    expect(theme!.bannerColor).toBe('#00ff00');
    expect(theme!.loadingIcon).toBeDefined(); // inherited from default
  });
});
