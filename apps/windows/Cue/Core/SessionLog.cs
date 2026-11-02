using System.Globalization;
using System.Text;

namespace Cue;

/// <summary>
/// Markdown record of the session, for reviewing afterwards, and what end-to-end cases wait on: `Application Support/Cue/sessions/*.md`,
/// a line of the form `` `HH:mm:ss` text `` for every step. The lines are the Mac's, word for word.
/// </summary>
public sealed class SessionLog
{
    /// <summary>"⚠︎": the warning sign with the text variation selector, as the Mac's lines have it.</summary>
    public const string Warning = "⚠︎";

    public string Path { get; }

    private readonly FileStream stream;
    private readonly object gate = new();

    public SessionLog()
    {
        var folder = System.IO.Path.Combine(Storage.AppSupport, "sessions");
        Directory.CreateDirectory(folder);
        // Named by the second, as the Mac's; two launches in the same second must not share one.
        var stamp = DateTime.Now.ToString("yyyy-MM-dd-HHmmss", CultureInfo.InvariantCulture);
        var path = System.IO.Path.Combine(folder, $"{stamp}.md");
        for (var n = 2; File.Exists(path); n++) path = System.IO.Path.Combine(folder, $"{stamp}-{n}.md");
        Path = path;
        stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
        Append("# Cue session\n\n");
    }

    public void Write(string text) => Write(text, DateTime.Now);

    public void Write(string text, DateTime at) =>
        Append($"`{at.ToString("HH:mm:ss", CultureInfo.InvariantCulture)}` {text}\n");

    private void Append(string text)
    {
        var bytes = new UTF8Encoding(false).GetBytes(text);
        lock (gate)
        {
            try
            {
                stream.Write(bytes);
                stream.Flush();
            }
            catch (IOException)
            {
                // The log is a record, not a dependency: Cue goes on without it.
            }
        }
    }
}
