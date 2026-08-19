"use strict";
/**
 * 桌面操作 MCP Server
 * 参考 Codex / UI-TARS 设计
 * 将桌面操控能力封装为标准 MCP (Model Context Protocol) 工具
 *
 * v2: 推进能力边界增强
 *   - 扩展工具集: 新增 hover/scroll_to/find_element/ui_tree/select_all/copy/paste/resize_window
 *   - 工具链编排: 支持多工具原子组合执行（如 find_element → click → type）
 *   - 工具调用追踪: 记录每次工具调用的耗时/结果，支持性能分析
 *   - 工具能力协商: 动态报告当前可用工具及约束（如坐标范围）
 *   - 批量工具调用: 支持一次请求执行多个工具
 *
 * 基于 DesktopActionExecutor 实现，复用所有现有桌面操作能力
 * 支持归一化坐标系统 [0-1000] × [0-1000]
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.desktopMCPServer = exports.DesktopMCPServer = void 0;
const events_1 = require("events");
const DesktopActionExecutor_1 = require("./DesktopActionExecutor");
const NormalizedCoordinates_1 = require("./NormalizedCoordinates");
const Logger_1 = require("../utils/Logger");
class DesktopMCPServer extends events_1.EventEmitter {
    constructor() {
        super();
        this.initialized = false;
        this.tools = [
            {
                name: 'screenshot',
                description: '截取当前屏幕图像，返回base64编码的PNG图片。用于观察屏幕状态。',
                inputSchema: {
                    type: 'object',
                    properties: {
                        monitor: {
                            type: 'number',
                            description: '显示器编号，默认为0（主显示器）',
                        },
                    },
                },
            },
            {
                name: 'click',
                description: '在指定位置点击鼠标左键。使用归一化坐标 [0-1000, 0-1000]，左上角为(0,0)，右下角为(1000,1000)。',
                inputSchema: {
                    type: 'object',
                    properties: {
                        x: {
                            type: 'number',
                            description: '归一化X坐标 (0-1000)',
                            minimum: 0,
                            maximum: 1000,
                        },
                        y: {
                            type: 'number',
                            description: '归一化Y坐标 (0-1000)',
                            minimum: 0,
                            maximum: 1000,
                        },
                        button: {
                            type: 'string',
                            description: '鼠标按钮',
                            enum: ['left', 'right', 'middle'],
                            default: 'left',
                        },
                        clicks: {
                            type: 'number',
                            description: '点击次数',
                            default: 1,
                        },
                    },
                    required: ['x', 'y'],
                },
            },
            {
                name: 'double_click',
                description: '双击指定位置。使用归一化坐标 [0-1000, 0-1000]。',
                inputSchema: {
                    type: 'object',
                    properties: {
                        x: {
                            type: 'number',
                            description: '归一化X坐标 (0-1000)',
                            minimum: 0,
                            maximum: 1000,
                        },
                        y: {
                            type: 'number',
                            description: '归一化Y坐标 (0-1000)',
                            minimum: 0,
                            maximum: 1000,
                        },
                    },
                    required: ['x', 'y'],
                },
            },
            {
                name: 'type',
                description: '在当前焦点位置输入文字。',
                inputSchema: {
                    type: 'object',
                    properties: {
                        text: {
                            type: 'string',
                            description: '要输入的文字内容',
                        },
                    },
                    required: ['text'],
                },
            },
            {
                name: 'key',
                description: '按下并释放单个按键。',
                inputSchema: {
                    type: 'object',
                    properties: {
                        key: {
                            type: 'string',
                            description: '按键名称，如 enter, backspace, tab, escape, arrow_up, arrow_down, arrow_left, arrow_right 等',
                        },
                    },
                    required: ['key'],
                },
            },
            {
                name: 'key_combo',
                description: '按下组合键，如 Ctrl+C, Alt+Tab 等。',
                inputSchema: {
                    type: 'object',
                    properties: {
                        keys: {
                            type: 'array',
                            items: { type: 'string' },
                            description: '按键数组，按顺序按下，逆序释放。如 ["ctrl", "c"] 表示 Ctrl+C',
                        },
                    },
                    required: ['keys'],
                },
            },
            {
                name: 'scroll',
                description: '滚动鼠标滚轮。',
                inputSchema: {
                    type: 'object',
                    properties: {
                        delta: {
                            type: 'number',
                            description: '滚动量，正数向上，负数向下',
                            default: 3,
                        },
                        x: {
                            type: 'number',
                            description: '归一化X坐标，滚动位置（可选）',
                        },
                        y: {
                            type: 'number',
                            description: '归一化Y坐标，滚动位置（可选）',
                        },
                    },
                },
            },
            {
                name: 'drag',
                description: '拖拽鼠标从一个位置到另一个位置。使用归一化坐标。',
                inputSchema: {
                    type: 'object',
                    properties: {
                        from_x: {
                            type: 'number',
                            description: '起始归一化X坐标',
                            minimum: 0,
                            maximum: 1000,
                        },
                        from_y: {
                            type: 'number',
                            description: '起始归一化Y坐标',
                            minimum: 0,
                            maximum: 1000,
                        },
                        to_x: {
                            type: 'number',
                            description: '目标归一化X坐标',
                            minimum: 0,
                            maximum: 1000,
                        },
                        to_y: {
                            type: 'number',
                            description: '目标归一化Y坐标',
                            minimum: 0,
                            maximum: 1000,
                        },
                        duration: {
                            type: 'number',
                            description: '拖拽持续时间（毫秒）',
                            default: 500,
                        },
                    },
                    required: ['from_x', 'from_y', 'to_x', 'to_y'],
                },
            },
            {
                name: 'get_windows',
                description: '获取当前所有打开的窗口列表。',
                inputSchema: {
                    type: 'object',
                    properties: {},
                },
            },
            {
                name: 'activate_window',
                description: '激活（前置）指定标题的窗口。',
                inputSchema: {
                    type: 'object',
                    properties: {
                        title: {
                            type: 'string',
                            description: '窗口标题（支持部分匹配）',
                        },
                    },
                    required: ['title'],
                },
            },
            {
                name: 'open_app',
                description: '打开指定应用程序。',
                inputSchema: {
                    type: 'object',
                    properties: {
                        app: {
                            type: 'string',
                            description: '应用名称或路径，如 notepad, calc, chrome 等',
                        },
                        args: {
                            type: 'array',
                            items: { type: 'string' },
                            description: '启动参数',
                        },
                    },
                    required: ['app'],
                },
            },
            {
                name: 'wait',
                description: '等待指定时间。',
                inputSchema: {
                    type: 'object',
                    properties: {
                        ms: {
                            type: 'number',
                            description: '等待毫秒数',
                            default: 1000,
                        },
                    },
                },
            },
            {
                name: 'get_clipboard',
                description: '获取当前剪贴板内容。',
                inputSchema: {
                    type: 'object',
                    properties: {},
                },
            },
            {
                name: 'set_clipboard',
                description: '设置剪贴板内容。',
                inputSchema: {
                    type: 'object',
                    properties: {
                        text: {
                            type: 'string',
                            description: '要设置的文本内容',
                        },
                    },
                    required: ['text'],
                },
            },
            {
                name: 'get_screen_size',
                description: '获取屏幕尺寸信息。',
                inputSchema: {
                    type: 'object',
                    properties: {},
                },
            },
            {
                name: 'maximize_window',
                description: '最大化当前或指定窗口。',
                inputSchema: {
                    type: 'object',
                    properties: {
                        title: {
                            type: 'string',
                            description: '窗口标题（可选，不指定则最大化当前窗口）',
                        },
                    },
                },
            },
            {
                name: 'minimize_window',
                description: '最小化当前或指定窗口。',
                inputSchema: {
                    type: 'object',
                    properties: {
                        title: {
                            type: 'string',
                            description: '窗口标题（可选）',
                        },
                    },
                },
            },
            {
                name: 'close_window',
                description: '关闭指定窗口。',
                inputSchema: {
                    type: 'object',
                    properties: {
                        title: {
                            type: 'string',
                            description: '窗口标题',
                        },
                    },
                    required: ['title'],
                },
            },
            {
                name: 'hover',
                description: '将鼠标移动到指定位置（悬停）。使用归一化坐标 [0-1000, 0-1000]。',
                inputSchema: {
                    type: 'object',
                    properties: {
                        x: { type: 'number', description: '归一化X坐标 (0-1000)', minimum: 0, maximum: 1000 },
                        y: { type: 'number', description: '归一化Y坐标 (0-1000)', minimum: 0, maximum: 1000 },
                    },
                    required: ['x', 'y'],
                },
            },
            {
                name: 'find_element',
                description: '通过描述查找屏幕上的UI元素，返回其位置和属性。用于精确定位而非盲目点击。',
                inputSchema: {
                    type: 'object',
                    properties: {
                        description: { type: 'string', description: '元素描述，如"确定按钮"、"用户名输入框"' },
                    },
                    required: ['description'],
                },
            },
            {
                name: 'ui_tree',
                description: '获取当前活动窗口的UI元素树结构，用于了解界面布局和可用交互元素。',
                inputSchema: {
                    type: 'object',
                    properties: {
                        max_depth: { type: 'number', description: '最大遍历深度', default: 5 },
                    },
                },
            },
            {
                name: 'select_all',
                description: '全选当前焦点区域的内容（Ctrl+A）。',
                inputSchema: { type: 'object', properties: {} },
            },
            {
                name: 'copy',
                description: '复制选中内容到剪贴板（Ctrl+C）。',
                inputSchema: { type: 'object', properties: {} },
            },
            {
                name: 'paste',
                description: '粘贴剪贴板内容到当前焦点位置（Ctrl+V）。',
                inputSchema: { type: 'object', properties: {} },
            },
            {
                name: 'resize_window',
                description: '调整指定窗口大小。',
                inputSchema: {
                    type: 'object',
                    properties: {
                        title: { type: 'string', description: '窗口标题（可选）' },
                        width: { type: 'number', description: '目标宽度（像素）' },
                        height: { type: 'number', description: '目标高度（像素）' },
                    },
                },
            },
            {
                name: 'scroll_to',
                description: '滚动到指定方向/位置，支持按页或按行滚动。',
                inputSchema: {
                    type: 'object',
                    properties: {
                        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: '滚动方向' },
                        amount: { type: 'number', description: '滚动量（行数或页数）', default: 3 },
                    },
                    required: ['direction'],
                },
            },
        ];
        this.executor = DesktopActionExecutor_1.DesktopActionExecutor.getInstance();
        this.coords = NormalizedCoordinates_1.NormalizedCoordinateSystem.getInstance();
        this._toolTrace = [];
        this._maxTraceEntries = 200;
        this._toolChains = new Map();
    }
    static getInstance() {
        if (!DesktopMCPServer.instance) {
            DesktopMCPServer.instance = new DesktopMCPServer();
        }
        return DesktopMCPServer.instance;
    }
    async initialize() {
        if (this.initialized)
            return;
        Logger_1.Logger.info('🔧 DesktopMCP Server 初始化', 'DesktopMCP');
        await this.executor.initialize();
        this.initialized = true;
    }
    /**
     * 获取所有可用工具列表
     */
    listTools() {
        return this.tools;
    }
    /**
     * 调用工具
     */
    async callTool(name, args) {
        this.ensureInitialized();
        const callStart = Date.now();
        Logger_1.Logger.debug(`🔧 MCP工具调用: ${name}`, 'DesktopMCP');
        this.emit('tool_call', { name, args });
        try {
            const result = await this.executeTool(name, args);
            const duration = Date.now() - callStart;
            this._recordTrace(name, args, result, duration, false);
            this.emit('tool_result', { name, result, duration });
            return result;
        }
        catch (error) {
            const duration = Date.now() - callStart;
            this._recordTrace(name, args, null, duration, true, error.message);
            const errorResult = {
                content: [
                    {
                        type: 'text',
                        text: `工具执行失败: ${error.message}`,
                    },
                ],
                isError: true,
            };
            this.emit('tool_error', { name, error: error.message, duration });
            return errorResult;
        }
    }
    async executeTool(name, args) {
        switch (name) {
            case 'screenshot':
                return await this.handleScreenshot(args);
            case 'click':
                return await this.handleClick(args);
            case 'double_click':
                return await this.handleDoubleClick(args);
            case 'type':
                return await this.handleType(args);
            case 'key':
                return await this.handleKey(args);
            case 'key_combo':
                return await this.handleKeyCombo(args);
            case 'scroll':
                return await this.handleScroll(args);
            case 'drag':
                return await this.handleDrag(args);
            case 'get_windows':
                return await this.handleGetWindows(args);
            case 'activate_window':
                return await this.handleActivateWindow(args);
            case 'open_app':
                return await this.handleOpenApp(args);
            case 'wait':
                return await this.handleWait(args);
            case 'get_clipboard':
                return await this.handleGetClipboard(args);
            case 'set_clipboard':
                return await this.handleSetClipboard(args);
            case 'get_screen_size':
                return this.handleGetScreenSize();
            case 'maximize_window':
                return await this.handleMaximizeWindow(args);
            case 'minimize_window':
                return await this.handleMinimizeWindow(args);
            case 'close_window':
                return await this.handleCloseWindow(args);
            case 'hover':
                return await this.handleHover(args);
            case 'find_element':
                return await this.handleFindElement(args);
            case 'ui_tree':
                return await this.handleUITree(args);
            case 'select_all':
                return await this.handleSelectAll(args);
            case 'copy':
                return await this.handleCopy(args);
            case 'paste':
                return await this.handlePaste(args);
            case 'resize_window':
                return await this.handleResizeWindow(args);
            case 'scroll_to':
                return await this.handleScrollTo(args);
            default:
                return {
                    content: [{ type: 'text', text: `未知工具: ${name}` }],
                    isError: true,
                };
        }
    }
    async handleScreenshot(args) {
        const action = {
            type: 'screenshot',
            params: { monitor: args.monitor || 0 },
            description: '截图',
        };
        const result = await this.executor.executeAction(action);
        return this.actionResultToMCP(result);
    }
    async handleClick(args) {
        const pixel = this.coords.toPixel({
            x: args.x,
            y: args.y,
        });
        const button = args.button || 'left';
        const actionType = button === 'right' ? 'rightClick' : 'click';
        const action = {
            type: actionType,
            params: {
                x: pixel.x,
                y: pixel.y,
                clicks: args.clicks || 1,
            },
            description: `点击 (${args.x}, ${args.y}) [${pixel.x}, ${pixel.y}]`,
        };
        const result = await this.executor.executeAction(action);
        return this.actionResultToMCP(result);
    }
    async handleDoubleClick(args) {
        const pixel = this.coords.toPixel({
            x: args.x,
            y: args.y,
        });
        const action = {
            type: 'doubleClick',
            params: {
                x: pixel.x,
                y: pixel.y,
            },
            description: `双击 (${args.x}, ${args.y})`,
        };
        const result = await this.executor.executeAction(action);
        return this.actionResultToMCP(result);
    }
    async handleType(args) {
        const action = {
            type: 'type',
            params: { text: args.text },
            description: `输入文字: ${args.text}`,
        };
        const result = await this.executor.executeAction(action);
        return this.actionResultToMCP(result);
    }
    async handleKey(args) {
        const action = {
            type: 'key',
            params: { key: args.key },
            description: `按键: ${args.key}`,
        };
        const result = await this.executor.executeAction(action);
        return this.actionResultToMCP(result);
    }
    async handleKeyCombo(args) {
        const action = {
            type: 'keyCombo',
            params: { keys: args.keys },
            description: `组合键: ${args.keys.join('+')}`,
        };
        const result = await this.executor.executeAction(action);
        return this.actionResultToMCP(result);
    }
    async handleScroll(args) {
        const WHEEL_DELTA = 120;
        const rawDelta = args.delta || 3;
        const delta = rawDelta * WHEEL_DELTA;
        const action = {
            type: 'scroll',
            params: {
                delta,
                x: args.x
                    ? this.coords.toPixel({ x: args.x, y: 0 }).x
                    : undefined,
                y: args.y
                    ? this.coords.toPixel({ x: 0, y: args.y }).y
                    : undefined,
            },
            description: `滚动: delta=${rawDelta} (${delta})`,
        };
        const result = await this.executor.executeAction(action);
        return this.actionResultToMCP(result);
    }
    async handleDrag(args) {
        const fromPixel = this.coords.toPixel({
            x: args.from_x,
            y: args.from_y,
        });
        const toPixel = this.coords.toPixel({
            x: args.to_x,
            y: args.to_y,
        });
        const action = {
            type: 'drag',
            params: {
                fromX: fromPixel.x,
                fromY: fromPixel.y,
                toX: toPixel.x,
                toY: toPixel.y,
                duration: args.duration || 500,
            },
            description: `拖拽 (${args.from_x}, ${args.from_y}) → (${args.to_x}, ${args.to_y})`,
        };
        const result = await this.executor.executeAction(action);
        return this.actionResultToMCP(result);
    }
    async handleGetWindows(_args) {
        try {
            const WindowManager_1 = require('./WindowManager');
            const wm = WindowManager_1.WindowManager.getInstance();
            await wm.initialize();
            const windows = await wm.listWindows();
            const windowList = windows.map((w) => ({
                title: w.title || '',
                processName: w.processName || '',
                isVisible: w.isVisible ?? true,
                isMinimized: w.isMinimized ?? false,
            }));
            return {
                content: [{ type: 'text', text: JSON.stringify({ windowCount: windowList.length, windows: windowList }, null, 2) }],
            };
        }
        catch (err) {
            return {
                content: [{ type: 'text', text: `获取窗口列表失败: ${err.message}` }],
                isError: true,
            };
        }
    }
    async handleActivateWindow(args) {
        const action = {
            type: 'activateWindow',
            params: { title: args.title },
            description: `激活窗口: ${args.title}`,
        };
        const result = await this.executor.executeAction(action);
        return this.actionResultToMCP(result);
    }
    async handleOpenApp(args) {
        const action = {
            type: 'openApp',
            params: {
                app: args.app,
                args: args.args || [],
            },
            description: `打开应用: ${args.app}`,
        };
        const result = await this.executor.executeAction(action);
        return this.actionResultToMCP(result);
    }
    async handleWait(args) {
        const action = {
            type: 'wait',
            params: { ms: args.ms || 1000 },
            description: `等待 ${args.ms || 1000}ms`,
        };
        const result = await this.executor.executeAction(action);
        return this.actionResultToMCP(result);
    }
    async handleGetClipboard(_args) {
        const action = {
            type: 'clipboardRead',
            params: {},
            description: '读取剪贴板',
        };
        const result = await this.executor.executeAction(action);
        return this.actionResultToMCP(result);
    }
    async handleSetClipboard(args) {
        const action = {
            type: 'clipboardWrite',
            params: { text: args.text },
            description: `设置剪贴板: ${args.text}`,
        };
        const result = await this.executor.executeAction(action);
        return this.actionResultToMCP(result);
    }
    handleGetScreenSize() {
        const pixelSize = this.coords.getPixelScreenSize();
        const normalizedSize = this.coords.getNormalizedScreenSize();
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        pixel_width: pixelSize.width,
                        pixel_height: pixelSize.height,
                        normalized_width: normalizedSize.width,
                        normalized_height: normalizedSize.height,
                        coordinate_system: '[0-1000] × [0-1000] 归一化坐标',
                    }, null, 2),
                },
            ],
        };
    }
    async handleMaximizeWindow(args) {
        const action = {
            type: 'maximize',
            params: { title: args.title },
            description: `最大化窗口: ${args.title || '当前窗口'}`,
        };
        const result = await this.executor.executeAction(action);
        return this.actionResultToMCP(result);
    }
    async handleMinimizeWindow(args) {
        const action = {
            type: 'minimize',
            params: { title: args.title },
            description: `最小化窗口: ${args.title || '当前窗口'}`,
        };
        const result = await this.executor.executeAction(action);
        return this.actionResultToMCP(result);
    }
    async handleCloseWindow(args) {
        const action = {
            type: 'closeWindow',
            params: { title: args.title },
            description: `关闭窗口: ${args.title}`,
        };
        const result = await this.executor.executeAction(action);
        return this.actionResultToMCP(result);
    }
    async handleHover(args) {
        const pixel = this.coords.toPixel({ x: args.x, y: args.y });
        const action = {
            type: 'hover',
            params: { x: pixel.x, y: pixel.y },
            description: `悬停 (${args.x}, ${args.y}) [${pixel.x}, ${pixel.y}]`,
        };
        const result = await this.executor.executeAction(action);
        return this.actionResultToMCP(result);
    }
    async handleFindElement(args) {
        try {
            const DesktopUIInspector_1 = require('./DesktopUIInspector');
            const inspector = DesktopUIInspector_1.DesktopUIInspector.getInstance();
            await inspector.initialize();
            const element = await inspector.findElementByDescription(args.description);
            if (element) {
                const centerX = element.center?.x ?? (element.boundingRect?.x ?? 0) + (element.boundingRect?.width ?? 0) / 2;
                const centerY = element.center?.y ?? (element.boundingRect?.y ?? 0) + (element.boundingRect?.height ?? 0) / 2;
                const normalizedPos = this.coords.toNormalized({ x: Math.floor(centerX), y: Math.floor(centerY) });
                return {
                    content: [{
                            type: 'text',
                            text: JSON.stringify({
                                found: true,
                                name: element.name || '',
                                automationId: element.automationId || '',
                                controlType: element.controlTypeName || '',
                                x: normalizedPos.x,
                                y: normalizedPos.y,
                                width: element.boundingRect?.width,
                                height: element.boundingRect?.height,
                                isClickable: element.isClickable || false,
                                isEditable: element.isEditable || false,
                                isEnabled: element.isEnabled ?? true,
                            }, null, 2),
                        }],
                };
            }
            return {
                content: [{ type: 'text', text: JSON.stringify({ found: false, description: args.description }) }],
            };
        }
        catch (err) {
            return {
                content: [{ type: 'text', text: `元素查找失败: ${err.message}` }],
                isError: true,
            };
        }
    }
    async handleUITree(args) {
        try {
            const DesktopUIInspector_1 = require('./DesktopUIInspector');
            const inspector = DesktopUIInspector_1.DesktopUIInspector.getInstance();
            await inspector.initialize();
            const elements = await inspector.getInteractiveElements();
            const maxDepth = args?.max_depth ?? 5;
            const summary = elements.slice(0, 50).map((e) => {
                const cx = e.center?.x ?? (e.boundingRect?.x ?? 0) + (e.boundingRect?.width ?? 0) / 2;
                const cy = e.center?.y ?? (e.boundingRect?.y ?? 0) + (e.boundingRect?.height ?? 0) / 2;
                const norm = this.coords.toNormalized({ x: Math.floor(cx), y: Math.floor(cy) });
                return {
                    name: e.name || '',
                    automationId: e.automationId || '',
                    type: e.controlTypeName || '',
                    x: norm.x,
                    y: norm.y,
                    clickable: e.isClickable || false,
                    editable: e.isEditable || false,
                };
            });
            return {
                content: [{
                        type: 'text',
                        text: JSON.stringify({ elementCount: elements.length, elements: summary }, null, 2),
                    }],
            };
        }
        catch (err) {
            return {
                content: [{ type: 'text', text: `UI树获取失败: ${err.message}` }],
                isError: true,
            };
        }
    }
    async handleSelectAll(_args) {
        const action = { type: 'selectAll', params: {}, description: '全选 (Ctrl+A)' };
        const result = await this.executor.executeAction(action);
        return this.actionResultToMCP(result);
    }
    async handleCopy(_args) {
        const action = { type: 'copy', params: {}, description: '复制 (Ctrl+C)' };
        const result = await this.executor.executeAction(action);
        return this.actionResultToMCP(result);
    }
    async handlePaste(_args) {
        const action = { type: 'paste', params: {}, description: '粘贴 (Ctrl+V)' };
        const result = await this.executor.executeAction(action);
        return this.actionResultToMCP(result);
    }
    async handleResizeWindow(args) {
        const action = {
            type: 'resizeWindow',
            params: { title: args.title, width: args.width, height: args.height },
            description: `调整窗口: ${args.width || '自动'}x${args.height || '自动'}`,
        };
        const result = await this.executor.executeAction(action);
        return this.actionResultToMCP(result);
    }
    async handleScrollTo(args) {
        const direction = args.direction || 'down';
        const amount = args.amount || 3;
        const WHEEL_DELTA = 120;
        const deltaMap = {
            up: WHEEL_DELTA * amount,
            down: -WHEEL_DELTA * amount,
            left: -WHEEL_DELTA * amount,
            right: WHEEL_DELTA * amount,
        };
        const action = {
            type: 'scroll',
            params: { delta: deltaMap[direction] ?? -WHEEL_DELTA * amount },
            description: `滚动: ${direction} ${amount}`,
        };
        const result = await this.executor.executeAction(action);
        return this.actionResultToMCP(result);
    }
    _recordTrace(toolName, args, result, durationMs, isError, errorMsg) {
        this._toolTrace.push({
            toolName,
            args: JSON.stringify(args).substring(0, 200),
            success: !isError,
            durationMs,
            timestamp: Date.now(),
            error: errorMsg || null,
        });
        if (this._toolTrace.length > this._maxTraceEntries) {
            this._toolTrace.shift();
        }
    }
    getToolTrace(limit) {
        const trace = [...this._toolTrace];
        return limit ? trace.slice(-limit) : trace;
    }
    getToolStats() {
        const stats = {};
        for (const entry of this._toolTrace) {
            if (!stats[entry.toolName]) {
                stats[entry.toolName] = { calls: 0, success: 0, failed: 0, totalDurationMs: 0 };
            }
            const s = stats[entry.toolName];
            s.calls++;
            if (entry.success) s.success++;
            else s.failed++;
            s.totalDurationMs += entry.durationMs;
        }
        for (const name of Object.keys(stats)) {
            const s = stats[name];
            s.avgDurationMs = Math.round(s.totalDurationMs / s.calls);
            s.successRate = s.calls > 0 ? s.success / s.calls : 0;
        }
        return stats;
    }
    registerToolChain(id, steps, options) {
        this._toolChains.set(id, {
            id,
            steps,
            continueOnError: options?.continueOnError ?? false,
            delayBetweenMs: options?.delayBetweenMs ?? 100,
        });
        Logger_1.Logger.info(`🔗 注册工具链: ${id} (${steps.length}步)`, 'DesktopMCP');
    }
    async executeToolChain(id, initialArgs) {
        const chain = this._toolChains.get(id);
        if (!chain) {
            return { content: [{ type: 'text', text: `工具链不存在: ${id}` }], isError: true };
        }
        const results = [];
        let carryArgs = { ...initialArgs };
        for (let i = 0; i < chain.steps.length; i++) {
            const step = chain.steps[i];
            const stepArgs = step.mapArgs ? step.mapArgs(carryArgs, results) : carryArgs;
            try {
                const result = await this.callTool(step.tool, stepArgs);
                results.push({ step: i, tool: step.tool, result });
                if (step.reduceArgs) {
                    carryArgs = step.reduceArgs(carryArgs, result);
                }
                if (chain.delayBetweenMs > 0 && i < chain.steps.length - 1) {
                    await new Promise((r) => setTimeout(r, chain.delayBetweenMs));
                }
            }
            catch (err) {
                results.push({ step: i, tool: step.tool, error: err.message });
                if (!chain.continueOnError) {
                    return {
                        content: [{ type: 'text', text: `工具链中断于步骤${i}: ${err.message}` }],
                        isError: true,
                        partialResults: results,
                    };
                }
            }
        }
        return {
            content: [{ type: 'text', text: `工具链完成: ${id}, ${results.length}/${chain.steps.length}步` }],
            chainResults: results,
        };
    }
    async callToolBatch(requests, options) {
        const parallel = options?.parallel ?? false;
        if (parallel) {
            const results = await Promise.allSettled(requests.map(async (req) => {
                try {
                    const result = await this.callTool(req.name, req.args || {});
                    return { name: req.name, result };
                }
                catch (err) {
                    return { name: req.name, error: err.message };
                }
            }));
            return results.map((r) => r.status === 'fulfilled' ? r.value : { name: 'unknown', error: r.reason?.message || 'Unknown error' });
        }
        const results = [];
        for (const req of requests) {
            try {
                const result = await this.callTool(req.name, req.args || {});
                results.push({ name: req.name, result });
            }
            catch (err) {
                results.push({ name: req.name, error: err.message });
            }
        }
        return results;
    }
    getCapabilities() {
        return {
            tools: this.tools.map((t) => ({
                name: t.name,
                description: t.description,
                requiredParams: t.inputSchema?.required || [],
            })),
            coordinateSystem: '[0-1000] x [0-1000] normalized',
            toolChains: Array.from(this._toolChains.keys()),
            traceEnabled: true,
        };
    }
    actionResultToMCP(result) {
        if (result.success) {
            const content = [];
            if (result.output) {
                content.push({ type: 'text', text: result.output });
            }
            if (result.observation) {
                content.push({
                    type: 'text',
                    text: JSON.stringify(result.observation, null, 2),
                });
            }
            if (content.length === 0) {
                content.push({ type: 'text', text: '操作成功' });
            }
            return { content };
        }
        else {
            return {
                content: [
                    {
                        type: 'text',
                        text: result.error || '操作失败',
                    },
                ],
                isError: true,
            };
        }
    }
    ensureInitialized() {
        if (!this.initialized) {
            throw new Error('DesktopMCPServer 未初始化，请先调用 initialize()');
        }
    }
    async shutdown() {
        if (this.executor) {
            await this.executor.shutdown();
        }
        this.initialized = false;
        Logger_1.Logger.info('🔧 DesktopMCP Server 已关闭', 'DesktopMCP');
    }
}
exports.DesktopMCPServer = DesktopMCPServer;
DesktopMCPServer.instance = null;
let _desktopMCPServerInstance = null;
function getDesktopMCPServer() {
    if (!_desktopMCPServerInstance) {
        _desktopMCPServerInstance = DesktopMCPServer.getInstance();
    }
    return _desktopMCPServerInstance;
}
exports.desktopMCPServer = { get instance() { return getDesktopMCPServer(); } };
exports.default = DesktopMCPServer;
