/**
 * channels.js 单元测试
 *
 * 测试 IPC 通道常量定义的完整性和正确性
 */

const channels = require('../../../electron/ipc/channels');

describe('IPC Channels', () => {
  describe('通道定义完整性', () => {
    it('should export all channel groups', () => {
      expect(channels).toHaveProperty('WINDOW');
      expect(channels).toHaveProperty('SYSTEM');
      expect(channels).toHaveProperty('FILE');
      expect(channels).toHaveProperty('SHELL');
      expect(channels).toHaveProperty('SERVICE');
      expect(channels).toHaveProperty('APP');
      expect(channels).toHaveProperty('TRAY');
      expect(channels).toHaveProperty('SHORTCUTS');
      expect(channels).toHaveProperty('NOTIFICATION');
      expect(channels).toHaveProperty('UPDATE');
    });
  });

  describe('WINDOW 通道', () => {
    it('should define all window channels', () => {
      expect(channels.WINDOW.MINIMIZE).toBe('window:minimize');
      expect(channels.WINDOW.MAXIMIZE).toBe('window:maximize');
      expect(channels.WINDOW.CLOSE).toBe('window:close');
      expect(channels.WINDOW.FULLSCREEN).toBe('window:fullscreen');
      expect(channels.WINDOW.MAXIMIZE_CHANGE).toBe('window:maximize-change');
    });

    it('should have unique channel names', () => {
      const values = Object.values(channels.WINDOW);
      expect(new Set(values).size).toBe(values.length);
    });
  });

  describe('SYSTEM 通道', () => {
    it('should define system channels', () => {
      expect(channels.SYSTEM.GET_INFO).toBe('system:get-info');
      expect(channels.SYSTEM.GET_PATH).toBe('system:get-path');
    });
  });

  describe('FILE 通道', () => {
    it('should define all file channels', () => {
      expect(channels.FILE.OPEN_DIALOG).toBe('file:open-dialog');
      expect(channels.FILE.SAVE_DIALOG).toBe('file:save-dialog');
      expect(channels.FILE.READ).toBe('file:read');
      expect(channels.FILE.WRITE).toBe('file:write');
    });
  });

  describe('SHELL 通道', () => {
    it('should define shell channels', () => {
      expect(channels.SHELL.OPEN_URL).toBe('shell:open-url');
      expect(channels.SHELL.OPEN_PATH).toBe('shell:open-path');
    });
  });

  describe('SERVICE 通道', () => {
    it('should define all service channels', () => {
      expect(channels.SERVICE.SEND_MESSAGE).toBe('service:send-message');
      expect(channels.SERVICE.GET_STATUS).toBe('service:get-status');
      expect(channels.SERVICE.MESSAGE_RECEIVED).toBe('service:message-received');
    });
  });

  describe('APP 通道', () => {
    it('should define all app channels', () => {
      expect(channels.APP.QUIT).toBe('app:quit');
      expect(channels.APP.RELOAD).toBe('app:reload');
      expect(channels.APP.TOGGLE_DEVTOOLS).toBe('app:toggle-devtools');
    });
  });

  describe('TRAY 通道', () => {
    it('should define tray channels', () => {
      expect(channels.TRAY.STATUS).toBe('tray:status');
      expect(channels.TRAY.SHOW_WINDOW).toBe('tray:show-window');
      expect(channels.TRAY.HIDE_WINDOW).toBe('tray:hide-window');
    });
  });

  describe('SHORTCUTS 通道', () => {
    it('should define shortcut channels', () => {
      expect(channels.SHORTCUTS.REGISTER).toBe('shortcuts:register');
      expect(channels.SHORTCUTS.UNREGISTER).toBe('shortcuts:unregister');
      expect(channels.SHORTCUTS.TRIGGERED).toBe('shortcuts:triggered');
    });
  });

  describe('NOTIFICATION 通道', () => {
    it('should define notification channels', () => {
      expect(channels.NOTIFICATION.SHOW).toBe('notification:show');
      expect(channels.NOTIFICATION.CLICK).toBe('notification:click');
      expect(channels.NOTIFICATION.CLOSE).toBe('notification:close');
    });
  });

  describe('UPDATE 通道', () => {
    it('should define all update channels', () => {
      expect(channels.UPDATE.CHECK).toBe('update:check');
      expect(channels.UPDATE.DOWNLOAD).toBe('update:download');
      expect(channels.UPDATE.INSTALL).toBe('update:install');
      expect(channels.UPDATE.PROGRESS).toBe('update:progress');
      expect(channels.UPDATE.AVAILABLE).toBe('update:available');
      expect(channels.UPDATE.NOT_AVAILABLE).toBe('update:not-available');
      expect(channels.UPDATE.ERROR).toBe('update:error');
    });
  });

  describe('通道命名规范', () => {
    it('all channel names should follow group:action pattern', () => {
      const allChannels = Object.values(channels).flatMap((group) => Object.values(group));
      allChannels.forEach((channel) => {
        expect(channel).toMatch(/^[a-z]+:[a-z-]+$/);
      });
    });

    it('should have no duplicate channel names across all groups', () => {
      const allChannels = Object.values(channels).flatMap((group) => Object.values(group));
      expect(new Set(allChannels).size).toBe(allChannels.length);
    });
  });
});
