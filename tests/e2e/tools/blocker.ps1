# A plain full-screen window of another program that takes the focus and stays up until its process is ended: what Cue's overlay must float over without
# taking the focus from. It is covered in text, so a screen capture of the place the overlay is in tells whether the overlay was in it.
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Cue test window'
$form.WindowState = 'Maximized'
$form.BackColor = 'White'
$label = New-Object System.Windows.Forms.Label
$label.Dock = 'Fill'
$label.Font = New-Object System.Drawing.Font('Segoe UI', 36)
# Lines long enough to reach across any screen, so wherever the overlay is, the text is behind it.
$label.Text = (1..40 | ForEach-Object { ('Blocker window text   ' * 12).Trim() }) -join "`n"
$form.Controls.Add($label)
$form.Add_Shown({
    # Windows lets a program take the focus only if it was given it: a key press (Alt, which does nothing to a window without a menu) is what a person gives,
    # and raising the window as the top-most one and back finishes it.
    [System.Windows.Forms.SendKeys]::SendWait('%')
    $form.TopMost = $true
    $form.TopMost = $false
    $form.Activate()
})
[System.Windows.Forms.Application]::Run($form)
