using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Windows.AppNotifications;
using Microsoft.Windows.AppNotifications.Builder;

namespace Cue;

/// <summary>
/// Windows notifications (toasts) with Record / Not Now, and notices. Every one is written to the session log; under CUE_CONTROL they go only there, and the
/// case answers through the control file (unless CUE_SYSTEM_NOTIFICATIONS=1 asks for the real ones as well). The toasts are the Windows App SDK's `AppNotificationManager`, registered at run time (`Register`), which works
/// for a program that is not packaged: the installer needs no more than the program itself. The Mac's `MeetingNotifier`.
/// </summary>
public sealed class MeetingNotifier : IDisposable
{
    private readonly AppState state;
    private readonly AppNotificationManager? manager;

    public MeetingNotifier(AppState state)
    {
        this.state = state;
        // CUE_SYSTEM_NOTIFICATIONS=1: a case that clicks the real notification (the harness always sets CUE_CONTROL).
        if (Env.Get("CUE_CONTROL") is not null && Env.Get("CUE_SYSTEM_NOTIFICATIONS") != "1") return;
        try
        {
            var made = AppNotificationManager.Default;
            made.NotificationInvoked += Invoked;
            made.Register();
            manager = made;
        }
        catch (Exception e) when (e is COMException or InvalidOperationException or ArgumentException or FileNotFoundException)
        {
            state.Log.Write($"{SessionLog.Warning} Notifications unavailable: {e.Message}");
        }
    }

    /// <summary>The answer to a prompt: its key and whether to record. Run on the UI thread.</summary>
    public Action<string, bool> OnAnswer { get; init; } = (_, _) => { };

    /// <summary>A note's notification was clicked. Run on the UI thread.</summary>
    public Action<string> OnOpenNote { get; init; } = _ => { };

    private SessionLog Log => state.Log;

    public void Ask(MeetingMonitor.Call call, string detail)
    {
        Log.Write($"🔔 Record “{call.Title}”?");
        Show($"Record “{call.Title}”?", detail, tag: Tag(call.Key), prompt: call.Key);
    }

    public void Withdraw(string key)
    {
        if (manager is not { } shown) return;
        _ = Remove(shown, Tag(key));
    }

    public void NotesReady(string title, string note)
    {
        Log.Write($"🔔 Notes from “{title}” are ready");
        Show("Notes Ready", title, tag: Tag($"notes:{note}"), note: note);
    }

    public void NothingRecorded(string title)
    {
        Log.Write($"🔔 Nothing was recorded in “{title}”");
        Show("Nothing Was Recorded", $"Cue didn’t hear any speech in “{title}”, so no notes were saved.", tag: Tag($"empty:{title}"));
    }

    /// <summary>A notification's tag is what withdraws it, and has a length limit: a short name for the key.</summary>
    private static string Tag(string key) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..24];

    private void Show(string title, string body, string tag, string? prompt = null, string? note = null)
    {
        if (manager is not { } shown) return;
        try
        {
            var toast = new AppNotificationBuilder().AddText(title).AddText(body);
            // Clicking the prompt itself means Record, as on the Mac; its buttons say so too.
            if (prompt is not null)
            {
                toast.AddArgument("key", prompt)
                    .AddButton(new AppNotificationButton("Record").AddArgument("key", prompt).AddArgument("action", "record"))
                    .AddButton(new AppNotificationButton("Not Now").AddArgument("key", prompt).AddArgument("action", "dismiss"));
            }
            if (note is not null) toast.AddArgument("note", note);
            var built = toast.BuildNotification();
            built.Tag = tag;
            shown.Show(built);
        }
        catch (Exception e) when (e is COMException or InvalidOperationException or ArgumentException)
        {
            Log.Write($"{SessionLog.Warning} Couldn't show a notification: {e.Message}");
        }
    }

    private static async Task Remove(AppNotificationManager manager, string tag)
    {
        try
        {
            await manager.RemoveByTagAsync(tag);
        }
        catch (Exception e) when (e is COMException or InvalidOperationException)
        {
        }
    }

    /// <summary>A button or the notification itself was pressed (on a thread of the system's).</summary>
    private void Invoked(AppNotificationManager sender, AppNotificationActivatedEventArgs args)
    {
        var values = args.Arguments;
        if (values.TryGetValue("note", out var note))
        {
            state.Queue.TryEnqueue(() => OnOpenNote(note));
        }
        else if (values.TryGetValue("key", out var key))
        {
            var record = !values.TryGetValue("action", out var action) || action == "record";
            state.Queue.TryEnqueue(() => OnAnswer(key, record));
        }
    }

    public void Dispose()
    {
        if (manager is not { } shown) return;
        try
        {
            shown.NotificationInvoked -= Invoked;
            shown.Unregister();
        }
        catch (Exception e) when (e is COMException or InvalidOperationException)
        {
        }
    }
}
