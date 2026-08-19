import { useCallback, useEffect, useState } from 'react';
import { desktopBridge } from '../services/DesktopBridge';
import type { TrayStatus, UpdateInfo, UpdateProgress } from '../types/electron';

interface UseElectronResult {
  isElectron: boolean;
  platform: string;
  bridge: typeof desktopBridge;
}

export function useElectron(): UseElectronResult {
  const [isElectron, setIsElectron] = useState(false);

  useEffect(() => {
    setIsElectron(desktopBridge.isElectron);
  }, []);

  return {
    isElectron,
    platform: desktopBridge.platform,
    bridge: desktopBridge,
  };
}

export function useTrayStatus() {
  const [status, setStatus] = useState<TrayStatus | null>(null);

  useEffect(() => {
    desktopBridge.getTrayStatus().then(setStatus);
  }, []);

  const showWindow = useCallback(() => {
    desktopBridge.showWindow();
  }, []);

  const hideWindow = useCallback(() => {
    desktopBridge.hideWindow();
  }, []);

  return { status, showWindow, hideWindow };
}

export function useAutoUpdate() {
  const [updateAvailable, setUpdateAvailable] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const unsubAvailable = desktopBridge.onUpdateAvailable((info) => {
      setUpdateAvailable(info);
    });
    const unsubProgress = desktopBridge.onUpdateProgress((p) => {
      setProgress(p);
    });
    const unsubDownloaded = desktopBridge.onUpdateDownloaded(() => {
      setDownloaded(true);
    });
    const unsubError = desktopBridge.onUpdateError((err) => {
      setError(err);
    });

    return () => {
      unsubAvailable();
      unsubProgress();
      unsubDownloaded();
      unsubError();
    };
  }, []);

  return {
    updateAvailable,
    progress,
    downloaded,
    error,
    checkForUpdates: () => desktopBridge.checkForUpdates(),
    downloadUpdate: () => desktopBridge.downloadUpdate(),
    installUpdate: () => desktopBridge.installUpdate(),
  };
}

export function useNotifications() {
  const show = useCallback((title: string, body: string, options?: { icon?: string; silent?: boolean }) => {
    desktopBridge.showNotification({ title, body, ...options });
  }, []);

  const onClick = useCallback((callback: () => void) => {
    return desktopBridge.onNotificationClick(callback);
  }, []);

  return { show, onClick };
}

export function useWindowControls() {
  const minimize = useCallback(() => desktopBridge.minimize(), []);
  const maximize = useCallback(() => desktopBridge.maximize(), []);
  const close = useCallback(() => desktopBridge.close(), []);
  const toggleFullscreen = useCallback(() => desktopBridge.toggleFullscreen(), []);

  return { minimize, maximize, close, toggleFullscreen };
}
