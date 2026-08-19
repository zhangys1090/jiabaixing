import { getActivePythonBridge } from '../../../src/ide/bridgeRegistry';
const fakeBridge: any = { llmChat: jest.fn(), llmChatWithTools: jest.fn(), llmGetModelName: jest.fn() };
jest.mock('../../../src/ide/bridgeRegistry', () => ({ getActivePythonBridge: () => fakeBridge }));
import { MultiModelLLMProviderBridge } from '../../../src/models/MultiModelLLMProviderBridge';
import { PythonBackedModel } from '../../../src/models/PythonBackedModel';
it('dbg', async () => {
  const bridge = MultiModelLLMProviderBridge.getInstance();
  await bridge.initialize();
  process.stdout.write('DBG_INIT_SIZE=' + (bridge as any).models.size + '\n');
  await bridge.registerModel('test','test-model',{name:'test-model',baseUrl:'b',apiKey:'k'} as any,{visionScore:1,codingScore:1,reasoningScore:1,speedScore:1,contextLength:1,features:[]} as any,10);
  process.stdout.write('DBG_REG_SIZE=' + (bridge as any).models.size + '\n');
  process.stdout.write('DBG_FIRST_PY=' + ((bridge as any).listModels()[0]?.model instanceof PythonBackedModel) + '\n');
});
