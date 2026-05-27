import './MainLayout.css';

export const MainLayoutContainer: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  children,
  className,
  ...rest
}) => (
  <div className={`layout-main${className ? ` ${className}` : ''}`} {...rest}>
    {children}
  </div>
);

export const CenterPanel: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ children, className, ...rest }) => (
  <div className={`layout-main__center-panel${className ? ` ${className}` : ''}`} {...rest}>
    {children}
  </div>
);
