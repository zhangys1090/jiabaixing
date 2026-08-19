import {
  ContextReferenceResolver,
  MultimodalReference,
  MultimodalReferenceProvider,
} from './ContextReferenceResolver';

/** 模拟 Python 端 PerceptionReferenceResolver 的 provider */
function mockProvider(
  resolved: Record<string, Partial<MultimodalReference>>
): MultimodalReferenceProvider {
  return async (tokens: string[]) => {
    const out: MultimodalReference[] = [];
    for (const t of tokens) {
      const r = resolved[t];
      if (!r) continue; // 无法解析的 token 交由上层保留在文本
      out.push({
        token: '@' + t,
        kind: r.kind ?? 'named',
        modality: (r.modality ?? null) as MultimodalReference['modality'],
        content: r.content ?? '',
        confidence: r.confidence ?? 1,
        sourceIndex: r.sourceIndex ?? -1,
      });
    }
    return out;
  };
}

describe('ContextReferenceResolver 多模态 @引用 (U4)', () => {
  describe('collectMultimodalTokens', () => {
    it('提取 CJK 具名类型与 #索引样本', () => {
      const toks = ContextReferenceResolver.collectMultimodalTokens(
        '参考 @截图区域 和 @visual#0 以及 @设备状态 再决定'
      );
      expect(toks).toContain('截图区域');
      expect(toks).toContain('visual#0');
      expect(toks).toContain('设备状态');
      expect(toks).toHaveLength(3);
    });

    it('识别拉丁通道名但不劫持普通 @配置/@文件', () => {
      const toks = ContextReferenceResolver.collectMultimodalTokens(
        '@visual @audio @config @server.ts'
      );
      expect(toks).toContain('visual');
      expect(toks).toContain('audio');
      expect(toks).not.toContain('config');
      expect(toks).not.toContain('server.ts');
    });

    it('不误伤 URL 中的 https', () => {
      const toks = ContextReferenceResolver.collectMultimodalTokens(
        '见 @https://example.com 文档'
      );
      expect(toks).not.toContain('https');
    });
  });

  describe('resolve 多模态引用', () => {
    it('有 provider 时解析并替换文本为 [ref#N] 标记', async () => {
      const resolver = new ContextReferenceResolver({ projectRoot: '/tmp' });
      resolver.setMultimodalReferenceProvider(
        mockProvider({
          截图区域: { modality: 'visual', content: '按钮[提交]在(120,340)', confidence: 0.92 },
          设备状态: { modality: 'environment', content: '设备A在线', confidence: 0.99 },
        })
      );
      const res = await resolver.resolve('点击 @截图区域 时检查 @设备状态');
      expect(res.hasReferences).toBe(true);
      expect(res.multimodalReferences).toHaveLength(2);
      expect(res.cleanedInput).toContain('[ref#1]');
      expect(res.cleanedInput).toContain('[ref#2]');
      expect(res.cleanedInput).not.toContain('@截图区域');
      expect(res.resolvedContent).toContain('按钮[提交]在(120,340)');
      expect(res.resolvedContent).toContain('设备A在线');
    });

    it('无 provider 时多模态引用原样保留（降级）', async () => {
      const resolver = new ContextReferenceResolver({ projectRoot: '/tmp' });
      const res = await resolver.resolve('点击 @截图区域 然后执行');
      expect(res.multimodalReferences).toBeDefined();
      expect(res.multimodalReferences).toHaveLength(0);
      expect(res.cleanedInput).toContain('@截图区域');
    });

    it('provider 无法解析的 token 保留在文本', async () => {
      const resolver = new ContextReferenceResolver({ projectRoot: '/tmp' });
      resolver.setMultimodalReferenceProvider(
        mockProvider({ 截图区域: { modality: 'visual', content: '截图像素', confidence: 0.9 } })
      );
      const res = await resolver.resolve('关注 @未知通道 与 @截图区域');
      expect(res.multimodalReferences).toHaveLength(1); // 仅截图区域被解析
      expect(res.cleanedInput).toContain('@未知通道');
      expect(res.cleanedInput).not.toContain('@截图区域');
    });

    it('文件/URL 引用与多模态引用可共存', async () => {
      const resolver = new ContextReferenceResolver({ projectRoot: '/tmp' });
      resolver.setMultimodalReferenceProvider(
        mockProvider({ 截图区域: { modality: 'visual', content: '截图像素', confidence: 0.9 } })
      );
      const res = await resolver.resolve(
        '读取 @https://example.com 并参考 @截图区域'
      );
      // 文件/URL 引用
      const urlRef = res.references.find((r) => r.type === 'url');
      expect(urlRef).toBeDefined();
      // 多模态引用
      expect(res.multimodalReferences).toHaveLength(1);
      expect(res.cleanedInput).toContain('[ref#');
    });
  });
});
