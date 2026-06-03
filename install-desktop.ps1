# Jiabaixing - Create desktop shortcut
$WshShell = New-Object -ComObject WScript.Shell
$DesktopPath = [Environment]::GetFolderPath("Desktop")
$ProjectPath = "C:\zy\jiabaixing"

# Remove old shortcut if exists
$old = "$DesktopPath\jiabaixing.lnk"
if (Test-Path $old) { Remove-Item $old }

$Shortcut = $WshShell.CreateShortcut($old)
$Shortcut.TargetPath = "$ProjectPath\jiabaixing.bat"
$Shortcut.WorkingDirectory = $ProjectPath
$Shortcut.Description = "Jiabaixing V5.0 - AI Agent Framework"
$Shortcut.IconLocation = "%SystemRoot%\System32\imageres.dll,179"
$Shortcut.Save()

Write-Host "Shortcut created: $old"
