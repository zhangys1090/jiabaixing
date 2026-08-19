/**
 * electron-updater 模块 Mock
 */

const { EventEmitter } = require('events');

class MockAutoUpdater extends EventEmitter {
  constructor() {
    super();
    this.autoDownload = false;
    this.autoInstallOnAppQuit = false;
    this.allowPrerelease = false;
    this.allowDowngrade = false;
  }
  checkForUpdates() {
    return Promise.resolve();
  }
  downloadUpdate() {
    return Promise.resolve();
  }
  quitAndInstall() {}
  setFeedURL() {}
}

const autoUpdater = new MockAutoUpdater();

module.exports = { autoUpdater };
