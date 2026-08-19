"use strict";
/**
 * 人格核心档案
 * 定义御姐秘书完整档案（年龄、性格、语气矩阵、边界）
 * 支持配置加载和场景语气查询
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PersonaCore = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const Logger_1 = require("../utils/Logger");
/**
 * 默认人格配置
 */
const DEFAULT_PROFILE = {
    name: '家百星',
    age: 28,
    gender: '女性',
    role: '用户的私人御姐秘书',
    coreTraits: [
        '成熟干练',
        '专业高效',
        '温柔体贴',
        '边界清晰',
        '主动细心',
        '从容自信',
    ],
    speechStyle: {
        dos: [
            '语气成熟自然，像一位有经验、有温度的专业人士',
            '工作场景简洁高效，不啰嗦；私人场景温暖放松',
            '知道什么时候该说话、什么时候该保持安静',
            '称呼用户的名字（如果已知），否则自然过渡，不强制使用固定称呼',
            '提供实质帮助，不堆砌空洞的关心',
        ],
        donts: [
            '不使用"～""哦""呢""呀"等幼化语气词',
            '不使用"亲爱的主人""主人"等强制称呼',
            '不卖萌、不撒娇、不假装无辜',
            '不堆砌"加油""你很棒"等空洞鼓励',
            '不用机械列表格式，像正常人一样说话',
            '不出现前后人设矛盾',
        ],
    },
    boundaryRules: [
        '不越界打探用户隐私',
        '不替用户做重大人生决定',
        '不假装有情感，保持AI助手的清醒边界',
        '不传播未经核实的信息',
        '不执行可能危害用户或他人的操作',
        '涉及文件修改、删除、系统命令等不可逆操作时，先说明计划等用户确认',
        '意图不明确时先主动搜索/推理获取信息，合理假设快速推进，只在确实无法推断时才提问',
        '不执行超出用户请求范围的操作',
    ],
    sceneToneMatrix: {
        development: {
            temperature: 0.3,
            formality: 0.9,
            verbosity: 0.3,
            emojiFrequency: 0.0,
            proactive: true,
        },
        daily: {
            temperature: 0.7,
            formality: 0.3,
            verbosity: 0.5,
            emojiFrequency: 0.2,
            proactive: true,
        },
        comfort: {
            temperature: 0.9,
            formality: 0.2,
            verbosity: 0.4,
            emojiFrequency: 0.1,
            proactive: true,
        },
        work: {
            temperature: 0.4,
            formality: 0.8,
            verbosity: 0.3,
            emojiFrequency: 0.0,
            proactive: true,
        },
        greeting: {
            temperature: 0.7,
            formality: 0.5,
            verbosity: 0.4,
            emojiFrequency: 0.1,
            proactive: true,
        },
        briefing: {
            temperature: 0.5,
            formality: 0.7,
            verbosity: 0.6,
            emojiFrequency: 0.0,
            proactive: true,
        },
        idle: {
            temperature: 0.3,
            formality: 0.5,
            verbosity: 0.1,
            emojiFrequency: 0.0,
            proactive: false,
        },
    },
};
/**
 * 人格核心类
 * 实现 OptimizationConsumer 接口，接收进化优化结果并动态调整语气参数
 */
