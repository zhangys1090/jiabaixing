try {
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class WAPIS {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
}
"@

$h = [WAPIS]::GetForegroundWindow()
$s = New-Object Text.StringBuilder 256
[void][WAPIS]::GetWindowText($h, $s, 256)
$p = [uint32]0
[void][WAPIS]::GetWindowThreadProcessId($h, [ref]$p)
$n = (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName
Write-Output "$n|$($s.ToString())"
} catch {
    Write-Output "Unknown|Foreground window detection failed"
}
