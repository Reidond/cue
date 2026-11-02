# Puts appointments into Windows' appointment store (the calendar Cue for Windows reads), in a calendar of its own called "Cue e2e", and takes them out again.
# A program with no package identity may create such an app calendar and may read every calendar, which is all Cue does. Prints "ok", or "unavailable: WHY" when
# this PC has no calendar service to ask, which is a case's cue to skip.
#
#   powershell -File appointments.ps1 add FILE.json     # [{ "subject", "start" (ISO 8601), "minutes", "location", "details", "daily": true|false }]
#   powershell -File appointments.ps1 remove
param([Parameter(Mandatory = $true)][ValidateSet('add', 'remove')][string]$Action, [string]$File)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.ApplicationModel.Appointments.AppointmentManager, Windows.ApplicationModel.Appointments, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
$asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
function Await($operation, $type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
    if (-not $task.Wait(30000)) { throw 'the calendar service did not answer' }
    if ($task.IsFaulted) { throw $task.Exception.InnerException }
    $task.Result
}
function AwaitAction($operation) {
    $task = $asTaskAction.Invoke($null, @($operation))
    if (-not $task.Wait(30000)) { throw 'the calendar service did not answer' }
    if ($task.IsFaulted) { throw $task.Exception.InnerException }
}

try {
    $readWrite = Await ([Windows.ApplicationModel.Appointments.AppointmentManager]::RequestStoreAsync([Windows.ApplicationModel.Appointments.AppointmentStoreAccessType]::AppCalendarsReadWrite)) ([Windows.ApplicationModel.Appointments.AppointmentStore])
    $readAll = Await ([Windows.ApplicationModel.Appointments.AppointmentManager]::RequestStoreAsync([Windows.ApplicationModel.Appointments.AppointmentStoreAccessType]::AllCalendarsReadOnly)) ([Windows.ApplicationModel.Appointments.AppointmentStore])
    if ($null -eq $readWrite -or $null -eq $readAll) { throw 'access to the calendar was not given' }
    # The calendars of this name, whoever made them (a case that was cut short leaves one behind).
    $all = Await ($readAll.FindAppointmentCalendarsAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.ApplicationModel.Appointments.AppointmentCalendar]])
    foreach ($calendar in $all) {
        if ($calendar.DisplayName -eq 'Cue e2e') {
            $own = Await ($readWrite.GetAppointmentCalendarAsync($calendar.LocalId)) ([Windows.ApplicationModel.Appointments.AppointmentCalendar])
            AwaitAction ($own.DeleteAsync())
        }
    }
    if ($Action -eq 'add') {
        $calendar = Await ($readWrite.CreateAppointmentCalendarAsync('Cue e2e')) ([Windows.ApplicationModel.Appointments.AppointmentCalendar])
        $calendar.OtherAppReadAccess = [Windows.ApplicationModel.Appointments.AppointmentCalendarOtherAppReadAccess]::Full
        AwaitAction ($calendar.SaveAsync())
        foreach ($item in (Get-Content -Raw -Encoding UTF8 $File | ConvertFrom-Json)) {
            $appointment = New-Object Windows.ApplicationModel.Appointments.Appointment
            $appointment.Subject = $item.subject
            $appointment.StartTime = [DateTimeOffset]::Parse($item.start)
            $appointment.Duration = [TimeSpan]::FromMinutes([int]$item.minutes)
            if ($item.location) { $appointment.Location = $item.location }
            if ($item.details) { $appointment.Details = $item.details }
            if ($item.daily) {
                $recurrence = New-Object Windows.ApplicationModel.Appointments.AppointmentRecurrence
                $recurrence.Unit = [Windows.ApplicationModel.Appointments.AppointmentRecurrenceUnit]::Daily
                $recurrence.Interval = 1
                $appointment.Recurrence = $recurrence
            }
            AwaitAction ($calendar.SaveAppointmentAsync($appointment))
        }
    }
    'ok'
} catch {
    'unavailable: ' + $_.Exception.Message
}
