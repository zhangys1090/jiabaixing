"""上下文组件适配器包

将现有的上下文组件适配到统一编排器的组件接口。
"""

from agent.context.adapters.system_prompt import SystemPromptComponent
from agent.context.adapters.persona import PersonaComponent
from agent.context.adapters.memory_retrieval import MemoryRetrievalComponent
from agent.context.adapters.file_context import FileContextComponent
from agent.context.adapters.token_budget import TokenBudgetComponent
from agent.context.adapters.context_assembler import ContextAssemblerComponent
from agent.context.adapters.attention_focus import AttentionFocusComponent

__all__ = [
    "SystemPromptComponent",
    "PersonaComponent",
    "MemoryRetrievalComponent",
    "FileContextComponent",
    "TokenBudgetComponent",
    "ContextAssemblerComponent",
    "AttentionFocusComponent",
]
