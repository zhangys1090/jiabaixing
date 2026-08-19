export function isElectronEnv(): boolean {
  return typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined';
}

export function getPlatform(): string {
  if (isElectronEnv()) {
    return window.electronAPI?.platform || 'unknown';
  }
  if (typeof navigator !== 'undefined') {
    return navigator.platform;
  }
  return 'unknown';
}

export function isMac(): boolean {
  return getPlatform().toLowerCase().includes('mac') || getPlatform().toLowerCase().includes('darwin');
}

export function isWindows(): boolean {
  return getPlatform().toLowerCase().includes('win');
}

export function isLinux(): boolean {
  return getPlatform().toLowerCase().includes('linux');
}

export function isDev(): boolean {
  return process.env.NODE_ENV === 'development';
}

export function isProd(): boolean {
  return process.env.NODE_ENV === 'production';
}
