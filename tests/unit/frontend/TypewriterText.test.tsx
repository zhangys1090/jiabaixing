/**
 * 前端组件测试：TypewriterText 打字机效果
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import TypewriterText from '../../../src/frontend/src/components/TypewriterText/TypewriterText';

describe('TypewriterText 组件测试', () => {
  test('TC1: 初始状态显示为空', () => {
    render(<TypewriterText text="你好世界" messageId="test_1" />);

    const element = screen.getByText('');
    expect(element).toBeInTheDocument();
  });

  test('TC2: 打字完成后显示完整文本', async () => {
    render(<TypewriterText text="你好" messageId="test_2" speed={10} />);

    // 等待打字完成（2个字符 * 10ms + 缓冲）
    await waitFor(
      () => {
        expect(screen.getByText('你好')).toBeInTheDocument();
      },
      { timeout: 1000 }
    );
  });

  test('TC3: 点击跳过显示全部', async () => {
    const onSkip = jest.fn();
    render(
      <TypewriterText
        text="这是一段很长的文本"
        messageId="test_3"
        speed={100}
        onSkip={onSkip}
      />
    );

    // 点击元素
    const element = screen.getByTitle('点击显示全部');
    fireEvent.click(element);

    // 验证 onSkip 被调用
    await waitFor(() => {
      expect(onSkip).toHaveBeenCalledWith('test_3');
    });
  });

  test('TC4: 打字完成回调', async () => {
    const onComplete = jest.fn();
    render(
      <TypewriterText
        text="测试"
        messageId="test_4"
        speed={10}
        onComplete={onComplete}
      />
    );

    // 等待打字完成
    await waitFor(
      () => {
        expect(onComplete).toHaveBeenCalled();
      },
      { timeout: 1000 }
    );
  });

  test('TC5: 空文本直接完成', async () => {
    const onComplete = jest.fn();
    render(
      <TypewriterText
        text=""
        messageId="test_5"
        onComplete={onComplete}
      />
    );

    // 空文本应该立即调用 onComplete
    await waitFor(() => {
      expect(onComplete).toHaveBeenCalled();
    });
  });

  test('TC6: 光标在打字过程中显示', async () => {
    render(
      <TypewriterText
        text="测试中"
        messageId="test_6"
        speed={100}
      />
    );

    // 检查光标元素存在
    const cursor = document.querySelector('.typewriter-cursor');
    expect(cursor).toBeInTheDocument();
  });
});
