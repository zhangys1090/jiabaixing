# 接口规范文档

## 核心推理引擎接口

### CoreReasoningEngine

#### 初始化与关闭
```typescript
async initialize(): Promise<void>
async shutdown(): Promise<void>
```

#### 核心方法
```typescript
async reason(input: MultimodalInput): Promise<ReasoningResult>
```

#### 输入输出
- **输入**: `MultimodalInput` - 多模态输入对象，包含文本、语音等输入
- **输出**: `ReasoningResult` - 推理结果，包含响应内容和执行状态

## 记忆引擎接口

### MemoryEngine

#### 初始化与关闭
```typescript
async initialize(): Promise<void>
async shutdown(): Promise<void>
```

#### 记忆操作
```typescript
async retrieveTaskMemory(): Promise<MemoryItem[]>
async retrieveEmotionMemory(): Promise<MemoryItem[]>
mergeAndSortMemories(): MemoryItem[]
async updateMemory(memory: MemoryItem): Promise<void>
async updateUserProfile(): Promise<void>
```

#### 数据结构
```typescript
interface MemoryItem {
  id: string;
  type: 'task' | 'emotion' | 'scene' | 'user';
  content: string;
  timestamp: number;
  metadata: Record<string, any>;
}
```

## 交互引擎接口

### InteractionEngine

#### 初始化与关闭
```typescript
async initialize(): Promise<void>
async shutdown(): Promise<void>
```

#### 响应生成
```typescript
async generatePreExecutionResponse(): Promise<string>
async generateResultResponse(result: any, emotion: EmotionTag, scene: SceneTag, memoryContext: MemoryItem[]): Promise<string>
async generateErrorResponse(error: Error): Promise<string>
async generateMaxRetryResponse(): Promise<string>
async outputResponse(text: string, emotion: EmotionTag, scene: SceneTag): Promise<void>
```

## 工具执行器接口

### ToolExecutor

#### 初始化与关闭
```typescript
async initialize(): Promise<void>
async shutdown(): Promise<void>
```

#### 工具执行
```typescript
async execute(toolName: string, params: any): Promise<ToolExecutionResult>
```

#### 数据结构
```typescript
interface ToolExecutionResult {
  success: boolean;
  result: any;
  error: Error | null;
}
```

## 设备管理器接口

### DeviceManager

#### 初始化与关闭
```typescript
async initialize(): Promise<void>
async shutdown(): Promise<void>
```

#### 设备操作
```typescript
async discoverDevices(options?: DiscoveryOptions): Promise<Device[]>
async controlDevice(deviceId: string, command: DeviceCommand): Promise<DeviceControlResult>
async getDeviceStatus(deviceId: string): Promise<DeviceStatus>
```

#### 数据结构
```typescript
interface Device {
  id: string;
  name: string;
  type: DeviceType;
  protocol: ProtocolType;
  status: DeviceStatus;
  properties: Record<string, any>;
}

interface DeviceCommand {
  type: string;
  parameters: Record<string, any>;
}

interface DeviceControlResult {
  success: boolean;
  message: string;
  data?: any;
}
```

## 安全管理器接口

### SecurityManager

#### 初始化与关闭
```typescript
async initialize(): Promise<void>
async shutdown(): Promise<void>
```

#### 安全操作
```typescript
encryptData(data: string): string
decryptData(encryptedData: string): string
generateToken(userId: string): string
verifyToken(token: string): boolean
validateMFA(code: string, userId: string): boolean
```

## 前端接口

### API 端点

#### 推理接口
- **POST /api/reason** - 提交推理请求
- **请求体**: `{ "input": "用户输入" }`
- **响应**: `{ "response": "助手响应", "status": "success" }`

#### 设备接口
- **GET /api/devices** - 获取设备列表
- **POST /api/devices/control** - 控制设备
- **请求体**: `{ "deviceId": "设备ID", "command": { "type": "命令类型", "parameters": {} } }`

#### 工具接口
- **GET /api/tools** - 获取工具列表
- **POST /api/tools/execute** - 执行工具
- **请求体**: `{ "toolName": "工具名称", "parameters": {} }`
