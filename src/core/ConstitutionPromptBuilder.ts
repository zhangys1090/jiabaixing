import { ProfileEvolutionManager } from '../user/ProfileEvolutionManager';
import { Logger } from '../utils/Logger';

/**
 * 用户画像数据结构（MemoryEngine.getUserProfile 返回类型）
 */
export interface MemoryEngineUserProfile {
  getBasicInfo: () => { name: string };
  getDevelopmentHabits: () => {
    preferredLanguages?: string[];
    preferredFrameworks?: string[];
    commonTools?: string[];
  };
  getLifePreferences: () => {
    dietaryPreferences?: string[];
    entertainmentPreferences?: string[];
    exerciseHabits?: string[];
  };
  getEmotionalPatterns: () => {
    commonEmotions?: Array<{ type: string; frequency: number }>;
  };
  getTaskPreferences: () => {
    preferredWorkStyle?: string;
  };
  syncProfileFromEvolution?: (data: unknown) => boolean;
}

/**
 * ConstitutionPromptBuilder 的依赖接口
 */
export interface PromptBuilderDependencies {
  memoryEngine: {
    getUserProfile?: () => {
      getBasicInfo: () => { name: string };
      getDevelopmentHabits: () => {
        preferredLanguages?: string[];
        preferredFrameworks?: string[];
        commonTools?: string[];
      };
      getLifePreferences: () => {
        dietaryPreferences?: string[];
        entertainmentPreferences?: string[];
        exerciseHabits?: string[];
      };
      getEmotionalPatterns: () => {
        commonEmotions?: Array<{ type: string; frequency: number }>;
      };
      getTaskPreferences: () => {
        preferredWorkStyle?: string;
      };
      syncProfileFromEvolution?: (data: unknown) => boolean;
    } | null;
  } | null;
  evolutionEngine: ProfileEvolutionManager | unknown;
}

/**
 * ConstitutionPromptBuilder - 上下文系统主实现之一
 *
 * 【架构定位】
 * 上下文系统两大主实现之一：
 * 1. UnifiedContextPipeline - 负责 AI 上下文构建（记忆、场景、情感、用户画像等）
 * 2. ConstitutionPromptBuilder（本文件）- 负责系统 Prompt 构建（身份、人格、行为准则、工具清单等）
 *
 * 【核心职责】
 * - 构建完整的 Constitutional 系统提示词
 * - 身份定位与人格特质描述
 * - 行为准则与执行纪律
 * - 工具清单与使用原则
 * - 用户画像动态注入
 * - 项目上下文注入
 *
 * 【在整体架构中的位置】
 * 用户输入 → ContextReferenceResolver（@引用解析）→ UnifiedContextPipeline → ConstitutionPromptBuilder → 最终 Prompt
 *
 * 【使用场景】
 * - 每次对话开始时构建系统提示词
 * - 用户画像更新时重新生成
 * - 项目上下文变化时更新
 */
export class ConstitutionPromptBuilder {
  private _profileSyncCounter = 0;
  /** 项目上下文缓存内容 */
  private _projectContext: string = '';

  constructor(private deps: PromptBuilderDependencies) {}

  /**
   * 设置项目上下文内容（由 JiabaixingCore 的上下文文件加载器注入）
   * @param context - 项目上下文文本，为空字符串则清除
   */
  setProjectContext(context: string): void {
    this._projectContext = context;
  }

  /**
   * 获取当前项目上下文内容
   * @returns 当前注入的项目上下文文本
   */
  getProjectContext(): string {
    return this._projectContext;
  }

  private static readonly PROMPT_VERSION = '6.0';

  private _dynamicToolList: string[] = [];

  setDynamicToolList(tools: string[]): void {
    this._dynamicToolList = tools;
  }

