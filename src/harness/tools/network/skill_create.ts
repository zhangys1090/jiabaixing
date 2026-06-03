import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';
import { SkillRegistry } from '../../../skills/SkillRegistry';

export const SKILL_CREATE_DEF: ToolDefinition = {
  name: 'skill_create',
  description:
    '用户自定义技能管理工具。支持创建、查看、执行、删除、更新技能模板，以及技能自我改进。适用场景：创建可复用的prompt模板、管理自定义技能、技能使用中自动优化。不适用：系统内置工具管理。',
  category: ToolCategory.NETWORK,
  parameters: {
    action: {
      type: 'string',
      description: '操作类型',
      enum: [
        'create',
        'list',
        'execute',
        'delete',
        'update',
        'auto_improve',
        'suggest_improvements',
        'usage_stats',
        'export',
        'import',
        'search_hub',
        'install_from_hub',
      ],
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
    feedback: {
      type: 'string',
      description: '用户反馈（auto_improve时使用）',
    },
    rating: {
      type: 'number',
      description: '评分1-10（auto_improve时使用）',
    },
    skill_json: {
      type: 'string',
      description:
        '技能JSON数据（import action时使用，符合agentskills.io格式）',
    },
    keyword: {
      type: 'string',
      description: '搜索关键词（search_hub action时使用）',
    },
    hub_id: {
      type: 'string',
      description: '技能市场ID（install_from_hub action时使用）',
    },
  },
  requiredParams: ['action'],
  requiredPermissions: [Permission.CODE_EXECUTE],
  riskLevel: 'medium',
  idempotent: false,
  timeout: 20000,
};

interface SkillUsageRecord {
  timestamp: number;
  success: boolean;
  rating?: number;
  feedback?: string;
  executionTime: number;
}

interface UserSkill {
  name: string;
  description: string;
  template: string;
  variables: Record<string, { description: string; default: string }>;
  createdAt: number;
  updatedAt: number;
  usageCount: number;
  usageHistory: SkillUsageRecord[];
  averageRating: number;
  lastImprovedAt?: number;
  improvementCount: number;
  version: number;
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
      history?: unknown[],
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
            usageHistory: [],
            averageRating: 0,
            improvementCount: 0,
            version: 1,
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
              (s) =>
                `• ${s.name} - ${s.description} (使用${s.usageCount}次, 评分${s.averageRating.toFixed(1)}, v${s.version})`
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

          const execStart = Date.now();
          let result: string;
          if (deps.llm) {
            result = await deps.llm.chat(rendered, []);
          } else {
            result = rendered;
          }
          const execDuration = Date.now() - execStart;

          skill.usageCount++;
          skill.updatedAt = Date.now();

          if (!skill.usageHistory) skill.usageHistory = [];
          skill.usageHistory.push({
            timestamp: Date.now(),
            success: true,
            executionTime: execDuration,
          });
          if (skill.usageHistory.length > 100) {
            skill.usageHistory = skill.usageHistory.slice(-100);
          }

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

        case 'auto_improve': {
          const skillName = String(params.skill_name || '');
          if (!skillName) {
            return {
              success: false,
              output: null,
              error: '技能改进需要提供skill_name',
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

          const rating = Number(params.rating) || 0;
          const feedback = String(params.feedback || '');

          if (!skill.usageHistory) skill.usageHistory = [];
          skill.usageHistory.push({
            timestamp: Date.now(),
            success: rating >= 5,
            rating,
            feedback,
            executionTime: 0,
          });

          if (rating > 0) {
            const totalRating = skill.usageHistory
              .filter((r) => r.rating !== undefined)
              .reduce((sum, r) => sum + (r.rating || 0), 0);
            const ratingCount = skill.usageHistory.filter(
              (r) => r.rating !== undefined
            ).length;
            skill.averageRating =
              ratingCount > 0 ? totalRating / ratingCount : 0;
          }

          if (deps.llm && (rating < 5 || feedback)) {
            const improvementPrompt = `你是一个技能优化助手。以下是一个用户自定义技能，用户反馈它需要改进。

技能名称: ${skill.name}
技能描述: ${skill.description}
当前模板:
${skill.template}

用户评分: ${rating}/10
用户反馈: ${feedback || '无具体反馈，但评分较低'}

最近使用统计:
- 使用次数: ${skill.usageCount}
- 平均评分: ${skill.averageRating.toFixed(1)}
- 改进次数: ${skill.improvementCount}

请分析问题并生成改进后的模板。只输出改进后的模板内容，不要其他解释。`;

            try {
              const improvedTemplate = await deps.llm.chat(
                improvementPrompt,
                []
              );
              if (improvedTemplate && improvedTemplate.trim().length > 0) {
                skill.template = improvedTemplate.trim();
                skill.improvementCount = (skill.improvementCount || 0) + 1;
                skill.lastImprovedAt = Date.now();
                skill.version = (skill.version || 1) + 1;
                skill.updatedAt = Date.now();
              }
            } catch {
              // LLM改进失败，仅记录反馈
            }
          }

          await deps.skillStore.saveSkill(skill);
          return {
            success: true,
            output: `技能反馈已记录: ${skillName} | 评分: ${rating} | 平均: ${skill.averageRating.toFixed(1)} | 版本: v${skill.version}`,
            duration: 0,
            validated: false,
          };
        }

        case 'suggest_improvements': {
          const skills = await deps.skillStore.getSkills();
          if (skills.length === 0) {
            return {
              success: true,
              output: '暂无技能可供分析',
              duration: 0,
              validated: false,
            };
          }

          const candidates = skills
            .filter(
              (s) =>
                s.usageCount >= 3 &&
                (s.averageRating < 6 ||
                  (s.usageHistory || []).filter((r) => !r.success).length > 2)
            )
            .sort((a, b) => a.averageRating - b.averageRating);

          if (candidates.length === 0) {
            return {
              success: true,
              output: '所有技能表现良好，暂无改进建议',
              duration: 0,
              validated: false,
            };
          }

          const suggestions = candidates
            .slice(0, 5)
            .map((s) => {
              const failCount = (s.usageHistory || []).filter(
                (r) => !r.success
              ).length;
              return `• ${s.name} — 评分:${s.averageRating.toFixed(1)} 使用:${s.usageCount}次 失败:${failCount}次 版本:v${s.version || 1}`;
            })
            .join('\n');

          return {
            success: true,
            output: `以下技能建议改进:\n${suggestions}`,
            duration: 0,
            validated: false,
          };
        }

        case 'usage_stats': {
          const skills = await deps.skillStore.getSkills();
          if (skills.length === 0) {
            return {
              success: true,
              output: '暂无技能使用统计',
              duration: 0,
              validated: false,
            };
          }

          const stats = skills
            .sort((a, b) => b.usageCount - a.usageCount)
            .map((s) => {
              const avgTime =
                (s.usageHistory || []).length > 0
                  ? Math.round(
                      s.usageHistory.reduce(
                        (sum, r) => sum + r.executionTime,
                        0
                      ) / s.usageHistory.length
                    )
                  : 0;
              return `• ${s.name} — 使用:${s.usageCount}次 评分:${s.averageRating.toFixed(1)} 平均耗时:${avgTime}ms 改进:${s.improvementCount || 0}次 v${s.version || 1}`;
            })
            .join('\n');

          return {
            success: true,
            output: `技能使用统计:\n${stats}`,
            duration: 0,
            validated: false,
          };
        }

        case 'export': {
          const skillName = String(params.skill_name || '');
          if (!skillName) {
            return {
              success: false,
              output: null,
              error: '导出技能需要提供skill_name',
              duration: 0,
              validated: false,
            };
          }
          const registry = SkillRegistry.getInstance();
          const exported = registry.exportSkill(skillName);
          if (!exported) {
            return {
              success: false,
              output: null,
              error: `导出技能失败：技能不存在或导出出错: ${skillName}`,
              duration: 0,
              validated: false,
            };
          }
          return {
            success: true,
            output: exported,
            duration: 0,
            validated: false,
          };
        }

        case 'import': {
          const skillJson = String(params.skill_json || '');
          if (!skillJson) {
            return {
              success: false,
              output: null,
              error:
                '导入技能需要提供skill_json（符合agentskills.io格式的JSON字符串）',
              duration: 0,
              validated: false,
            };
          }
          const registry = SkillRegistry.getInstance();
          const imported = registry.importSkill(skillJson);
          if (!imported) {
            return {
              success: false,
              output: null,
              error: '导入技能失败：JSON格式错误、缺少必要字段或技能已存在',
              duration: 0,
              validated: false,
            };
          }
          return {
            success: true,
            output: '技能导入成功',
            duration: 0,
            validated: false,
          };
        }

        case 'search_hub': {
          const keyword = String(params.keyword || '');
          if (!keyword) {
            return {
              success: false,
              output: null,
              error: '搜索技能市场需要提供keyword',
              duration: 0,
              validated: false,
            };
          }
          const registry = SkillRegistry.getInstance();
          const results = await registry.searchHub(keyword);
          if (results.length === 0) {
            return {
              success: true,
              output: `技能市场搜索 "${keyword}" 无匹配结果`,
              duration: 0,
              validated: false,
            };
          }
          const output = results
            .map(
              (s) =>
                `• ${s.name} (hubId: ${s.hubId || 'N/A'}) - ${s.description} [v${s.version}, ${s.license || 'MIT'}]`
            )
            .join('\n');
          return {
            success: true,
            output: `技能市场搜索结果 "${keyword}":\n${output}`,
            duration: 0,
            validated: false,
          };
        }

        case 'install_from_hub': {
          const hubId = String(params.hub_id || '');
          if (!hubId) {
            return {
              success: false,
              output: null,
              error: '安装技能需要提供hub_id',
              duration: 0,
              validated: false,
            };
          }
          const registry = SkillRegistry.getInstance();
          const installed = await registry.installFromHub(hubId);
          if (!installed) {
            return {
              success: false,
              output: null,
              error: `从技能市场安装失败：未找到技能或技能已存在 (hubId: ${hubId})`,
              duration: 0,
              validated: false,
            };
          }
          return {
            success: true,
            output: `技能市场安装成功 (hubId: ${hubId})`,
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
