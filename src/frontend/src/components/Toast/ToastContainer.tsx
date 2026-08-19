import React from 'react';
import { useToast } from '../../contexts/ToastContext';
import './Toast.css';

const ICONS: Record<string, string> = {
  success: 'O',
  error: 'X',
  warning: '!',
  info: 'i',
};

const TYPE_CLASS: Record<string, string> = {
  success: 'toast--success',
  error: 'toast--error',
  warning: 'toast--warning',
  info: 'toast--info',
};

export const ToastContainer: React.FC = () => {
  const { toasts, dismissToast } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container" role="region" aria-live="polite" aria-label="通知">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast ${TYPE_CLASS[toast.type] || 'toast--info'}`}
          onClick={() => dismissToast(toast.id)}
          role="status"
        >
          <span className="toast__icon">{ICONS[toast.type] || 'i'}</span>
          <span className="toast__message">{toast.message}</span>
          <button
            className="toast__close"
            onClick={(e) => {
              e.stopPropagation();
              dismissToast(toast.id);
            }}
            aria-label="关闭通知"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
};

export default ToastContainer;
