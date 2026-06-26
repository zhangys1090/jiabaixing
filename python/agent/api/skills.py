from fastapi import APIRouter
from typing import Any

from agent.models.skill import SkillExecuteRequest, SkillExecuteResponse, SkillMeta
from agent.skills.registry import SkillRegistry

router = APIRouter()


def _get_registry() -> SkillRegistry:
    return SkillRegistry.get_instance()


@router.get("", response_model=list[SkillMeta])
async def list_skills(category: str | None = None, query: str | None = None):
    registry = _get_registry()
    if not registry.get_all_skills():
        registry.register_builtin_skills()

    if query:
        skills = registry.search_skills(query)
    elif category:
        skills = registry.get_skills_by_category(category)
    else:
        skills = registry.get_all_skills()

    return [
        SkillMeta(
            name=s.definition.name,
            description=s.definition.description,
            category=s.definition.category,
        )
        for s in skills
    ]


@router.post("/execute", response_model=SkillExecuteResponse)
async def execute_skill(req: SkillExecuteRequest):
    registry = _get_registry()
    skill = registry.get_skill(req.name)
    if not skill:
        return SkillExecuteResponse(success=False, error=f"Skill '{req.name}' not found")

    result = await skill.execute(req.parameters or {})
    return SkillExecuteResponse(
        success=result.success,
        result=result.output,
        error=result.error,
    )
