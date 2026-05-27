/**
 * screenshot-desktop 类型声明
 */

declare module 'screenshot-desktop' {
  interface Display {
    id: number;
    name: string;
  }

  interface ScreenshotOptions {
    format?: string;
    screen?: number;
  }

  interface ScreenshotModule {
    (options?: ScreenshotOptions): Promise<Buffer>;
    listDisplays(): Promise<Display[]>;
  }

  const screenshot: ScreenshotModule;
  export = screenshot;
}
