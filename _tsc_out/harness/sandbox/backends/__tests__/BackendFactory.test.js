"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const BackendFactory_1 = require("../BackendFactory");
const DaytonaBackend_1 = require("../DaytonaBackend");
const LocalBackend_1 = require("../LocalBackend");
const ModalBackend_1 = require("../ModalBackend");
const SingularityBackend_1 = require("../SingularityBackend");
jest.mock('child_process', () => ({
    exec: jest.fn(),
    execSync: jest.fn(),
    spawn: jest.fn(),
}));
describe('BackendFactory - 终端后端工厂', () => {
    beforeEach(() => {
        BackendFactory_1.BackendFactory['currentBackend'] = null;
        BackendFactory_1.BackendFactory['currentConfig'] = null;
    });
    afterEach(async () => {
        await BackendFactory_1.BackendFactory.cleanup();
    });
    describe('create - 创建后端实例', () => {
        test('应该创建 LocalBackend', () => {
            const backend = BackendFactory_1.BackendFactory.create({ type: 'local' });
            expect(backend).toBeInstanceOf(LocalBackend_1.LocalBackend);
            expect(backend.type).toBe('local');
        });
        test('应该创建 DaytonaBackend', () => {
            const backend = BackendFactory_1.BackendFactory.create({
                type: 'daytona',
                workspaceName: 'test-workspace',
            });
            expect(backend).toBeInstanceOf(DaytonaBackend_1.DaytonaBackend);
            expect(backend.type).toBe('daytona');
        });
        test('应该创建 ModalBackend', () => {
            const backend = BackendFactory_1.BackendFactory.create({
                type: 'modal',
                appName: 'test-app',
            });
            expect(backend).toBeInstanceOf(ModalBackend_1.ModalBackend);
            expect(backend.type).toBe('modal');
        });
        test('应该创建 SingularityBackend', () => {
            const backend = BackendFactory_1.BackendFactory.create({
                type: 'singularity',
                image: '/srv/test.sif',
            });
            expect(backend).toBeInstanceOf(SingularityBackend_1.SingularityBackend);
            expect(backend.type).toBe('singularity');
        });
    });
    describe('parseFromEnv - 环境变量解析', () => {
        const originalEnv = process.env;
        beforeEach(() => {
            process.env = { ...originalEnv };
        });
        afterEach(() => {
            process.env = originalEnv;
        });
        test('默认应返回 local 配置', () => {
            delete process.env.JBX_TERMINAL_BACKEND;
            const config = BackendFactory_1.BackendFactory.parseFromEnv();
            expect(config.type).toBe('local');
        });
        test('应该解析 daytona 配置', () => {
            process.env.JBX_TERMINAL_BACKEND = 'daytona';
            process.env.JBX_DAYTONA_WORKSPACE = 'my-workspace';
            process.env.JBX_DAYTONA_TEMPLATE = 'python';
            const config = BackendFactory_1.BackendFactory.parseFromEnv();
            expect(config.type).toBe('daytona');
            if (config.type === 'daytona') {
                expect(config.workspaceName).toBe('my-workspace');
                expect(config.template).toBe('python');
            }
        });
        test('应该解析 modal 配置', () => {
            process.env.JBX_TERMINAL_BACKEND = 'modal';
            process.env.JBX_MODAL_APP = 'test-app';
            process.env.JBX_MODAL_GPU = 'A100';
            process.env.JBX_MODAL_TIMEOUT = '600';
            const config = BackendFactory_1.BackendFactory.parseFromEnv();
            expect(config.type).toBe('modal');
            if (config.type === 'modal') {
                expect(config.appName).toBe('test-app');
                expect(config.gpu).toBe('A100');
                expect(config.modalTimeout).toBe(600);
            }
        });
        test('应该解析 singularity 配置', () => {
            process.env.JBX_TERMINAL_BACKEND = 'singularity';
            process.env.JBX_SINGULARITY_IMAGE = '/data/test.sif';
            process.env.JBX_SINGULARITY_FAKEROOT = 'true';
            process.env.JBX_SINGULARITY_NVIDIA = 'true';
            process.env.JBX_SINGULARITY_BINDS = '/data:/data,/tmp:/tmp';
            const config = BackendFactory_1.BackendFactory.parseFromEnv();
            expect(config.type).toBe('singularity');
            if (config.type === 'singularity') {
                expect(config.image).toBe('/data/test.sif');
                expect(config.fakeroot).toBe(true);
                expect(config.nvidia).toBe(true);
                expect(config.binds).toEqual(['/data:/data', '/tmp:/tmp']);
            }
        });
    });
    describe('getBackend - 单例管理', () => {
        test('相同配置应返回同一实例', async () => {
            const config = { type: 'local' };
            const backend1 = await BackendFactory_1.BackendFactory.getBackend(config);
            const backend2 = await BackendFactory_1.BackendFactory.getBackend(config);
            expect(backend1).toBe(backend2);
        });
    });
    describe('cleanup - 资源清理', () => {
        test('应该清理当前后端', async () => {
            const config = { type: 'local' };
            await BackendFactory_1.BackendFactory.getBackend(config);
            await BackendFactory_1.BackendFactory.cleanup();
            expect(BackendFactory_1.BackendFactory['currentBackend']).toBeNull();
            expect(BackendFactory_1.BackendFactory['currentConfig']).toBeNull();
        });
    });
});
describe('DaytonaBackend - Daytona Serverless 后端', () => {
    let backend;
    beforeEach(() => {
        backend = new DaytonaBackend_1.DaytonaBackend({
            type: 'daytona',
            workspaceName: 'test-workspace',
        });
    });
    test('type 应为 daytona', () => {
        expect(backend.type).toBe('daytona');
    });
    test('getInfo 应返回正确信息', () => {
        const info = backend.getInfo();
        expect(info.type).toBe('daytona');
        expect(info.name).toBe('DaytonaBackend');
        expect(info.isolation).toBe('container');
        expect(info.persistentShell).toBe(true);
        expect(info.description).toContain('Daytona');
    });
});
describe('ModalBackend - Modal Serverless 后端', () => {
    let backend;
    beforeEach(() => {
        backend = new ModalBackend_1.ModalBackend({
            type: 'modal',
            appName: 'test-app',
            gpu: 'A100',
        });
    });
    test('type 应为 modal', () => {
        expect(backend.type).toBe('modal');
    });
    test('getInfo 应返回正确信息', () => {
        const info = backend.getInfo();
        expect(info.type).toBe('modal');
        expect(info.name).toBe('ModalBackend');
        expect(info.isolation).toBe('container');
        expect(info.persistentShell).toBe(false);
        expect(info.description).toContain('A100');
    });
});
describe('SingularityBackend - Singularity 容器后端', () => {
    let backend;
    beforeEach(() => {
        backend = new SingularityBackend_1.SingularityBackend({
            type: 'singularity',
            image: '/srv/test.sif',
            fakeroot: true,
            nvidia: true,
            binds: ['/data:/data'],
        });
    });
    test('type 应为 singularity', () => {
        expect(backend.type).toBe('singularity');
    });
    test('getInfo 应返回正确信息', () => {
        const info = backend.getInfo();
        expect(info.type).toBe('singularity');
        expect(info.name).toBe('SingularityBackend');
        expect(info.isolation).toBe('container');
        expect(info.persistentShell).toBe(false);
        expect(info.description).toContain('/srv/test.sif');
    });
    test('buildSingularityCommand 应正确构建命令', () => {
        const cmd = backend['buildSingularityCommand']('python3 test.py', {
            cwd: '/workspace',
        });
        expect(cmd).toContain('singularity exec');
        expect(cmd).toContain('--fakeroot');
        expect(cmd).toContain('--nv');
        expect(cmd).toContain('--bind');
        expect(cmd).toContain('/data:/data');
        expect(cmd).toContain('--pwd /workspace');
        expect(cmd).toContain('/srv/test.sif');
    });
});
