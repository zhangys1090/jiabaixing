
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
