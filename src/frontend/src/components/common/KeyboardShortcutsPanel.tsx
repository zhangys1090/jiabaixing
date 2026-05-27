import React from 'react';
import { useUIStore } from '../../stores/useUIStore';
import { getKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { AnimatedModal } from './AnimatedTransition';

export const KeyboardShortcutsPanel: React.FC = () => {
  const { settingsOpen, setSettingsOpen } = useUIStore();
  const shortcuts = getKeyboardShortcuts();

  const formatKey = (key: string): string => {
    if (key === 'Escape') return 'Esc';
    if (key === ',') return '逗号';
    return key.toUpperCase();
  };

  const getModifierKeys = (shortcut: (typeof shortcuts)[0]): string[] => {
    const modifiers: string[] = [];
    if (shortcut.ctrl || shortcut.meta) modifiers.push('Ctrl');
    if (shortcut.shift) modifiers.push('Shift');
    if (shortcut.alt) modifiers.push('Alt');
    return modifiers;
  };

  return (
    <AnimatedModal isOpen={settingsOpen}>
      <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
        <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-gray-700">
            <h2 className="text-xl font-semibold text-white">快捷键</h2>
            <button
              onClick={() => setSettingsOpen(false)}
              className="p-2 hover:bg-gray-800 rounded-lg transition-colors text-gray-400 hover:text-white"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Content */}
          <div className="p-4 overflow-y-auto max-h-[calc(80vh-80px)]">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Module Shortcuts */}
              <div>
                <h3 className="text-sm font-medium text-gray-400 mb-3">模块切换</h3>
                <div className="space-y-2">
                  {shortcuts.slice(0, 9).map((shortcut, index) => (
                    <div key={index} className="flex items-center justify-between py-2 px-3 bg-gray-800/50 rounded-lg">
                      <span className="text-gray-300 text-sm">{shortcut.description}</span>
                      <div className="flex items-center gap-1">
                        {getModifierKeys(shortcut).map((mod, i) => (
                          <React.Fragment key={i}>
                            <kbd className="px-2 py-1 bg-gray-700 text-gray-200 text-xs rounded border border-gray-600">
                              {mod}
                            </kbd>
                            <span className="text-gray-500 text-xs">+</span>
                          </React.Fragment>
                        ))}
                        <kbd className="px-2 py-1 bg-gray-700 text-gray-200 text-xs rounded border border-gray-600">
                          {formatKey(shortcut.key)}
                        </kbd>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Other Shortcuts */}
              <div>
                <h3 className="text-sm font-medium text-gray-400 mb-3">其他操作</h3>
                <div className="space-y-2">
                  {shortcuts.slice(9).map((shortcut, index) => (
                    <div key={index} className="flex items-center justify-between py-2 px-3 bg-gray-800/50 rounded-lg">
                      <span className="text-gray-300 text-sm">{shortcut.description}</span>
                      <div className="flex items-center gap-1">
                        {getModifierKeys(shortcut).map((mod, i) => (
                          <React.Fragment key={i}>
                            <kbd className="px-2 py-1 bg-gray-700 text-gray-200 text-xs rounded border border-gray-600">
                              {mod}
                            </kbd>
                            <span className="text-gray-500 text-xs">+</span>
                          </React.Fragment>
                        ))}
                        <kbd className="px-2 py-1 bg-gray-700 text-gray-200 text-xs rounded border border-gray-600">
                          {formatKey(shortcut.key)}
                        </kbd>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="p-4 border-t border-gray-700 bg-gray-800/50">
            <p className="text-xs text-gray-500 text-center">
              按 <kbd className="px-1 py-0.5 bg-gray-700 rounded text-xs">Esc</kbd> 或点击外部区域关闭
            </p>
          </div>
        </div>
      </div>
    </AnimatedModal>
  );
};
