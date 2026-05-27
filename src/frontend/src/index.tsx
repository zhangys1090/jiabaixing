import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';
import { errorMonitor } from './utils/errorMonitoring';
import * as Sentry from '@sentry/react';
import { BrowserTracing } from '@sentry/tracing';

if (process.env.REACT_APP_ENV === 'production' && process.env.REACT_APP_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.REACT_APP_SENTRY_DSN,
    // @ts-expect-error Sentry BrowserTracing type compatibility issue
    integrations: [new BrowserTracing()],
    tracesSampleRate: 1.0,
    environment: process.env.REACT_APP_ENV || 'development',
    release: process.env.REACT_APP_RELEASE,
  });
}

// 初始化错误监控系统
errorMonitor.initialize();

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
