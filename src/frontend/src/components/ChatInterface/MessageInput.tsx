import React, { ChangeEvent, KeyboardEvent, useRef, useState } from 'react';
import './ChatInterface.css';
import { SYSTEM_CONSTANTS } from '@shared/contracts';

interface MessageInputProps {
  inputText: string;
  setInputText: (text: string) => void;
  isLoading: boolean;
  onSend: (images?: string[]) => void;
  isTyping: boolean;
  onError?: (message: string) => void;
}

const MessageInput: React.FC<MessageInputProps> = ({ inputText, setInputText, isLoading, onSend, isTyping, onError }) => {
  const [previewImages, setPreviewImages] = useState<string[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
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
      // 检查图片类型
      if (!SYSTEM_CONSTANTS.ALLOWED_IMAGE_TYPES.includes(file.type)) {
        const error = `不支持的图片类型: ${file.type}，仅支持 ${SYSTEM_CONSTANTS.ALLOWED_IMAGE_TYPES.join(', ')}`;
        setImageError(error);
        if (onError) onError(error);
        return;
      }
      // 检查图片大小
      if (file.size > SYSTEM_CONSTANTS.MAX_IMAGE_SIZE_BYTES) {
        const maxMB = (SYSTEM_CONSTANTS.MAX_IMAGE_SIZE_BYTES / (1024 * 1024)).toFixed(1);
        const fileMB = (file.size / (1024 * 1024)).toFixed(1);
        const error = `图片过大: ${fileMB}MB，最大限制 ${maxMB}MB`;
        setImageError(error);
        if (onError) onError(error);
        return;
      }

      const reader = new FileReader();
      reader.onload = (event) => {
        const base64 = event.target?.result as string;
        setPreviewImages((prev) => [...prev, base64]);
        setImageError(null);
      };
      reader.onerror = () => {
        const error = '图片读取失败，请重新选择';
        setImageError(error);
        if (onError) onError(error);
      };
      reader.readAsDataURL(file);
    });

    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeImage = (index: number) => {
    setPreviewImages((prev) => prev.filter((_, i) => i !== index));
    setImageError(null);
  };

  const handleSend = () => {
    const images = previewImages.length > 0 ? [...previewImages] : undefined;
    onSend(images);
    setPreviewImages([]);
    setImageError(null);
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
        : '输入消息... /help 查看命令';

  return (
    <div className="chat-input-area">
      {imageError && (
        <div className="image-error-message" style={{ color: '#ef4444', fontSize: '12px', marginBottom: '8px' }}>
          ⚠️ {imageError}
        </div>
      )}
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
          disabled={false}
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
          disabled={false}
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
