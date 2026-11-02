namespace Cue;

/// <summary>
/// System-wide shortcuts (`RegisterHotKey`), which work while PowerPoint or Teams has the focus and need no special permission. The Mac's are Control+Option;
/// on Windows Ctrl+Alt is AltGr on many keyboard layouts (Polish, German, Ukrainian…) and would swallow typed characters, so Cue's are Win+Alt:
/// Windows keeps the Win key for itself, but not Win+Alt with these keys (it does keep the arrows). (Win+Alt+R is the Game Bar's recording: Cue's own is Win+Alt+C.)
/// </summary>
internal sealed class HotKeys : IDisposable
{
    private const uint Alt = 0x1;
    private const uint Win = 0x8;

    private readonly MessageWindow window;
    private readonly SessionLog log;
    private readonly Dictionary<int, Action> handlers = [];
    private int next = 1;

    public HotKeys(MessageWindow window, SessionLog log)
    {
        this.window = window;
        this.log = log;
        window.HotKey += id =>
        {
            if (handlers.TryGetValue(id, out var run)) run();
        };
    }

    /// <summary>Registers Win+Alt+<paramref name="key"/> (a virtual-key code); a combination another program holds is told in the session log and skipped.</summary>
    public void Register(string name, uint key, Action run)
    {
        var id = next++;
        if (window.RegisterHotKey(id, Win | Alt, key))
        {
            handlers[id] = run;
            return;
        }
        log.Write($"{SessionLog.Warning} Couldn't register the shortcut for {name}: another program uses Win+Alt+{Name(key)}");
    }

    private static string Name(uint key) =>
        key switch
        {
            0x0D => "Enter",
            0x21 => "Page Up",
            0x22 => "Page Down",
            0xBB => "+",
            0xBD => "-",
            _ => ((char)key).ToString(),
        };

    public void Dispose()
    {
        foreach (var id in handlers.Keys) window.UnregisterHotKey(id);
        handlers.Clear();
    }
}
