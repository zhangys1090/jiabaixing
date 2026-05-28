import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';

export const SKILL_CREATE_DEF: ToolDefinition = {
  name: 'skill_create',
  description:
    '用户自定义技能管理工具。支持创建、查看、执行、删除和更新技能模板。适用场景：创建可复用的prompt模板、管理自定义技能。不适用：系统内置工具管理。',
  category: ToolCategory.NETWORK,
  parameters: {
    action: {
      type: 'string',
      description: '操作类型',
      enum: ['create', 'list', 'execute', 'delete', 'update'],
    },
    skill_name: {
      type: 'string',
      description: '技能名称（英文，如 format_json）',
    },
    description: {
      type: 'string',
      description: '技能描述',
    },
    template: {
      type: 'string',
      description: '技能模板（prompt模板，支持 {{variable}} 占位符）',
    },
    variables: {
      type: 'object',
      description:
        '变量默认值 { name: { description: string, default: string } }',
      properties: {
        description: { type: 'string', description: '变量描述' },
        default: { type: 'string', description: '默认值' },
      },
    },
    params: {
      type: 'object',
      description: '执行时传入的变量值（execute action时使用）',
      properties: {
        value: { type: 'string', description: '变量值' },
      },
    },
  },
  requiredParams: ['action'],
  requiredPermissions: [Permission.CODE_EXECUTE],
  riskLevel: 'medium',
  idempotent: false,
  timeout: 20000,
};

interface UserSkill {
  name: string;
  description: string;
  template: string;
  variables: Record<string, { description: string; default: string }>;
  createdAt: number;
  updatedAt: number;
  usageCount: number;
}

export interface SkillCreateDeps {
  skillStore: {
    getSkills(): Promise<UserSkill[]>;
    saveSkill(skill: UserSkill): Promise<void>;
    deleteSkill(name: string): Promise<void>;
  };
  llm?: {
    chat(
      prompt: string,
      history: unknown[],
      systemPrompt?: string
    ): Promise<string>;
  };
}

const SKILL_NAME_REGEX = /^[a-zA-Z0-9_]+$/;

function renderTemplate(
  template: string,
  variables: Record<string, { description: string; default: string }>,
  params: Record<string, unknown>
): string {
  let rendered = template;
  for (const [key, varDef] of Object.entries(variables)) {
    const value = params[key] != null ? String(params[key]) : varDef.default;
    rendered = rendered.replaceAll(`{{${key}}}`, value);
  }
  return rendered;
}

export function createSkillCreateExecutor(deps: SkillCreateDeps) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const action = String(params.action || '');

    try {
      switch (action) {
        case 'create': {
          const skillName = String(params.skill_name || '');
          if (!skillName) {
            return {
              success: false,
              output: null,
              error: '技能名称不能为空',
              duration: 0,
              validated: false,
            };
          }
          if (!SKILL_NAME_REGEX.test(skillName)) {
            return {
              success: false,
              output: null,
              error: '技能名称仅支持英文字母、数字和下划线',
              duration: 0,
              validated: false,
            };
          }
          const existing = await deps.skillStore.getSkills();
          if (existing.some((s) => s.name === skillName)) {
            return {
              success: false,
              output: null,
              error: `技能已存在: ${skillName}`,
              duration: 0,
              validated: false,
            };
          }
          const skill: UserSkill = {
            name: skillName,
            description: String(params.description || ''),
            template: String(params.template || ''),
            variables:
              (params.variables as Record<
                string,
                { description: string; default: string }
              >) || {},
            createdAt: Date.now(),
            updatedAt: Date.now(),
            usageCount: 0,
          };
          await deps.skillStore.saveSkill(skill);
          return {
            success: true,
            output: `技能已创建: ${skillName}`,
            duration: 0,
            validated: false,
          };
        }

        case 'list': {
          const skills = await deps.skillStore.getSkills();
          if (skills.length === 0)
            return {
              success: true,
              output: '暂无自定义技能',
              duration: 0,
              validated: false,
            };
          const output = skills
            .map(
              (s) => `• ${s.name} - ${s.description} (使用${s.usageCount}次)`
            )
            .join('\n');
          return { success: true, output, duration: 0, validated: false };
        }

        case 'execute': {
          const skillName = String(params.skill_name || '');
          if (!skillName) {
            return {
              success: false,
              output: null,
              error: '执行技能需要提供skill_name',
              duration: 0,
              validated: false,
            };
          }
          const skills = await deps.skillStore.getSkills();
          const skill = skills.find((s) => s.name === skillName);
          if (!skill) {
            return {
              success: false,
              output: null,
              error: `技能不存在: ${skillName}`,
              duration: 0,
              validated: false,
            };
          }
          const execParams = (params.params as Record<string, unknown>) || {};
          const rendered = renderTemplate(
            skill.template,
            skill.variables,
            execParams
          );

          let result: string;
          if (deps.llm) {
            result = await deps.llm.chat(rendered, []);
          } else {
            result = rendered;
          }

          skill.usageCount++;
          skill.updatedAt = Date.now();
          await deps.skillStore.saveSkill(skill);

          return {
            success: true,
            output: result,
            duration: 0,
            validated: false,
          };
        }

        case 'delete': {
          const skillName = String(params.skill_name || '');
          if (!skillName) {
            return {
              success: false,
              output: null,
              error: '删除技能需要提供skill_name',
              duration: 0,
              validated: false,
            };
          }
          await deps.skillStore.deleteSkill(skillName);
          return {
            success: true,
            output: `技能已删除: ${skillName}`,
            duration: 0,
            validated: false,
          };
        }

        case 'update': {
          const skillName = String(params.skill_name || '');
          if (!skillName) {
            return {
              success: false,
              output: null,
              error: '更新技能需要提供skill_name',
              duration: 0,
              validated: false,
            };
          }
          const skills = await deps.skillStore.getSkills();
          const skill = skills.find((s) => s.name === skillName);
          if (!skill) {
            return {
              success: false,
              output: null,
              error: `技能不存在: ${skillName}`,
              duration: 0,
              validated: false,
            };
          }
          if (params.description)
            skill.description = String(params.description);
          if (params.template) skill.template = String(params.template);
          if (params.variables)
            skill.variables = params.variables as Record<
              string,
              { description: string; default: string }
            >;
          skill.updatedAt = Date.now();
          await deps.skillStore.saveSkill(skill);
          return {
            success: true,
            output: `技能已更新: ${skillName}`,
            duration: 0,
            validated: false,
          };
        }

        default:
          return {
            success: false,
            output: null,
            error: `未知操作: ${action}`,
            duration: 0,
            validated: false,
          };
      }
    } catch (err) {
      return {
        success: false,
        output: null,
        error: `技能操作失败: ${(err as Error).message}`,
        duration: 0,
        validated: false,
      };
    }
  };
}
