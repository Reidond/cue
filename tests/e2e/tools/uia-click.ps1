# Presses a control of a program's windows by its name, as a click would, through Windows' UI Automation (the twin of reading the same tree with uia.ps1):
# a button is invoked, a toggle is toggled, a text box gets the text. With -Mouse it is a real click instead: the pointer moves to the middle of the control and
# the left button goes down and up, as a hand's would (so a window that must not take the focus has the chance to). Prints "ok" once, or "missing" when nothing
# in the program has that name.
#
#   powershell -File uia-click.ps1 PID NAME [TEXT] [-Mouse]
param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$Text,
    [switch]$Mouse
)

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

# Pixels as Windows has them, not as a program that knows nothing of the screen's scale would be told.
Add-Type -Name Dpi -Namespace Cue -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][Cue.Dpi]::SetProcessDPIAware()
Add-Type -Name Pointer -Namespace Cue -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
'@

$root = [System.Windows.Automation.AutomationElement]::RootElement
$mine = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcessId)
$named = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $Name)
foreach ($window in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $mine)) {
    $element = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $named)
    if ($null -eq $element) { continue }
    $pattern = $null
    if ($Mouse) {
        $box = $element.Current.BoundingRectangle
        [void][Cue.Pointer]::SetCursorPos([int]($box.X + $box.Width / 2), [int]($box.Y + $box.Height / 2))
        Start-Sleep -Milliseconds 150
        [Cue.Pointer]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 60
        [Cue.Pointer]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero)
    } elseif ($PSBoundParameters.ContainsKey('Text') -and $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
        $pattern.SetValue($Text)
    } elseif ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        $pattern.Invoke()
    } elseif ($element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) {
        $pattern.Toggle()
    } else {
        continue
    }
    'ok'
    return
}
'missing'
