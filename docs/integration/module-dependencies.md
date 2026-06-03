# 模块依赖关系图

## 核心模块依赖关系

```mermaid
graph TD
    subgraph 核心层
        CoreReasoningEngine[核心推理引擎] --> DAGTask[DAG任务编排]
        CoreReasoningEngine --> InteractionEngine[交互引擎]
        CoreReasoningEngine --> MemoryEngine[记忆引擎]
        CoreReasoningEngine --> ToolExecutor[工具执行器]
        CoreReasoningEngine --> EmotionAnalyzer[情感分析器]
        CoreReasoningEngine --> SceneRecognizer[场景识别器]
    end

    subgraph 交互层
        InteractionEngine --> SpeechSynthesizer[语音合成器]
        InteractionEngine --> EmojiManager[表情管理器]
    end

    subgraph 工具层
        ToolExecutor --> ToolManager[工具管理器]
    end

    subgraph 硬件层
        DeviceManager[设备管理器] --> DeviceTypes[设备类型库]
    end

    subgraph 安全层
        SecurityManager[安全管理器]
    end

    subgraph 前端层
        Frontend[前端应用] --> App[主应用组件]
        App --> ChatInterface[聊天界面]
        App --> DeviceInterface[设备控制界面]
        App --> ToolInterface[工具推荐界面]
    end

    CoreReasoningEngine --> Frontend
    DeviceManager --> CoreReasoningEngine
    SecurityManager --> CoreReasoningEngine
```

## 详细依赖关系

### 核心推理引擎 (CoreReasoningEngine)
- **依赖**: 记忆引擎、交互引擎、工具执行器、情感分析器、场景识别器
- **被依赖**: 前端应用

### 记忆引擎 (MemoryEngine)
- **依赖**: 无
- **被依赖**: 核心推理引擎

### 交互引擎 (InteractionEngine)
- **依赖**: 语音合成器、表情管理器
- **被依赖**: 核心推理引擎

### 工具执行器 (ToolExecutor)
- **依赖**: 工具管理器
- **被依赖**: 核心推理引擎

### 设备管理器 (DeviceManager)
- **依赖**: 设备类型库
- **被依赖**: 核心推理引擎

### 安全管理器 (SecurityManager)
- **依赖**: 无
- **被依赖**: 核心推理引擎

### 前端应用 (Frontend)
- **依赖**: 核心推理引擎
- **被依赖**: 无
