"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isElectronEnv = isElectronEnv;
exports.getPlatform = getPlatform;
exports.isMac = isMac;
exports.isWindows = isWindows;
exports.isLinux = isLinux;
exports.isDev = isDev;
exports.isProd = isProd;
function isElectronEnv() {
    return typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined';
}
function getPlatform() {
    if (isElectronEnv()) {
        return window.electronAPI?.platform || 'unknown';
    }
    if (typeof navigator !== 'undefined') {
        return navigator.platform;
    }
    return 'unknown';
}
function isMac() {
    return getPlatform().toLowerCase().includes('mac') || getPlatform().toLowerCase().includes('darwin');
}
function isWindows() {
    return getPlatform().toLowerCase().includes('win');
}
function isLinux() {
    return getPlatform().toLowerCase().includes('linux');
}
function isDev() {
    return process.env.NODE_ENV === 'development';
}
function isProd() {
    return process.env.NODE_ENV === 'production';
}
