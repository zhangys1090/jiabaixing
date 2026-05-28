import './AppHeader.css';

interface AppHeaderContainerProps extends React.HTMLAttributes<HTMLElement> {
  children: React.ReactNode;
}

export const AppHeaderContainer: React.FC<AppHeaderContainerProps> = ({ children, className, ...rest }) => (
  <header className={`layout-header${className ? ` ${className}` : ''}`} {...rest}>
    {children}
  </header>
);

export const BrandMark: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ children, className, ...rest }) => (
  <div className={`layout-header__brand-mark${className ? ` ${className}` : ''}`} {...rest}>
    {children}
  </div>
);

interface ConnectionBadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  $connected: boolean;
  $status?: string;
}

const STATUS_LABELS: Record<string, string> = {
  connected: '已连接',
  connecting: '连接中...',
  reconnecting: '重连中...',
  disconnected: '未连接',
};

export const ConnectionBadge: React.FC<ConnectionBadgeProps> = ({
  $connected,
  $status = 'disconnected',
  children,
  className,
  ...rest
}) => {
  const label = children ?? STATUS_LABELS[$status] ?? '未连接';
  const statusClass = `layout-header__connection-badge--${$status}`;
  return (
    <div
      className={`layout-header__connection-badge${!$connected ? ' layout-header__connection-badge--disconnected' : ''} ${statusClass}${className ? ` ${className}` : ''}`}
      title={`WebSocket: ${$status}`}
      {...rest}
    >
      {label}
    </div>
  );
};

export const HeaderSpacer: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className, ...rest }) => (
  <div className={`layout-header__spacer${className ? ` ${className}` : ''}`} {...rest} />
);

export const ThemeToggle: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({ className, ...rest }) => (
  <button className={`layout-header__icon-btn${className ? ` ${className}` : ''}`} {...rest} />
);

export const SettingsButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({ className, ...rest }) => (
  <button className={`layout-header__icon-btn${className ? ` ${className}` : ''}`} {...rest} />
);

export const ReconnectButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({ className, ...rest }) => (
  <button className={`layout-header__reconnect-btn${className ? ` ${className}` : ''}`} {...rest} />
);
