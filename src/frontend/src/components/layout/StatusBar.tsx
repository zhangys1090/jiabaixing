import './StatusBar.css';

interface StatusBarContainerProps extends React.HTMLAttributes<HTMLElement> {
  children: React.ReactNode;
}

export const StatusBarContainer: React.FC<StatusBarContainerProps> = ({ children, className, ...rest }) => (
  <footer className={`layout-status-bar${className ? ` ${className}` : ''}`} {...rest}>
    {children}
  </footer>
);

export const StatusItem: React.FC<React.HTMLAttributes<HTMLSpanElement>> = ({ children, className, ...rest }) => (
  <span className={`layout-status-bar__item${className ? ` ${className}` : ''}`} {...rest}>
    {children}
  </span>
);

interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  $color: string;
}

export const StatusDot: React.FC<StatusDotProps> = ({ $color, className, style, ...rest }) => (
  <span
    className={`layout-status-bar__dot${className ? ` ${className}` : ''}`}
    style={{ ...style, background: $color }}
    {...rest}
  />
);

export const StatusSeparator: React.FC<React.HTMLAttributes<HTMLSpanElement>> = ({ className, ...rest }) => (
  <span className={`layout-status-bar__separator${className ? ` ${className}` : ''}`} {...rest} />
);