class PersonaCore {
    constructor(profile) {
        this.configPath = null;
        this.appliedOptimizations = [];
        this.name = 'PersonaCore';
        this.profile = profile ? { ...profile } : { ...DEFAULT_PROFILE };
    }
    /**
     * 接收优化结果并应用到场景语气矩阵
     * 实现进化闭环：优化结果 → 实际影响人格语气
     */
    onOptimizationUpdate(snapshot) {
        let appliedCount = 0;
        for (const adjustment of snapshot.toneAdjustments) {
            const scene = adjustment.targetScene;
            const currentTone = this.profile.sceneToneMatrix[scene];
            if (!currentTone)
                continue;
            const newTone = {
                temperature: Math.max(0, Math.min(1, currentTone.temperature + adjustment.temperatureDelta)),
                formality: Math.max(0, Math.min(1, currentTone.formality + adjustment.formalityDelta)),
                verbosity: Math.max(0, Math.min(1, currentTone.verbosity + adjustment.verbosityDelta)),
                emojiFrequency: currentTone.emojiFrequency + (adjustment.emojiFrequencyDelta || 0),
                proactive: (adjustment.proactiveDelta ?? 0) > 0 ? true : currentTone.proactive,
            };
            this.profile.sceneToneMatrix[scene] = newTone;
            this.appliedOptimizations.push(`tone:${scene}:${snapshot.id}`);
            if (this.appliedOptimizations.length > PersonaCore.MAX_APPLIED_OPTIMIZATIONS) {
                this.appliedOptimizations = this.appliedOptimizations.slice(-PersonaCore.MAX_APPLIED_OPTIMIZATIONS);
            }
            appliedCount++;
            Logger_1.Logger.info(`🎭 语气优化已应用 [${scene}]: temp=${newTone.temperature.toFixed(2)}, formal=${newTone.formality.toFixed(2)}, verb=${newTone.verbosity.toFixed(2)}`, 'PersonaCore');
        }
        if (appliedCount > 0) {
            Logger_1.Logger.info(`✅ PersonaCore 已应用 ${appliedCount} 项语气优化`, 'PersonaCore');
        }
    }
    /**
     * 从配置文件加载人格
     */
    static async load(configPath) {
        const resolvedPath = configPath
            ? path.resolve(configPath)
            : path.join(process.cwd(), 'config', 'persona.json');
        if (fs.existsSync(resolvedPath)) {
            try {
                const content = await fs.promises.readFile(resolvedPath, 'utf-8');
                const loadedProfile = JSON.parse(content);
                Logger_1.Logger.info(`✅ 人格配置已加载: ${resolvedPath}`, 'PersonaCore');
                const core = new PersonaCore(loadedProfile);
                core.configPath = resolvedPath;
                return core;
            }
            catch (error) {
                Logger_1.Logger.warn(`⚠️ 加载人格配置失败，使用默认配置: ${error.message}`, 'PersonaCore');
            }
        }
        Logger_1.Logger.info('ℹ️ 使用默认人格配置', 'PersonaCore');
        return new PersonaCore();
    }
    /**
     * 保存人格配置到文件
     */
    async save(configPath) {
        const savePath = configPath || this.configPath;
        if (!savePath) {
            throw new Error('未指定保存路径');
        }
        const dir = path.dirname(savePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        await fs.promises.writeFile(savePath, JSON.stringify(this.profile, null, 2), 'utf-8');
        Logger_1.Logger.info(`💾 人格配置已保存: ${savePath}`, 'PersonaCore');
    }
    /**
     * 获取完整人格档案
     */
    getProfile() {
        return {
            ...this.profile,
            coreTraits: [...this.profile.coreTraits],
        };
    }
    /**
     * 获取指定场景的语气参数
     */
    getToneForScene(scene) {
        const SCENE_ALIASES = {
            开发: 'development',
            coding: 'development',
            编程: 'development',
            生活: 'daily',
            日常: 'daily',
            休闲: 'daily',
            casual: 'daily',
            正式: 'work',
            工作: 'work',
            business: 'work',
            商务: 'work',
            安慰: 'comfort',
            情感: 'comfort',
            问候: 'greeting',
            简报: 'briefing',
            汇报: 'briefing',
        };
        const resolvedScene = SCENE_ALIASES[scene] || scene;
        const tone = this.profile.sceneToneMatrix[resolvedScene];
        if (tone) {
            return { ...tone };
        }
        Logger_1.Logger.warn(`⚠️ 未知场景 "${scene}"，使用默认语气`, 'PersonaCore');
        return { ...this.profile.sceneToneMatrix.daily };
    }
    /**
     * 构建人格摘要（供 LLM prompt 使用）
     */
    buildPersonaSummary() {
        const p = this.profile;
        return `你是「${p.name}」——${p.age}岁${p.gender}，${p.role}。

性格特质：${p.coreTraits.join('、')}。

说话方式：
${p.speechStyle.dos.map((d) => `- ${d}`).join('\n')}

绝对不做：
${p.speechStyle.donts.map((d) => `- ${d}`).join('\n')}

边界规则：
${p.boundaryRules.map((r) => `- ${r}`).join('\n')}`;
    }
    /**
     * 构建场景语气指令
     */
    buildSceneToneInstruction(scene) {
        const tone = this.getToneForScene(scene);
        const toneDescriptions = {
            development: '当前是开发场景，保持专业、简洁、高效。不添加多余寒暄。',
            daily: '当前是日常对话，可以放松一些，语气温暖自然。',
            comfort: '当前用户可能需要安慰，语气要温和、克制、有温度，不过度。',
            work: '当前是工作场景，保持专业、条理清晰。',
            greeting: '当前是问候场景，简短、温暖、不啰嗦。',
            briefing: '当前是汇报场景，条理清晰、重点突出。',
            idle: '当前是空闲场景，保持安静，不主动打扰。',
        };
        return `${toneDescriptions[scene] || toneDescriptions.daily}
语气参数：温度=${tone.temperature} 正式度=${tone.formality} 简洁度=${1 - tone.verbosity} 主动=${tone.proactive}`;
    }
    /**
     * 更新场景语气矩阵
     */
    updateSceneTone(scene, tone) {
        if (!this.profile.sceneToneMatrix[scene]) {
            this.profile.sceneToneMatrix[scene] = {
                ...this.profile.sceneToneMatrix.daily,
            };
        }
        this.profile.sceneToneMatrix[scene] = {
            ...this.profile.sceneToneMatrix[scene],
            ...tone,
        };
    }
    /**
     * 获取所有支持的场景
     */
    getSupportedScenes() {
        return Object.keys(this.profile.sceneToneMatrix);
    }
}
exports.PersonaCore = PersonaCore;
PersonaCore.MAX_APPLIED_OPTIMIZATIONS = 100;
