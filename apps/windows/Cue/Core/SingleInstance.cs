using System.Security.Cryptography;
using System.Text;

namespace Cue;

/// <summary>
/// One Cue per library: a second launch (the Start menu again, a double click) brings the first one's dashboard forward and ends. The name
/// includes the folder Cue keeps its files in, so a test run's sandboxed Cues (CUE_HOME) never meet each other or the person's own.
/// </summary>
public static class SingleInstance
{
    private static Mutex? mutex;
    private static EventWaitHandle? show;
    private static RegisteredWaitHandle? waiting;

    /// <summary>Whether this is the first Cue; when it is not, the first one has been asked to show itself.</summary>
    public static bool TryBecomeFirst(Action showDashboard)
    {
        var id = Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(Storage.AppSupport.ToLowerInvariant())))[..16];
        mutex = new Mutex(initiallyOwned: true, $"Local\\Cue.{id}", out var first);
        show = new EventWaitHandle(false, EventResetMode.AutoReset, $"Local\\Cue.Show.{id}");
        if (!first)
        {
            show.Set();
            return false;
        }
        waiting = ThreadPool.RegisterWaitForSingleObject(show, (_, _) => showDashboard(), null, Timeout.Infinite, executeOnlyOnce: false);
        return true;
    }
}
