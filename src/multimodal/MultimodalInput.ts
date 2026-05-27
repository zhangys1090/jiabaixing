/**
 * 多模态输入类
 * 统一处理文本、语音、视觉等多模态输入数据
 */

export interface InputSource {
  type: 'text' | 'voice' | 'image' | 'video' | 'sensor';
  data: unknown;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export class MultimodalInput {
  private sources: InputSource[] = [];
  private timestamp: Date;
  private isAudioTranscribed: boolean = false;

  constructor(input: string | InputSource | InputSource[]) {
    this.timestamp = new Date();

    // 根据输入类型初始化
    if (typeof input === 'string') {
      // 文本输入
      this.addText(input);
    } else if (Array.isArray(input)) {
      // 多个输入源
      this.sources.push(...input);
    } else {
      // 单个输入源
      this.sources.push(input);
    }
  }

  /**
   * 添加文本输入
   */
  public addText(text: string, metadata?: Record<string, unknown>): void {
    this.sources.push({
      type: 'text',
      data: text,
      timestamp: new Date(),
      metadata,
    });
  }

  /**
   * 添加语音输入
   */
  public addVoice(audioData: Buffer, metadata?: Record<string, unknown>): void {
    this.sources.push({
      type: 'voice',
      data: audioData,
      timestamp: new Date(),
      metadata,
    });
  }

  /**
   * 添加图像输入
   */
  public addImage(
    imageData: Buffer | string,
    metadata?: Record<string, unknown>
  ): void {
    this.sources.push({
      type: 'image',
      data: imageData,
      timestamp: new Date(),
      metadata,
    });
  }

  /**
   * 添加视频输入
   */
  public addVideo(
    videoData: Buffer | string,
    metadata?: Record<string, unknown>
  ): void {
    this.sources.push({
      type: 'video',
      data: videoData,
      timestamp: new Date(),
      metadata,
    });
  }

  /**
   * 添加传感器输入
   */
  public addSensor(
    sensorData: unknown,
    metadata?: Record<string, unknown>
  ): void {
    this.sources.push({
      type: 'sensor',
      data: sensorData,
      timestamp: new Date(),
      metadata,
    });
  }

  /**
   * 获取所有输入源
   */
  public getSources(): InputSource[] {
    return [...this.sources];
  }

  /**
   * 根据类型获取输入源
   */
  public getSourcesByType(type: InputSource['type']): InputSource[] {
    return this.sources.filter((source) => source.type === type);
  }

  /**
   * 获取文本输入
   */
  public getText(): string {
    const textSources = this.getSourcesByType('text');
    if (textSources.length === 0) {
      return '';
    }
    // 返回最新的文本输入
    return textSources.sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime()
    )[0].data as string;
  }

  /**
   * 获取语音输入
   */
  public getVoice(): Buffer | undefined {
    const voiceSources = this.getSourcesByType('voice');
    if (voiceSources.length === 0) {
      return undefined;
    }
    // 返回最新的语音输入
    return voiceSources.sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime()
    )[0].data as Buffer;
  }

  /**
   * 获取图像输入
   */
  public getImage(): Buffer | string | undefined {
    const imageSources = this.getSourcesByType('image');
    if (imageSources.length === 0) {
      return undefined;
    }
    // 返回最新的图像输入
    return imageSources.sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime()
    )[0].data as Buffer | string;
  }

  /**
   * 获取视频输入
   */
  public getVideo(): Buffer | string | undefined {
    const videoSources = this.getSourcesByType('video');
    if (videoSources.length === 0) {
      return undefined;
    }
    // 返回最新的视频输入
    return videoSources.sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime()
    )[0].data as Buffer | string;
  }

  /**
   * 获取传感器输入
   */
  public getSensor(): unknown | undefined {
    const sensorSources = this.getSourcesByType('sensor');
    if (sensorSources.length === 0) {
      return undefined;
    }
    // 返回最新的传感器输入
    return sensorSources.sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime()
    )[0].data;
  }

  /**
   * 获取输入的时间戳
   */
  public getTimestamp(): Date {
    return this.timestamp;
  }

  /**
   * 检查是否包含特定类型的输入
   */
  public hasType(type: InputSource['type']): boolean {
    return this.sources.some((source) => source.type === type);
  }

  /**
   * 获取输入源的数量
   */
  public getSourceCount(): number {
    return this.sources.length;
  }

  /**
   * 合并另一个多模态输入
   */
  public merge(other: MultimodalInput): void {
    this.sources.push(...other.getSources());
  }

  /**
   * 转换为JSON格式
   */
  public toJSON(): unknown {
    return {
      timestamp: this.timestamp.toISOString(),
      sources: this.sources.map((source) => ({
        ...source,
        timestamp: source.timestamp.toISOString(),
      })),
    };
  }

  /**
   * 从JSON格式创建多模态输入
   */
  public static fromJSON(json: unknown): MultimodalInput {
    const jsonData = json as {
      timestamp: string;
      sources: Array<{
        type: InputSource['type'];
        data: unknown;
        timestamp: string;
        metadata?: Record<string, unknown>;
      }>;
    };
    const input = new MultimodalInput([]);
    input.timestamp = new Date(jsonData.timestamp);
    input.sources = jsonData.sources.map((source) => ({
      ...source,
      timestamp: new Date(source.timestamp),
    }));
    return input;
  }

  /**
   * 标记音频已转录
   */
  public markAudioTranscribed(): void {
    this.isAudioTranscribed = true;
  }

  /**
   * 检查音频是否已转录
   */
  public getIsAudioTranscribed(): boolean {
    return this.isAudioTranscribed;
  }

  /**
   * 重置音频转录状态
   */
  public resetAudioTranscribed(): void {
    this.isAudioTranscribed = false;
  }
}
