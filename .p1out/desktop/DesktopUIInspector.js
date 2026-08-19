"use strict";
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
exports.DesktopUIInspector = exports.UIAControlType = void 0;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const Logger_1 = require("../utils/Logger");
const UIElementParser_1 = require("./ui/UIElementParser");
const SystemInput_1 = require("./SystemInput");
var types_1 = require("./ui/types");
Object.defineProperty(exports, "UIAControlType", { enumerable: true, get: function () { return types_1.UIAControlType; } });
class DesktopUIInspector {
    constructor(config) {
        this.initialized = false;
        this.config = {
            maxDepth: config?.maxDepth ?? 8,
            includeInvisible: config?.includeInvisible ?? false,
            minSize: config?.minSize ?? 4,
            timeoutMs: config?.timeoutMs ?? 15000,
        };
        this.parser = UIElementParser_1.UIElementParser.getInstance();
    }
    static getInstance(config) {
        if (!DesktopUIInspector.instance) {
            DesktopUIInspector.instance = new DesktopUIInspector(config);
        }
        return DesktopUIInspector.instance;
    }
    async initialize() {
        if (this.initialized)
            return;
        Logger_1.Logger.info('🔍 DesktopUIInspector 初始化', 'DesktopUIInspector');
        this.initialized = true;
    }
    async getInteractiveElements() {
        return this.inspectDesktop();
    }
    async getWindowElements(windowTitle) {
        return this.inspectWindow(windowTitle);
    }
    async findElement(description) {
        const allElements = await this.getInteractiveElements();
        return this.parser.findElement(description, allElements);
    }
    async findElementByDescription(description) {
        const result = await this.findElement(description);
        if (result.success && result.elements.length > 0) {
            return result.elements[0];
        }
        const allElements = await this.getInteractiveElements();
        const lower = description.toLowerCase();
        const interactiveElements = allElements.filter((e) => e.isClickable ||
            e.isEditable ||
            e.controlTypeName === 'Edit' ||
            e.controlTypeName === 'Button');
        const byName = interactiveElements.find((e) => e.name &&
            (e.name.toLowerCase().includes(lower) ||
                lower.includes(e.name.toLowerCase())));
        if (byName)
            return byName;
        return null;
    }
    async getControlTree() {
        try {
            const json = await this.runUIAScript(this.buildTreeScript());
            return this.parser.parseTreeNodes(json);
        }
        catch (error) {
            Logger_1.Logger.error('❌ 获取控件树失败', error, 'DesktopUIInspector');
            return [];
        }
    }
    async getFocusedElement() {
        try {
            const json = await this.runUIAScript(this.buildFocusedElementScript());
            const elements = this.parser.parseElements(json);
            return elements.length > 0 ? elements[0] : null;
        }
        catch (error) {
            Logger_1.Logger.error('❌ 获取焦点控件失败', error, 'DesktopUIInspector');
            return null;
        }
    }
    async getElementAtCursor() {
        try {
            const json = await this.runUIAScript(this.buildCursorElementScript());
            const elements = this.parser.parseElements(json);
            return elements.length > 0 ? elements[0] : null;
        }
        catch (error) {
            Logger_1.Logger.error('❌ 获取光标下控件失败', error, 'DesktopUIInspector');
            return null;
        }
    }
    async generateElementReport(elements) {
        const elems = elements || await this.getInteractiveElements();
        return this.parser.generateElementReport(elems);
    }
    async inspectDesktop() {
        try {
            const json = await this.runUIAScript(this.buildDesktopScript());
            return this.parser.parseElements(json);
        }
        catch (error) {
            Logger_1.Logger.error('❌ 桌面检查失败', error, 'DesktopUIInspector');
            return [];
        }
    }
    async inspectWindow(windowTitle) {
        try {
            const json = await this.runUIAScript(this.buildWindowScript(windowTitle));
            return this.parser.parseElements(json);
        }
        catch (error) {
            Logger_1.Logger.error(`❌ 窗口检查失败: ${windowTitle}`, error, 'DesktopUIInspector');
            return [];
        }
    }
    async runUIAScript(script) {
        try {
            const systemInput = SystemInput_1.SystemInput.getInstance();
            await systemInput.initialize();
            const uiaHeader = systemInput._ensureType('UIAutomationClient', 'Add-Type -AssemblyName UIAutomationClient');
            const fullScript = `${uiaHeader}\n${script.replace(/^Add-Type -AssemblyName UIAutomationClient\r?\n?/m, '')}`;
            const result = await systemInput.executePs(fullScript, this.config.timeoutMs);
            return result;
        }
        catch (err) {
            Logger_1.Logger.warn(`⚠️ 常驻PS执行UIA脚本失败，降级临时文件: ${err.message}`, 'DesktopUIInspector');
            const tmpDir = path.join(process.cwd(), 'tmp');
            if (!fs.existsSync(tmpDir))
                fs.mkdirSync(tmpDir, { recursive: true });
            const tmpFile = path.join(tmpDir, `uia_inspect_${Date.now()}.ps1`);
            fs.writeFileSync(tmpFile, script, 'utf8');
            try {
                const result = (0, child_process_1.execSync)(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`, {
                    encoding: 'utf-8',
                    timeout: this.config.timeoutMs,
                    maxBuffer: 50 * 1024 * 1024,
                });
                return result;
            }
            finally {
                try {
                    fs.unlinkSync(tmpFile);
                }
                catch {
                    // ignore cleanup error
                }
            }
        }
    }
    buildDesktopScript() {
        return `
Add-Type -AssemblyName UIAutomationClient
$automation = [System.Windows.Automation.AutomationElement]::RootElement

function Get-ElementInfo {
  param($element, $depth = 0, $path = "")
  if ($depth -gt ${this.config.maxDepth}) { return @() }

  $rect = $element.Current.BoundingRectangle
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top

  if ($width -lt ${this.config.minSize} -or $height -lt ${this.config.minSize}) { return @() }

  $isVisible = $element.Current.IsOffscreen -eq $false
  if (-not $isVisible -and -not $${this.config.includeInvisible}) { return @() }

  $pattern = $null
  $isClickable = [System.Windows.Automation.PatternIdentifiers]::InvokePattern -and
    $element.TryGetCurrentPattern([System.Windows.Automation.PatternIdentifiers]::InvokePattern, [ref]$pattern)

  $valuePattern = $null
  $isEditable = $element.TryGetCurrentPattern([System.Windows.Automation.PatternIdentifiers]::ValuePattern, [ref]$valuePattern)

  $name = $element.Current.Name
  $controlType = $element.Current.ControlType.Id

  # 只收集有名称或可交互的控件
  if (-not $name -and -not $isClickable -and -not $isEditable) {
    # 继续遍历子元素
  }

  $info = @{
    name = $name
    automationId = $element.Current.AutomationId
    controlType = $controlType
    className = $element.Current.ClassName
    processName = $element.Current.ProcessId
    windowTitle = $automation.Current.Name
    x = $rect.Left
    y = $rect.Top
    width = $width
    height = $height
    isClickable = [bool]$isClickable
    isEditable = [bool]$isEditable
    isVisible = $isVisible
    isEnabled = $element.Current.IsEnabled
    hasKeyboardFocus = $element.Current.HasKeyboardFocus
    helpText = $element.Current.HelpText
    depth = $depth
    path = $path
    childCount = $element.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition).Count
  }

  $results = @($info)

  $children = $element.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  for ($i = 0; $i -lt $children.Count; $i++) {
    $childPath = if ($path) { "$path > $($name)[$i]" } else { "$($name)[$i]" }
    $results += Get-ElementInfo -element $children[$i] -depth ($depth + 1) -path $childPath
  }

  return $results
}

$allElements = Get-ElementInfo -element $automation -depth 0 -path "Desktop"
$allElements | ConvertTo-Json -Compress -Depth 10
`;
    }
    buildWindowScript(windowTitle) {
        const safeTitle = (windowTitle || '').replace(/'/g, "''").replace(/"/g, '""');
        return `
Add-Type -AssemblyName UIAutomationClient
$automation = [System.Windows.Automation.AutomationElement]::RootElement

$searchTitle = '${safeTitle}'
$condition = [System.Windows.Automation.PropertyCondition]::new(
  [System.Windows.Automation.AutomationElement]::NameProperty,
  $searchTitle
)
$window = $automation.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)

if (-not $window) {
  $windows = $automation.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  for ($i = 0; $i -lt $windows.Count; $i++) {
    if ($windows[$i].Current.Name -like "*$searchTitle*") {
      $window = $windows[$i]
      break
    }
  }
}

if (-not $window) {
  Write-Output "[]"
  exit
}

function Get-ElementInfo {
  param($element, $depth = 0, $path = "")
  if ($depth -gt ${this.config.maxDepth}) { return @() }

  $rect = $element.Current.BoundingRectangle
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top

  if ($width -lt ${this.config.minSize} -or $height -lt ${this.config.minSize}) { return @() }

  $isVisible = $element.Current.IsOffscreen -eq $false

  $pattern = $null
  $isClickable = [System.Windows.Automation.PatternIdentifiers]::InvokePattern -and
    $element.TryGetCurrentPattern([System.Windows.Automation.PatternIdentifiers]::InvokePattern, [ref]$pattern)

  $valuePattern = $null
  $isEditable = $element.TryGetCurrentPattern([System.Windows.Automation.PatternIdentifiers]::ValuePattern, [ref]$valuePattern)

  $name = $element.Current.Name
  $controlType = $element.Current.ControlType.Id

  $info = @{
    name = $name
    automationId = $element.Current.AutomationId
    controlType = $controlType
    className = $element.Current.ClassName
    processName = $element.Current.ProcessId
    windowTitle = $window.Current.Name
    x = $rect.Left
    y = $rect.Top
    width = $width
    height = $height
    isClickable = [bool]$isClickable
    isEditable = [bool]$isEditable
    isVisible = $isVisible
    isEnabled = $element.Current.IsEnabled
    hasKeyboardFocus = $element.Current.HasKeyboardFocus
    helpText = $element.Current.HelpText
    depth = $depth
    path = $path
    childCount = $element.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition).Count
  }

  $results = @($info)

  $children = $element.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  for ($i = 0; $i -lt $children.Count; $i++) {
    $childPath = if ($path) { "$path > $($name)[$i]" } else { "$($name)[$i]" }
    $results += Get-ElementInfo -element $children[$i] -depth ($depth + 1) -path $childPath
  }

  return $results
}

$allElements = Get-ElementInfo -element $window -depth 0 -path "$($window.Current.Name)"
$allElements | ConvertTo-Json -Compress -Depth 10
`;
    }
    buildTreeScript() {
        return `
Add-Type -AssemblyName UIAutomationClient
$automation = [System.Windows.Automation.AutomationElement]::RootElement

function Build-Tree {
  param($element, $depth = 0)
  if ($depth -gt ${this.config.maxDepth}) { return $null }

  $rect = $element.Current.BoundingRectangle
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top

  $isVisible = $element.Current.IsOffscreen -eq $false

  $pattern = $null
  $isClickable = [System.Windows.Automation.PatternIdentifiers]::InvokePattern -and
    $element.TryGetCurrentPattern([System.Windows.Automation.PatternIdentifiers]::InvokePattern, [ref]$pattern)

  $valuePattern = $null
  $isEditable = $element.TryGetCurrentPattern([System.Windows.Automation.PatternIdentifiers]::ValuePattern, [ref]$valuePattern)

  $controlType = $element.Current.ControlType.Id

  $node = @{
    name = $element.Current.Name
    automationId = $element.Current.AutomationId
    controlType = $controlType
    className = $element.Current.ClassName
    processName = $element.Current.ProcessId
    windowTitle = $automation.Current.Name
    x = $rect.Left
    y = $rect.Top
    width = $width
    height = $height
    isClickable = [bool]$isClickable
    isEditable = [bool]$isEditable
    isVisible = $isVisible
    isEnabled = $element.Current.IsEnabled
    hasKeyboardFocus = $element.Current.HasKeyboardFocus
    helpText = $element.Current.HelpText
    depth = $depth
    path = ""
    childCount = 0
    children = @()
  }

  $children = $element.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  $childNodes = @()
  for ($i = 0; $i -lt $children.Count; $i++) {
    $child = Build-Tree -element $children[$i] -depth ($depth + 1)
    if ($child) { $childNodes += $child }
  }
  $node.children = $childNodes
  $node.childCount = $childNodes.Count

  return $node
}

$tree = Build-Tree -element $automation -depth 0
if ($tree) {
  ConvertTo-Json -InputObject $tree -Compress -Depth 10
} else {
  "[]"
}
`;
    }
    buildFocusedElementScript() {
        return `
Add-Type -AssemblyName UIAutomationClient
$automation = [System.Windows.Automation.AutomationElement]::RootElement
$focused = [System.Windows.Automation.AutomationElement]::FocusedElement

if (-not $focused) { Write-Output "[]"; exit }

$rect = $focused.Current.BoundingRectangle
$pattern = $null
$isClickable = [System.Windows.Automation.PatternIdentifiers]::InvokePattern -and
  $focused.TryGetCurrentPattern([System.Windows.Automation.PatternIdentifiers]::InvokePattern, [ref]$pattern)

$valuePattern = $null
$isEditable = $focused.TryGetCurrentPattern([System.Windows.Automation.PatternIdentifiers]::ValuePattern, [ref]$valuePattern)

$controlType = $focused.Current.ControlType.Id

$info = @{
  name = $focused.Current.Name
  automationId = $focused.Current.AutomationId
  controlType = $controlType
  className = $focused.Current.ClassName
  processName = $focused.Current.ProcessId
  windowTitle = $automation.Current.Name
  x = $rect.Left
  y = $rect.Top
  width = $rect.Right - $rect.Left
  height = $rect.Bottom - $rect.Top
  isClickable = [bool]$isClickable
  isEditable = [bool]$isEditable
  isVisible = $focused.Current.IsOffscreen -eq $false
  isEnabled = $focused.Current.IsEnabled
  hasKeyboardFocus = $focused.Current.HasKeyboardFocus
  helpText = $focused.Current.HelpText
  depth = 0
  path = ""
  childCount = 0
}

ConvertTo-Json -InputObject @($info) -Compress
`;
    }
    buildCursorElementScript() {
        const systemInput = SystemInput_1.SystemInput.getInstance();
        const typeDef = systemInput._ensureType('CursorHelper', `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CursorHelper {
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
  public struct POINT { public int X; public int Y; }
}
"@`);
        return `
${typeDef}
$pt = New-Object CursorHelper+POINT
[CursorHelper]::GetCursorPos([ref]$pt) | Out-Null
$element = [System.Windows.Automation.AutomationElement]::FromPoint([System.Windows.Point]::new($pt.X, $pt.Y))
if (-not $element) { Write-Output "[]"; exit }

$rect = $element.Current.BoundingRectangle
$pattern = $null
$isClickable = [System.Windows.Automation.PatternIdentifiers]::InvokePattern -and
  $element.TryGetCurrentPattern([System.Windows.Automation.PatternIdentifiers]::InvokePattern, [ref]$pattern)

$valuePattern = $null
$isEditable = $element.TryGetCurrentPattern([System.Windows.Automation.PatternIdentifiers]::ValuePattern, [ref]$valuePattern)

$controlType = $element.Current.ControlType.Id

$info = @{
  name = $element.Current.Name
  automationId = $element.Current.AutomationId
  controlType = $controlType
  className = $element.Current.ClassName
  processName = $element.Current.ProcessId
  windowTitle = ""
  x = $rect.Left
  y = $rect.Top
  width = $rect.Right - $rect.Left
  height = $rect.Bottom - $rect.Top
  isClickable = [bool]$isClickable
  isEditable = [bool]$isEditable
  isVisible = $element.Current.IsOffscreen -eq $false
  isEnabled = $element.Current.IsEnabled
  hasKeyboardFocus = $element.Current.HasKeyboardFocus
  helpText = $element.Current.HelpText
  depth = 0
  path = ""
  childCount = 0
}

ConvertTo-Json -InputObject @($info) -Compress
`;
    }
    async shutdown() {
        this.initialized = false;
        Logger_1.Logger.info('🔍 DesktopUIInspector 已关闭', 'DesktopUIInspector');
    }
}
exports.DesktopUIInspector = DesktopUIInspector;
DesktopUIInspector.instance = null;
exports.default = DesktopUIInspector;
