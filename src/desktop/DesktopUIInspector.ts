import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/Logger';
import { UIElementParser } from './ui/UIElementParser';
import {
  UIElement,
  UIElementNode,
  ElementQueryResult,
  UIInspectorConfig,
} from './ui/types';

export {
  UIAControlType,
  UIElement,
  UIElementNode,
  ElementQueryResult,
  UIInspectorConfig,
} from './ui/types';

export class DesktopUIInspector {
  private static instance: DesktopUIInspector | null = null;
  private initialized: boolean = false;
  private config: UIInspectorConfig;
  private parser: UIElementParser;

  private constructor(config?: UIInspectorConfig) {
    this.config = {
      maxDepth: config?.maxDepth ?? 8,
      includeInvisible: config?.includeInvisible ?? false,
      minSize: config?.minSize ?? 4,
      timeoutMs: config?.timeoutMs ?? 15000,
    };
    this.parser = UIElementParser.getInstance();
  }

  public static getInstance(config?: UIInspectorConfig): DesktopUIInspector {
    if (!DesktopUIInspector.instance) {
      DesktopUIInspector.instance = new DesktopUIInspector(config);
    }
    return DesktopUIInspector.instance;
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    Logger.info('🔍 DesktopUIInspector 初始化', 'DesktopUIInspector');
    this.initialized = true;
  }

  public getInteractiveElements(): UIElement[] {
    return this.inspectDesktop();
  }

  public getWindowElements(windowTitle: string): UIElement[] {
    return this.inspectWindow(windowTitle);
  }

  public findElement(description: string): ElementQueryResult {
    const allElements = this.getInteractiveElements();
    return this.parser.findElement(description, allElements);
  }

  /**
   * 按描述查找UI元素，返回单个元素或null
   * 供 DesktopActionExecutor 的 clickElement/typeIntoElement/getElementText 使用
   */
  public findElementByDescription(description: string): UIElement | null {
    const result = this.findElement(description);
    if (result.success && result.elements.length > 0) {
      return result.elements[0];
    }
    const allElements = this.getInteractiveElements();
    const lower = description.toLowerCase();
    const interactiveElements = allElements.filter(
      (e) => e.isClickable || e.isEditable || e.controlTypeName === 'Edit' || e.controlTypeName === 'Button'
    );
    const byName = interactiveElements.find(
      (e) =>
        e.name &&
        (e.name.toLowerCase().includes(lower) || lower.includes(e.name.toLowerCase()))
    );
    if (byName) return byName;
    return null;
  }

  public getControlTree(): UIElementNode[] {
    try {
      const json = this.runUIAScript(this.buildTreeScript());
      return this.parser.parseTreeNodes(json);
    } catch (error) {
      Logger.error('❌ 获取控件树失败', error as Error, 'DesktopUIInspector');
      return [];
    }
  }

  public getFocusedElement(): UIElement | null {
    try {
      const json = this.runUIAScript(this.buildFocusedElementScript());
      const elements = this.parser.parseElements(json);
      return elements.length > 0 ? elements[0] : null;
    } catch (error) {
      Logger.error('❌ 获取焦点控件失败', error as Error, 'DesktopUIInspector');
      return null;
    }
  }

  public getElementAtCursor(): UIElement | null {
    try {
      const json = this.runUIAScript(this.buildCursorElementScript());
      const elements = this.parser.parseElements(json);
      return elements.length > 0 ? elements[0] : null;
    } catch (error) {
      Logger.error(
        '❌ 获取光标下控件失败',
        error as Error,
        'DesktopUIInspector'
      );
      return null;
    }
  }

  public generateElementReport(elements?: UIElement[]): string {
    const elems = elements || this.getInteractiveElements();
    return this.parser.generateElementReport(elems);
  }

  private inspectDesktop(): UIElement[] {
    try {
      const json = this.runUIAScript(this.buildDesktopScript());
      return this.parser.parseElements(json);
    } catch (error) {
      Logger.error('❌ 桌面检查失败', error as Error, 'DesktopUIInspector');
      return [];
    }
  }

  private inspectWindow(windowTitle: string): UIElement[] {
    try {
      const json = this.runUIAScript(this.buildWindowScript(windowTitle));
      return this.parser.parseElements(json);
    } catch (error) {
      Logger.error(
        `❌ 窗口检查失败: ${windowTitle}`,
        error as Error,
        'DesktopUIInspector'
      );
      return [];
    }
  }

  private runUIAScript(script: string): string {
    const tmpDir = path.join(process.cwd(), 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `uia_inspect_${Date.now()}.ps1`);

    fs.writeFileSync(tmpFile, script, 'utf8');

    try {
      const result = execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`,
        {
          encoding: 'utf-8',
          timeout: this.config.timeoutMs,
          maxBuffer: 50 * 1024 * 1024,
        }
      );
      return result;
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // ignore cleanup error
      }
    }
  }

  private buildDesktopScript(): string {
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
  $controlType = [int]$element.Current.ControlType.ProgrammaticName.Split(".")[-1]

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

  private buildWindowScript(windowTitle: string): string {
    return `
Add-Type -AssemblyName UIAutomationClient
$automation = [System.Windows.Automation.AutomationElement]::RootElement

$condition = [System.Windows.Automation.PropertyCondition]::new(
  [System.Windows.Automation.AutomationElement]::NameProperty,
  "${windowTitle.replace(/"/g, '`"')}"
)
$window = $automation.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)

if (-not $window) {
  $windows = $automation.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  for ($i = 0; $i -lt $windows.Count; $i++) {
    if ($windows[$i].Current.Name -like "*${windowTitle.replace(/"/g, '`"')}*") {
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
  $controlType = [int]$element.Current.ControlType.ProgrammaticName.Split(".")[-1]

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

  private buildTreeScript(): string {
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

  $controlType = [int]$element.Current.ControlType.ProgrammaticName.Split(".")[-1]

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

  private buildFocusedElementScript(): string {
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

$controlType = [int]$focused.Current.ControlType.ProgrammaticName.Split(".")[-1]

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

  private buildCursorElementScript(): string {
    return `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Automation;
public class CursorUIA {
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
  public struct POINT { public int X; public int Y; }
  public static AutomationElement GetElementAtCursor() {
    POINT pt;
    GetCursorPos(out pt);
    return AutomationElement.FromPoint(new System.Windows.Point(pt.X, pt.Y));
  }
}
"@

$element = [CursorUIA]::GetElementAtCursor()
if (-not $element) { Write-Output "[]"; exit }

$rect = $element.Current.BoundingRectangle
$pattern = $null
$isClickable = [System.Windows.Automation.PatternIdentifiers]::InvokePattern -and
  $element.TryGetCurrentPattern([System.Windows.Automation.PatternIdentifiers]::InvokePattern, [ref]$pattern)

$valuePattern = $null
$isEditable = $element.TryGetCurrentPattern([System.Windows.Automation.PatternIdentifiers]::ValuePattern, [ref]$valuePattern)

$controlType = [int]$element.Current.ControlType.ProgrammaticName.Split(".")[-1]

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

  public async shutdown(): Promise<void> {
    this.initialized = false;
    Logger.info('🔍 DesktopUIInspector 已关闭', 'DesktopUIInspector');
  }
}

export default DesktopUIInspector;
