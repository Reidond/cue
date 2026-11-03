# Where the named controls of one of a program's windows are, as Windows' UI Automation has them (the layout twin of uia.ps1): a JSON array of
# {name, type, left, top, width, height}, in the screen's own pixels, in the order the tree has them, for the window of the process with this ID and title.
#
#   powershell -File uia-bounds.ps1 PID TITLE
param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$Title
)

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Pixels as Windows has them, not as a program that knows nothing of the screen's scale would be told.
Add-Type -Name Dpi -Namespace Cue -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][Cue.Dpi]::SetProcessDPIAware()

$root = [System.Windows.Automation.AutomationElement]::RootElement
$mine = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcessId)
$found = @()
foreach ($window in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $mine)) {
    if ($window.Current.Name -ne $Title) { continue }
    foreach ($element in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
        $name = $element.Current.Name
        $box = $element.Current.BoundingRectangle
        if (-not $name -or $box.IsEmpty) { continue }
        $found += [pscustomobject]@{
            name = $name
            type = $element.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
            left = [int]$box.X
            top = [int]$box.Y
            width = [int]$box.Width
            height = [int]$box.Height
        }
    }
}
ConvertTo-Json -InputObject @($found) -Compress
