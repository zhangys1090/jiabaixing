import { useEffect, useCallback } from 'react';
import { useUIStore } from '../stores/useUIStore';

// 断点配置
export const BREAKPOINTS = {
  mobile: 768,
  tablet: 1024,
  desktop: 1280,
};

export const useResponsive = () => {
  const { setDeviceType } = useUIStore();

  const checkDeviceType = useCallback(() => {
    const width = window.innerWidth;

    const isMobile = width < BREAKPOINTS.mobile;
    const isTablet = width >= BREAKPOINTS.mobile && width < BREAKPOINTS.desktop;
    const isDesktop = width >= BREAKPOINTS.desktop;

    setDeviceType(isMobile, isTablet, isDesktop);

    return { isMobile, isTablet, isDesktop };
  }, [setDeviceType]);

  useEffect(() => {
    // 初始检查
    checkDeviceType();

    // 监听窗口大小变化
    let resizeTimer: NodeJS.Timeout;
    const handleResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        checkDeviceType();
      }, 100);
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(resizeTimer);
    };
  }, [checkDeviceType]);

  return checkDeviceType();
};

// 响应式CSS工具类
export const responsiveClasses = {
  hideMobile: 'hidden md:block',
  hideTablet: 'hidden lg:block',
  hideDesktop: 'block md:hidden',
  fullWidthMobile: 'w-full md:w-auto',
};
