/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import App from './App';

// 模拟 fetch 函数
global.fetch = jest.fn();

// 模拟 errorMonitor
jest.mock('./utils/errorMonitoring', () => ({
  errorMonitor: {
    initialize: jest.fn(),
    reportNetworkError: jest.fn(),
    reportCustomError: jest.fn(),
  },
}));

describe('App', () => {
  beforeEach(() => {
    // 清除所有模拟
    jest.clearAllMocks();
  });

  test('renders App component', () => {
    render(<App />);
    const appElement = screen.getByText(/jiabaixing 智能助手/i);
    expect(appElement).toBeInTheDocument();
  });

  test('should send message when input is submitted', async () => {
    // 模拟 fetch 成功
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValueOnce({ response: 'Hello, world!' }),
    });

    render(<App />);

    // 输入消息
    const inputElement = screen.getByPlaceholderText(/请输入您的问题或需求.../i);
    fireEvent.change(inputElement, { target: { value: 'Hello' } });

    // 发送消息
    const sendButton = screen.getByText(/发送/i);
    fireEvent.click(sendButton);

    // 验证 fetch 是否被调用
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        'http://test-api.jiabaixing.com/api/process',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ input: 'Hello' }),
        })
      );
    });

    // 验证回复是否显示
    await waitFor(() => {
      const replyElement = screen.getByText(/Hello, world!/i);
      expect(replyElement).toBeInTheDocument();
    });
  });

  test('should handle network error', async () => {
    // 模拟 fetch 失败
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

    render(<App />);

    // 输入消息
    const inputElement = screen.getByPlaceholderText(/请输入您的问题或需求.../i);
    fireEvent.change(inputElement, { target: { value: 'Hello' } });

    // 发送消息
    const sendButton = screen.getByText(/发送/i);
    fireEvent.click(sendButton);

    // 验证错误消息是否显示
    await waitFor(() => {
      const errorMessage = screen.getByText(/抱歉，网络连接失败，请稍后再试。/i);
      expect(errorMessage).toBeInTheDocument();
    });
  });

  test('should switch between modules', () => {
    render(<App />);

    // 点击开发辅助模块
    const developmentModule = screen.getByText(/开发辅助/i);
    fireEvent.click(developmentModule);

    // 验证开发辅助模块是否显示
    const developmentTitle = screen.getByText(/开发辅助/i);
    expect(developmentTitle).toBeInTheDocument();

    // 点击智能助理模块
    const housekeeperModule = screen.getByText(/智能助理/i);
    fireEvent.click(housekeeperModule);

    // 验证智能助理模块是否显示
    const housekeeperTitle = screen.getByText(/智能助理/i);
    expect(housekeeperTitle).toBeInTheDocument();
  });
});