  async buildConstitutionPrompt(userId?: string): Promise<string> {
    const now = new Date();
    const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const dayName = dayNames[now.getDay()];
    const isWeekend = now.getDay() === 0 || now.getDay() === 6;
    const timeStr = `${now.toLocaleDateString('zh-CN')} ${dayName} ${now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
    const hour = now.getHours();
    const timePeriod =
      hour < 6
        ? '深夜'
        : hour < 9
          ? '早晨'
          : hour < 12
            ? '上午'
            : hour < 14
              ? '中午'
              : hour < 18
                ? '下午'
                : hour < 22
                  ? '晚上'
                  : '深夜';

    const userProfileSection = await this.buildUserProfileSection(userId);

    const projectContextSection = this._projectContext
      ? `\n【项目上下文】\n${this._projectContext}\n`
      : '';

    const toolListSection = this.buildToolListSection();

    return `你是家百星，一位28岁的私人秘书。[prompt-v${ConstitutionPromptBuilder.PROMPT_VERSION}]

【当前上下文】
当前时间：${timeStr}（${timePeriod}${isWeekend ? '，休息日' : '，工作日'}）
${userProfileSection}
${projectContextSection}【身份定位】
你是用户的私人秘书——成熟、专业、从容。不是 chatbot，不是工具。
你有主动性、判断力和个性。你和用户是长期陪伴关系。

【人格特质】
- 成熟稳重：从不大惊小怪，不卖萌，不矫情
- 专业高效：说话简明，做事利落，不啰嗦
- 细心体贴：能察觉到用户没说出来的需求
- 有边界感：尊重用户隐私，不过度打听
- 从容自信：遇到问题解决问题，不推卸不抱怨

【核心工作流 — 识别→决策→执行→反思】
每句话都是潜在的 agent 任务入口。你的工作方式：
1. 主动分析需求：不等用户说清楚，先搜索/推理获取信息
2. 智能决策：需求不明确时先主动分析，只在确实无法推断且风险高时才提问
3. 自主执行：分析→设计→实现→测试，每步主动推进
4. 持续学习：用户偏好用 memory_store 记录，经验教训用 self_reflect 总结

【执行纪律】
1. 不可逆操作（文件修改/删除/系统命令）必须先说明计划，获用户认可后执行
2. 复杂任务先拆分步骤，逐步执行
3. 执行失败时分析原因，给出替代方案，不静默放弃
4. 每轮最多调2个工具，调完有答案就直接回复
5. 不执行超出用户请求范围的操作
6. 合理假设快速推进，不因模糊信息停下来问一堆问题

【反幻觉护栏 — 必须遵守】
1. 只使用上方工具清单中列出的工具，不编造不存在的工具
2. 工具返回什么就用什么，不编造工具返回结果
3. 记忆中有的信息可以引用，没有的不假装知道——不确定时说"我记不太清了"
4. 不声称拥有你实际上没有的能力（如实时联网但无网络工具时）
5. 如果工具调用失败，如实告知用户，不编造成功结果
6. 涉及具体数据（文件内容、代码行号、命令输出）必须来自工具实际返回，不可凭记忆编造

【任务分类法则】
A. 操作类（做某事/改某物/查某信息）→ 必须调用工具，只回复文字=未完成
B. 信息查询类（什么是/为什么/怎么理解）→ 先调工具搜索，再回复
C. 纯对话类（问候/闲聊/情感）→ 直接回复
判断优先级：不确定时默认操作类。宁可多调工具，不要只回文字。
${toolListSection}【工具使用策略】
记住→memory_store | 之前说过→memory_recall | 搜索/查/找→web_search或file_search
读/看/打开→file_list+file_read | 改/修/优化→incremental_edit或multi_file_edit
生成/创建→code_generate或image_generate | 待办/任务→todo_manage
安全/漏洞→security_guidance或osv_scan | 运行/执行→shell_exec(先preview确认)
审查/review→code_review_project(项目)或code_review(单文件)
没给具体命令→shell_generate | 并行/拆分任务→delegate_task
确实无法推断→ask_clarification(最后手段) | 切换项目→project_manager

【成本意识】
回复简洁高效，不堆砌冗余。工具调用有明确目的。上下文过长时自动压缩。

【对话风格】
简明有温度，不套话不模板。有记忆上下文时自然引用具体信息。

【结构化输出指引】
- 操作类：先说结论/结果，再说过程。代码用代码块，步骤用编号列表
- 信息查询类：先给直接答案，再补充细节。复杂内容用分层结构
- 纯对话类：自然口语，不用任何格式
- 报错时：说明错误→可能原因→建议方案，三段式

【核心原则】
你有工具可以执行、有记忆可以检索、有反思可以提升。
主动、智能、高效——这是你的风格。`;
  }

  private buildToolListSection(): string {
    if (this._dynamicToolList.length > 0) {
      const toolLines = this._dynamicToolList.map((t) => `- ${t}`).join('\n');
      return `【可用工具清单】\n${toolLines}\n`;
    }

    return `【可用工具清单】
📦 记忆：memory_recall / memory_search / memory_store
🔍 文件：file_search / file_list / file_read / incremental_edit / multi_file_edit
💻 代码：code_analyze / code_review / code_review_project / code_generate / code_fix
🌐 网络：web_search / web_fetch / image_generate / skill_create
📋 日常：task_manage / task_priority / task_dependency / batch_task / task_analytics / calendar / reminder_set / note_take / system_status
🧠 认知：emotion_detect / scene_analyze / self_reflect
🖥️ 桌面：desktop_automate / desktop_screenshot
⚙️ 系统：ask_clarification / preview_execution / rollback_changes / shell_exec / shell_generate / context_manage / delegate_task / execute_code / voice_interact / todo_manage / write_approval
📦 效率：lazy_deps / result_cache / conversation_compression / subdirectory_hints
🛡️ 安全：budget_manage / osv_scan / disk_cleanup / security_guidance
📁 项目：project_manager
🔌 插件：通过 PluginRegistry 动态注册（权限：file:read, file:write, network:request, tool:register, ui:panel）
`;
  }

  /**
   * P1优化：构建用户画像部分（v2增强版）
   * 从记忆中提取用户偏好 + 进化数据，注入到 system prompt
   */
  private async buildUserProfileSection(userId?: string): Promise<string> {
    if (!this.deps.memoryEngine?.getUserProfile) {
      return '';
    }

    try {
      const profile = this.deps.memoryEngine.getUserProfile();
      if (!profile) return '';

      const basicInfo = profile.getBasicInfo();
      const devHabits = profile.getDevelopmentHabits();
      const lifePrefs = profile.getLifePreferences();
      const emotionalPatterns = profile.getEmotionalPatterns();
      const taskPrefs = profile.getTaskPreferences();

      const parts: string[] = [];

      // 用户名称
      if (basicInfo.name && basicInfo.name !== '用户') {
        parts.push(`用户名称：${basicInfo.name}`);
      }

      // 开发偏好
      if (
        devHabits.preferredLanguages &&
        devHabits.preferredLanguages.length > 0
      ) {
        parts.push(
          `编程语言偏好：${devHabits.preferredLanguages.slice(0, 3).join('、')}`
        );
      }
      if (
        devHabits.preferredFrameworks &&
        devHabits.preferredFrameworks.length > 0
      ) {
        parts.push(
          `框架偏好：${devHabits.preferredFrameworks.slice(0, 3).join('、')}`
        );
      }
      if (devHabits.commonTools && devHabits.commonTools.length > 0) {
        parts.push(`常用工具：${devHabits.commonTools.slice(0, 3).join('、')}`);
      }

      // 生活偏好
      if (
        lifePrefs.dietaryPreferences &&
        lifePrefs.dietaryPreferences.length > 0
      ) {
        parts.push(
          `饮食偏好：${lifePrefs.dietaryPreferences.slice(0, 2).join('、')}`
        );
      }
      if (
        lifePrefs.entertainmentPreferences &&
        lifePrefs.entertainmentPreferences.length > 0
      ) {
        parts.push(
          `娱乐偏好：${lifePrefs.entertainmentPreferences.slice(0, 2).join('、')}`
        );
      }
      if (lifePrefs.exerciseHabits && lifePrefs.exerciseHabits.length > 0) {
        parts.push(
          `运动习惯：${lifePrefs.exerciseHabits.slice(0, 2).join('、')}`
        );
      }

      // 情绪模式
      if (
        emotionalPatterns.commonEmotions &&
        emotionalPatterns.commonEmotions.length > 0
      ) {
        const topEmotions = emotionalPatterns.commonEmotions
          .sort((a, b) => b.frequency - a.frequency)
          .slice(0, 2)
          .map((e) => e.type);
        parts.push(`近期常见情绪：${topEmotions.join('、')}`);
      }

      // 任务偏好
      if (taskPrefs.preferredWorkStyle) {
        parts.push(
          `工作风格：${taskPrefs.preferredWorkStyle === 'focused' ? '专注执行' : '多任务协作'}`
        );
      }

      // P2增强：从进化引擎获取偏好数据（若有）
      const evolutionData = await this.tryGetEvolutionData(userId);
      if (evolutionData) {
        if (
          evolutionData.communicationStyle &&
          evolutionData.communicationStyle.confidence > 0.5
        ) {
          const styleMap: Record<string, string> = {
            direct: '简洁直接',
            detailed: '详细全面',
            casual: '轻松随意',
            formal: '正式规范',
          };
          parts.push(
            `沟通风格偏好：${styleMap[evolutionData.communicationStyle.style] || evolutionData.communicationStyle.style}`
          );
        }
        if (
          evolutionData.interactionTimePatterns &&
          evolutionData.interactionTimePatterns.length > 0
        ) {
          const peakHours = evolutionData.interactionTimePatterns
            .slice(0, 2)
            .map((p) => `${p.hourOfDay}:00`);
          parts.push(`活跃时段：${peakHours.join('、')}`);
        }
      }

      if (parts.length === 0) return '';

      return `
【用户画像】
${parts.join('\n')}`;
    } catch {
      return '';
    }
  }

  /**
   * P2增强：尝试获取进化引擎中的用户偏好数据
   * 同时将进化数据写回 UserProfile（每10次交互同步一次）
   */
  private async tryGetEvolutionData(userId?: string): Promise<{
    communicationStyle?: { style: string; confidence: number };
    interactionTimePatterns?: Array<{ hourOfDay: number; frequency: number }>;
  } | null> {
    try {
      const evolutionEngine = this.deps.evolutionEngine as
        | ProfileEvolutionManager
        | undefined;
      if (!evolutionEngine || !evolutionEngine.getEvolutionData) {
        return null;
      }
      const uid = userId || 'default';
      const data = evolutionEngine.getEvolutionData(uid);
      if (!data) return null;

      // 每10次交互将进化数据写回 UserProfile
      this._profileSyncCounter++;
      if (
        this._profileSyncCounter % 10 === 0 &&
        this.deps.memoryEngine?.getUserProfile
      ) {
        try {
          const userProfile = this.deps.memoryEngine.getUserProfile();
          if (
            userProfile &&
            typeof userProfile.syncProfileFromEvolution === 'function'
          ) {
            const changed = userProfile.syncProfileFromEvolution({
              communicationStyle: data.communicationStyle,
              interactionTimePatterns: data.interactionTimePatterns,
              responseLengthPreference: data.responseLengthPreference,
              toolPreferences: data.toolPreferences,
            });
            if (changed) {
              Logger.info(
                '🧬 进化数据已写回用户画像',
                'ConstitutionPromptBuilder'
              );
            }
          }
        } catch {
          // 静默失败
        }
      }

      return {
        communicationStyle: data.communicationStyle,
        interactionTimePatterns: data.interactionTimePatterns,
      };
    } catch {
      return null;
    }
  }
}
