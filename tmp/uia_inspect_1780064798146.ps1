
Add-Type -AssemblyName UIAutomationClient
$automation = [System.Windows.Automation.AutomationElement]::RootElement

function Build-Tree {
  param($element, $depth = 0)
  if ($depth -gt 8) { return $null }

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
