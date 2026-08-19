"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROJECT_MANAGER_DEF = void 0;
exports.createProjectManagerExecutor = createProjectManagerExecutor;
const types_1 = require("../../types");
exports.PROJECT_MANAGER_DEF = {
    name: 'project_manager',
    description: '多项目管理工具。支持操作：list=列出所有项目, switch=切换当前项目, create=创建新项目, remove=删除项目, config=配置项目, status=查看项目状态。',
    category: types_1.ToolCategory.SYSTEM,
    parameters: {
        action: {
            type: 'string',
            description: '操作类型',
            enum: ['list', 'switch', 'create', 'remove', 'config', 'status'],
        },
        name: { type: 'string', description: '项目名称（create 操作必填）' },
        path: { type: 'string', description: '项目路径（create 操作必填）' },
        id: {
            type: 'string',
            description: '项目ID（switch/remove/config/status 操作使用）',
        },
        description: { type: 'string', description: '项目描述' },
        projectType: {
            type: 'string',
            enum: ['typescript', 'javascript', 'python', 'go', 'rust', 'workspace'],
            default: 'typescript',
            description: '项目类型',
        },
        tags: {
            type: 'array',
            items: { type: 'string', description: '标签值' },
            description: '项目标签',
        },
        contextFile: {
            type: 'string',
            description: '项目上下文文件名（默认 JIABAIXING.md）',
        },
        autoLoadContext: {
            type: 'boolean',
            default: true,
            description: '切换时自动加载上下文文件',
        },
    },
    requiredParams: ['action'],
    requiredPermissions: [types_1.Permission.FILE_READ, types_1.Permission.FILE_WRITE],
    riskLevel: 'low',
    idempotent: true,
    timeout: 10000,
};
const DEFAULT_STORAGE_PATH = '.jiabaixing/projects.json';
function loadProjectState(storagePath) {
    try {
        const fs = require('fs');
        if (fs.existsSync(storagePath)) {
            const raw = fs.readFileSync(storagePath, 'utf-8');
            return JSON.parse(raw);
        }
    }
    catch {
        // ignore
    }
    return { projects: [], activeProjectId: null, storagePath };
}
function saveProjectState(state) {
    try {
        const fs = require('fs');
        const dir = require('path').dirname(state.storagePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(state.storagePath, JSON.stringify(state, null, 2), 'utf-8');
    }
    catch (err) {
        console.error('保存项目状态失败:', err);
    }
}
function createProjectManagerExecutor() {
    let state = null;
    function getState() {
        if (!state) {
            state = loadProjectState(DEFAULT_STORAGE_PATH);
        }
        return state;
    }
    return async (params, _context) => {
        const startTime = Date.now();
        const action = params.action;
        const currentState = getState();
        const ok = (output) => ({
            success: true,
            output,
            duration: Date.now() - startTime,
            validated: false,
        });
        const fail = (error) => ({
            success: false,
            output: '',
            error,
            duration: Date.now() - startTime,
            validated: false,
        });
        switch (action) {
            case 'list': {
                return ok({
                    projects: currentState.projects,
                    activeProjectId: currentState.activeProjectId,
                    total: currentState.projects.length,
                });
            }
            case 'status': {
                const projectId = params.id || currentState.activeProjectId;
                const project = projectId
                    ? currentState.projects.find((p) => p.id === projectId)
                    : null;
                if (!project) {
                    return fail(`未找到项目: ${projectId}`);
                }
                try {
                    const fs = require('fs');
                    const path = require('path');
                    let fileCount = 0;
                    let totalSize = 0;
                    let hasGit = false;
                    if (fs.existsSync(project.path)) {
                        hasGit = fs.existsSync(path.join(project.path, '.git'));
                        const files = getAllFiles(project.path);
                        fileCount = files.length;
                        for (const f of files) {
                            try {
                                totalSize += fs.statSync(f).size;
                            }
                            catch {
                                // skip
                            }
                        }
                    }
                    return ok({
                        ...project,
                        stats: { fileCount, totalSize, hasGit },
                        isCurrent: project.id === currentState.activeProjectId,
                    });
                }
                catch (err) {
                    return fail(err.message);
                }
            }
            case 'switch': {
                const targetId = params.id;
                const project = currentState.projects.find((p) => p.id === targetId);
                if (!project) {
                    return fail(`未找到项目: ${targetId}`);
                }
                currentState.activeProjectId = targetId;
                project.lastActiveAt = new Date().toISOString();
                saveProjectState(currentState);
                let contextResult = null;
                if (params.autoLoadContext !== false && project.contextFile) {
                    try {
                        const fs = require('fs');
                        const ctxPath = require('path').join(project.path, project.contextFile);
                        if (fs.existsSync(ctxPath)) {
                            contextResult = fs.readFileSync(ctxPath, 'utf-8');
                        }
                    }
                    catch {
                        // ignore
                    }
                }
                return ok({
                    switchedTo: project,
                    contextLoaded: !!contextResult,
                    contextContent: contextResult?.slice(0, 500),
                });
            }
            case 'create': {
                const name = params.name;
                const projectPath = params.path;
                if (!name || !projectPath) {
                    return fail('创建项目需要 name 和 path 参数');
                }
                const existing = currentState.projects.find((p) => p.name === name || p.path === projectPath);
                if (existing) {
                    return fail('已存在同名或同路径的项目');
                }
                const newProject = {
                    id: `proj-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    name,
                    path: projectPath,
                    description: params.description,
                    projectType: params.projectType || 'typescript',
                    tags: params.tags || [],
                    contextFile: params.contextFile || 'JIABAIXING.md',
                    autoLoadContext: params.autoLoadContext !== false,
                    createdAt: new Date().toISOString(),
                    lastActiveAt: new Date().toISOString(),
                };
                currentState.projects.push(newProject);
                saveProjectState(currentState);
                return ok({
                    created: newProject,
                    totalProjects: currentState.projects.length,
                });
            }
            case 'remove': {
                const targetId = params.id;
                const idx = currentState.projects.findIndex((p) => p.id === targetId);
                if (idx === -1) {
                    return fail(`未找到项目: ${targetId}`);
                }
                const removed = currentState.projects.splice(idx, 1)[0];
                if (currentState.activeProjectId === targetId) {
                    currentState.activeProjectId = currentState.projects[0]?.id || null;
                }
                saveProjectState(currentState);
                return ok({ removed, remaining: currentState.projects.length });
            }
            case 'config': {
                const targetId = params.id;
                const project = currentState.projects.find((p) => p.id === targetId);
                if (!project) {
                    return fail(`未找到项目: ${targetId}`);
                }
                const allowedKeys = [
                    'name',
                    'description',
                    'tags',
                    'contextFile',
                    'autoLoadContext',
                    'projectType',
                ];
                for (const key of allowedKeys) {
                    if (params[key] !== undefined) {
                        project[key] = params[key];
                    }
                }
                saveProjectState(currentState);
                return ok({ updated: project });
            }
            default:
                return fail(`未知操作: ${action}`);
        }
    };
}
function getAllFiles(dirPath, maxDepth = 3, currentDepth = 0) {
    const fs = require('fs');
    const path = require('path');
    const results = [];
    if (currentDepth >= maxDepth)
        return results;
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules')
                continue;
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                results.push(...getAllFiles(fullPath, maxDepth, currentDepth + 1));
            }
            else {
                results.push(fullPath);
            }
        }
    }
    catch {
        // ignore permission errors etc.
    }
    return results;
}
