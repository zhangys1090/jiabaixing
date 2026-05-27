import React, { useState, useEffect } from 'react';

interface AnimatedTransitionProps {
  show: boolean;
  animation?: 'fade' | 'slide-right' | 'slide-left' | 'slide-up' | 'scale';
  duration?: number;
  children: React.ReactNode;
  className?: string;
  onExited?: () => void;
}

export const AnimatedTransition: React.FC<AnimatedTransitionProps> = ({
  show,
  animation = 'fade',
  duration = 300,
  children,
  className = '',
  onExited,
}) => {
  const [shouldRender, setShouldRender] = useState(show);
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => {
    if (show) {
      setShouldRender(true);
      setIsAnimating(true);
      const timer = setTimeout(() => setIsAnimating(false), duration);
      return () => clearTimeout(timer);
    } else if (shouldRender) {
      setIsAnimating(true);
      const timer = setTimeout(() => {
        setShouldRender(false);
        setIsAnimating(false);
        onExited?.();
      }, duration);
      return () => clearTimeout(timer);
    }
  }, [show, shouldRender, duration, onExited]);

  if (!shouldRender && !isAnimating) {
    return null;
  }

  const getAnimationClass = () => {
    if (!show && isAnimating) {
      switch (animation) {
        case 'fade':
          return 'fade-out';
        case 'slide-right':
          return 'slide-out-right';
        case 'slide-left':
          return 'slide-out-left';
        case 'scale':
          return 'scale-out';
        default:
          return 'fade-out';
      }
    }
    if (show && isAnimating) {
      switch (animation) {
        case 'fade':
          return 'fade-in';
        case 'slide-right':
          return 'slide-in-right';
        case 'slide-left':
          return 'slide-in-left';
        case 'slide-up':
          return 'slide-in-up';
        case 'scale':
          return 'scale-in';
        default:
          return 'fade-in';
      }
    }
    return '';
  };

  return (
    <div
      className={`${getAnimationClass()} ${className}`}
      style={{
        animationDuration: `${duration}ms`,
      }}
    >
      {children}
    </div>
  );
};

// 面板动画组件
export const AnimatedPanel: React.FC<{
  isOpen: boolean;
  position?: 'left' | 'right';
  children: React.ReactNode;
  className?: string;
}> = ({ isOpen, position = 'right', children, className = '' }) => {
  return (
    <AnimatedTransition
      show={isOpen}
      animation={position === 'right' ? 'slide-right' : 'slide-left'}
      className={className}
    >
      {children}
    </AnimatedTransition>
  );
};

// 模态框动画组件
export const AnimatedModal: React.FC<{
  isOpen: boolean;
  children: React.ReactNode;
  className?: string;
  onClose?: () => void;
}> = ({ isOpen, children, className = '', onClose }) => {
  return (
    <AnimatedTransition show={isOpen} animation="scale" className={className}>
      {children}
    </AnimatedTransition>
  );
};
