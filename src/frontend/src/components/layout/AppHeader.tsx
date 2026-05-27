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
}

export const ConnectionBadge: React.FC<ConnectionBadgeProps> = ({ $connected, children, className, ...rest }) => (
  <div
    className={`layout-header__connection-badge${!$connected ? ' layout-header__connection-badge--disconnected' : ''}${className ? ` ${className}` : ''}`}
    {...rest}
  >
    {children}
  </div>
);

export const HeaderSpacer: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className, ...rest }) => (
  <div className={`layout-header__spacer${className ? ` ${className}` : ''}`} {...rest} />
);

export const ThemeToggle: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({ className, ...rest }) => (
  <button className={`layout-header__icon-btn${className ? ` ${className}` : ''}`} {...rest} />
);

export const SettingsButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({ className, ...rest }) => (
  <button className={`layout-header__icon-btn${className ? ` ${className}` : ''}`} {...rest} />
);
