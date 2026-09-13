"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.responsiveClasses = exports.useResponsive = exports.BREAKPOINTS = void 0;
const react_1 = require("react");
const useUIStore_1 = require("../stores/useUIStore");
// 断点配置
exports.BREAKPOINTS = {
    mobile: 768,
    tablet: 1024,
    desktop: 1280,
};
const useResponsive = () => {
    const { setDeviceType } = (0, useUIStore_1.useUIStore)();
    const [deviceType, setDeviceTypeLocal] = (0, react_1.useState)({
        isMobile: false,
        isTablet: false,
        isDesktop: true,
    });
    const checkDeviceType = (0, react_1.useCallback)(() => {
        const width = window.innerWidth;
        const isMobile = width < exports.BREAKPOINTS.mobile;
        const isTablet = width >= exports.BREAKPOINTS.mobile && width < exports.BREAKPOINTS.desktop;
        const isDesktop = width >= exports.BREAKPOINTS.desktop;
        return { isMobile, isTablet, isDesktop };
    }, []);
    (0, react_1.useEffect)(() => {
        // 初始检查
        const initialDeviceType = checkDeviceType();
        setDeviceTypeLocal(initialDeviceType);
        setDeviceType(initialDeviceType.isMobile, initialDeviceType.isTablet, initialDeviceType.isDesktop);
        // 监听窗口大小变化
        let resizeTimer;
        const handleResize = () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                const newDeviceType = checkDeviceType();
                setDeviceTypeLocal(newDeviceType);
                setDeviceType(newDeviceType.isMobile, newDeviceType.isTablet, newDeviceType.isDesktop);
            }, 100);
        };
        window.addEventListener('resize', handleResize);
        return () => {
            window.removeEventListener('resize', handleResize);
            clearTimeout(resizeTimer);
        };
    }, [checkDeviceType, setDeviceType]);
    return deviceType;
};
exports.useResponsive = useResponsive;
// 响应式CSS工具类
exports.responsiveClasses = {
    hideMobile: 'hidden md:block',
    hideTablet: 'hidden lg:block',
    hideDesktop: 'block md:hidden',
    fullWidthMobile: 'w-full md:w-auto',
};
