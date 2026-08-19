import { useEffect, useCallback } from 'react';
import { useUIStore } from '../stores/useUIStore';
import type { ModuleId } from '../types/chat';

// 快捷键配置
export interface Shortcut {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  description: string;
  action: () => void;
}

// 模块快捷键映射
const MODULE_SHORTCUTS: Record<number, ModuleId> = {
  1: 'chat',
  2: 'memory',
  3: 'agent',
  4: 'evolution',
  5: 'skills',
  6: 'desktop',
  7: 'automation',
  8: 'security',
  9: 'monitor',
};

export const useKeyboardShortcuts = () => {
  const {
    setActiveModule,
    toggleRightPanel,
    toggleLeftPanel,
    setTheme,
    theme,
    setSettingsOpen,
    setSkillConsoleOpen,
    resetPanels,
  } = useUIStore();

  // 检查按键是否匹配
  const matchesShortcut = (event: KeyboardEvent, shortcut: Shortcut): boolean => {
    const { key, ctrl, meta, shift, alt } = shortcut;

    // 检查按键
    if (event.key.toLowerCase() !== key.toLowerCase()) return false;

    // 检查修饰键
    if (ctrl && !event.ctrlKey) return false;
    if (meta && !event.metaKey) return false;
    if (shift && !event.shiftKey) return false;
    if (alt && !event.altKey) return false;

    // 检查是否有额外的修饰键
    if (!ctrl && event.ctrlKey) return false;
    if (!meta && event.metaKey) return false;
    if (!shift && event.shiftKey) return false;
    if (!alt && event.altKey) return false;

    return true;
  };

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      // 避免在输入框中触发快捷键
      const target = event.target as HTMLElement;
      const isInput = ['INPUT', 'TEXTAREA'].includes(target.tagName) || target.isContentEditable;

      if (isInput && event.key !== 'Escape') return;

      // 模块切换快捷键 (Ctrl+1 ~ Ctrl+9)
      if ((event.ctrlKey || event.metaKey) && /^[1-9]$/.test(event.key)) {
        const moduleNum = parseInt(event.key);
        const moduleId = MODULE_SHORTCUTS[moduleNum];
        if (moduleId) {
          event.preventDefault();
          setActiveModule(moduleId);
          return;
        }
      }

      // 其他快捷键
      const shortcuts: Shortcut[] = [
        {
          key: 'b',
          ctrl: true,
          description: '切换右侧面板',
          action: () => toggleRightPanel(),
        },
        {
          key: 'l',
          ctrl: true,
          description: '切换左侧面板',
          action: () => toggleLeftPanel(),
        },
        {
          key: 't',
          ctrl: true,
          description: '切换主题',
          action: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
        },
        {
          key: ',',
          ctrl: true,
          description: '打开设置',
          action: () => setSettingsOpen(true),
        },
        {
          key: 'k',
          ctrl: true,
          description: '打开技能控制台',
          action: () => setSkillConsoleOpen(true),
        },
        {
          key: 'Escape',
          description: '关闭弹窗/面板',
          action: () => {
            setSettingsOpen(false);
            setSkillConsoleOpen(false);
          },
        },
        {
          key: 'r',
          ctrl: true,
          shift: true,
          description: '重置面板布局',
          action: () => resetPanels(),
        },
      ];

      for (const shortcut of shortcuts) {
        if (matchesShortcut(event, shortcut)) {
          event.preventDefault();
          shortcut.action();
          break;
        }
      }
    },
    [
      theme,
      setActiveModule,
      toggleRightPanel,
      toggleLeftPanel,
      setTheme,
      setSettingsOpen,
      setSkillConsoleOpen,
      resetPanels,
    ]
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);
};

// 快捷键提示组件数据
export const getKeyboardShortcuts = (): Shortcut[] => {
  return [
    { key: '1', ctrl: true, description: '切换到对话模块', action: () => {} },
    { key: '2', ctrl: true, description: '切换到记忆模块', action: () => {} },
    { key: '3', ctrl: true, description: '切换到Agent模块', action: () => {} },
    { key: '4', ctrl: true, description: '切换到进化模块', action: () => {} },
    { key: '5', ctrl: true, description: '切换到技能模块', action: () => {} },
    { key: '6', ctrl: true, description: '切换到桌面代理', action: () => {} },
    { key: '7', ctrl: true, description: '切换到自动化', action: () => {} },
    { key: '8', ctrl: true, description: '切换到安全模块', action: () => {} },
    { key: '9', ctrl: true, description: '切换到监控模块', action: () => {} },
    { key: 'b', ctrl: true, description: '切换右侧面板', action: () => {} },
    { key: 'l', ctrl: true, description: '切换左侧面板', action: () => {} },
    { key: 't', ctrl: true, description: '切换主题', action: () => {} },
    { key: ',', ctrl: true, description: '打开设置', action: () => {} },
    { key: 'k', ctrl: true, description: '打开技能控制台', action: () => {} },
    { key: 'Escape', description: '关闭弹窗', action: () => {} },
    {
      key: 'r',
      ctrl: true,
      shift: true,
      description: '重置面板布局',
      action: () => {},
    },
  ];
};
