# The text of a program's windows, as Windows' UI Automation (what a screen reader reads) has it, the Windows twin of reading a snapshot: one line per
# element that has a name or a value, in the order the tree has them, for the process with this ID. It needs nothing drawn, so it works for a window kept
# behind others, and it has what is scrolled out of view too.
#
#   powershell -File uia.ps1 PID
param([Parameter(Mandatory = $true)][int]$ProcessId)

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = [System.Windows.Automation.AutomationElement]::RootElement
$mine = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcessId)
foreach ($window in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $mine)) {
    foreach ($element in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
        $name = $element.Current.Name
        if ($name) { [Console]::Out.WriteLine($name) }
        $value = $null
        $pattern = $null
        if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { $value = $pattern.Current.Value }
        if ($value -and $value -ne $name) { [Console]::Out.WriteLine($value) }
        # A WinUI combo box has no value, only its selection: the item it shows is what a screen reader reads after its name.
        if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::ComboBox -and $element.TryGetCurrentPattern([System.Windows.Automation.SelectionPattern]::Pattern, [ref]$pattern)) {
            foreach ($chosen in $pattern.Current.GetSelection()) {
                $shown = $chosen.Current.Name
                if ($shown -and $shown -ne $name) { [Console]::Out.WriteLine($shown) }
            }
        }
    }
}
