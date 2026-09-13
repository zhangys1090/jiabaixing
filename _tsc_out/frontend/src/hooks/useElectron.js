"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useElectron = useElectron;
exports.useTrayStatus = useTrayStatus;
exports.useAutoUpdate = useAutoUpdate;
exports.useNotifications = useNotifications;
exports.useWindowControls = useWindowControls;
const react_1 = require("react");
const DesktopBridge_1 = require("../services/DesktopBridge");
function useElectron() {
    const [isElectron, setIsElectron] = (0, react_1.useState)(false);
    (0, react_1.useEffect)(() => {
        setIsElectron(DesktopBridge_1.desktopBridge.isElectron);
    }, []);
    return {
        isElectron,
        platform: DesktopBridge_1.desktopBridge.platform,
        bridge: DesktopBridge_1.desktopBridge,
    };
}
function useTrayStatus() {
    const [status, setStatus] = (0, react_1.useState)(null);
    (0, react_1.useEffect)(() => {
        DesktopBridge_1.desktopBridge.getTrayStatus().then(setStatus);
    }, []);
    const showWindow = (0, react_1.useCallback)(() => {
        DesktopBridge_1.desktopBridge.showWindow();
    }, []);
    const hideWindow = (0, react_1.useCallback)(() => {
        DesktopBridge_1.desktopBridge.hideWindow();
    }, []);
    return { status, showWindow, hideWindow };
}
function useAutoUpdate() {
    const [updateAvailable, setUpdateAvailable] = (0, react_1.useState)(null);
    const [progress, setProgress] = (0, react_1.useState)(null);
    const [downloaded, setDownloaded] = (0, react_1.useState)(false);
    const [error, setError] = (0, react_1.useState)(null);
    (0, react_1.useEffect)(() => {
        const unsubAvailable = DesktopBridge_1.desktopBridge.onUpdateAvailable((info) => {
            setUpdateAvailable(info);
        });
        const unsubProgress = DesktopBridge_1.desktopBridge.onUpdateProgress((p) => {
            setProgress(p);
        });
        const unsubDownloaded = DesktopBridge_1.desktopBridge.onUpdateDownloaded(() => {
            setDownloaded(true);
        });
        const unsubError = DesktopBridge_1.desktopBridge.onUpdateError((err) => {
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
        checkForUpdates: () => DesktopBridge_1.desktopBridge.checkForUpdates(),
        downloadUpdate: () => DesktopBridge_1.desktopBridge.downloadUpdate(),
        installUpdate: () => DesktopBridge_1.desktopBridge.installUpdate(),
    };
}
function useNotifications() {
    const show = (0, react_1.useCallback)((title, body, options) => {
        DesktopBridge_1.desktopBridge.showNotification({ title, body, ...options });
    }, []);
    const onClick = (0, react_1.useCallback)((callback) => {
        return DesktopBridge_1.desktopBridge.onNotificationClick(callback);
    }, []);
    return { show, onClick };
}
function useWindowControls() {
    const minimize = (0, react_1.useCallback)(() => DesktopBridge_1.desktopBridge.minimize(), []);
    const maximize = (0, react_1.useCallback)(() => DesktopBridge_1.desktopBridge.maximize(), []);
    const close = (0, react_1.useCallback)(() => DesktopBridge_1.desktopBridge.close(), []);
    const toggleFullscreen = (0, react_1.useCallback)(() => DesktopBridge_1.desktopBridge.toggleFullscreen(), []);
    return { minimize, maximize, close, toggleFullscreen };
}
