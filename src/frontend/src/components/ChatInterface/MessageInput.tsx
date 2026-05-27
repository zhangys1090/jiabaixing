import React, { ChangeEvent, KeyboardEvent, useRef, useState } from 'react';
import './ChatInterface.css';

interface MessageInputProps {
  inputText: string;
  setInputText: (text: string) => void;
  isLoading: boolean;
  onSend: (images?: string[]) => void;
  isTyping: boolean;
}

const MessageInput: React.FC<MessageInputProps> = ({ inputText, setInputText, isLoading, onSend, isTyping }) => {
  const [previewImages, setPreviewImages] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleImageSelect = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    Array.from(files).forEach((file) => {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (event) => {
          const base64 = event.target?.result as string;
          setPreviewImages((prev) => [...prev, base64]);
        };
        reader.readAsDataURL(file);
      }
    });

    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeImage = (index: number) => {
    setPreviewImages((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSend = () => {
    const images = previewImages.length > 0 ? [...previewImages] : undefined;
    onSend(images);
    setPreviewImages([]);
    setInputText('');
    setTimeout(() => {
      textareaRef.current?.focus();
    }, 0);
  };

  const handleTextareaInput = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setInputText(e.target.value);
    autoResizeTextarea(e.target);
  };

  const autoResizeTextarea = (element: HTMLTextAreaElement): void => {
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 120)}px`;
  };

  const hasContent = inputText.trim().length > 0 || previewImages.length > 0;

  const placeholder = isLoading
    ? 'jiabaixing 正在思考...'
    : isTyping
      ? '对方正在输入...'
      : previewImages.length > 0
        ? `已选择 ${previewImages.length} 张图片，输入问题后发送...`
        : '输入消息... Enter 发送，Shift+Enter 换行';

  return (
    <div className="chat-input-area">
      {previewImages.length > 0 && (
        <div className="image-preview-container">
          {previewImages.map((img, index) => (
            <div key={index} className="image-preview-item">
              <img src={img} alt={`预览 ${index + 1}`} />
              <button className="image-remove-btn" onClick={() => removeImage(index)} aria-label="移除图片">
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="chat-input-row">
        <input
          type="file"
          ref={fileInputRef}
          accept="image/*"
          multiple
          onChange={handleImageSelect}
          className="hidden-file-input"
          aria-label="选择图片"
        />
        <button
          className="attach-button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isLoading}
          aria-label="添加图片"
          title="添加图片（支持多模态分析）"
        >
          🖼️
        </button>
        <textarea
          ref={textareaRef}
          value={inputText}
          onChange={handleTextareaInput}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="chat-input chat-textarea"
          disabled={isLoading}
          rows={1}
        />
        <button
          onClick={handleSend}
          className={`send-button ${hasContent && !isLoading ? 'active' : ''} ${isLoading ? 'loading' : ''}`}
          disabled={isLoading || !hasContent}
          aria-label={isLoading ? '发送中' : '发送'}
        >
          {isLoading ? (
            <div className="loading-spinner">
              <span className="spinner-icon" role="img" aria-label="loading">
                ⏳
              </span>
            </div>
          ) : (
            <span className="send-icon">发送</span>
          )}
        </button>
      </div>
    </div>
  );
};

export default MessageInput;
