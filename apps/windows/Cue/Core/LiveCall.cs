using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

namespace Cue;

public sealed partial class CueApi
{
    /// <summary>Starts a call for a project. The settings can change later with a `config` command. `notesOnly`: a call just for a recording's notes, which
    /// starts over already (nothing listens or answers) and is not stopped by the plan's limit.</summary>
    public async Task<CallInfo> CreateCall(string projectId, string speaker, bool auto, bool micQuestions, bool questions, bool notesOnly = false)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(
            new Dictionary<string, object>
            {
                ["projectId"] = projectId,
                ["speaker"] = speaker,
                ["auto"] = auto,
                ["micQuestions"] = micQuestions,
                ["questions"] = questions,
                ["notesOnly"] = notesOnly,
            });
        var data = await Request("POST", "v1/calls", json: body);
        try
        {
            return JsonSerializer.Deserialize<CallInfo>(data, Json) ?? throw new JsonException("empty");
        }
        catch (JsonException e)
        {
            throw CueApiException.Server($"Cue answered something unexpected: {e.Message}");
        }
    }

    /// <summary>Ends a call: the server closes its speech streams and keeps the live transcript. Best effort.</summary>
    public async Task EndCall(string id)
    {
        try
        {
            await Request("POST", $"v1/calls/{id}/end", json: "{}"u8.ToArray(), timeout: TimeSpan.FromSeconds(10));
        }
        catch (CueApiException)
        {
        }
    }
}

/// <summary>
/// A call's WebSocket. Anything may be sent from any thread (the capture threads send audio, the UI thread commands): messages go through one queue,
/// as a <see cref="ClientWebSocket"/> sends one at a time.
/// </summary>
public sealed class LiveSocket : IDisposable
{
    private readonly ClientWebSocket socket = new();
    private readonly Channel<(byte[] Data, WebSocketMessageType Type)> outbox =
        Channel.CreateBounded<(byte[], WebSocketMessageType)>(new BoundedChannelOptions(1500) { FullMode = BoundedChannelFullMode.DropWrite, SingleReader = true });
    private readonly CancellationTokenSource stop = new();
    private Task? writer;
    private bool disposed;

    /// <summary>The status of the refused upgrade, once it was.</summary>
    public int? HttpStatus
    {
        get
        {
            var status = (int)socket.HttpStatusCode;
            return status > 0 ? status : null;
        }
    }

    public async Task Connect(Uri url, string token, string version, CancellationToken cancel)
    {
        socket.Options.SetRequestHeader("Authorization", $"Bearer {token}");
        socket.Options.SetRequestHeader("Cue-Version", version);
        await socket.ConnectAsync(url, cancel);
        writer = Task.Run(Write);
    }

    public bool TrySend(byte[] data, WebSocketMessageType type) => outbox.Writer.TryWrite((data, type));

    private async Task Write()
    {
        try
        {
            await foreach (var (data, type) in outbox.Reader.ReadAllAsync(stop.Token))
                await socket.SendAsync(data, type, true, stop.Token);
        }
        catch (Exception e) when (e is OperationCanceledException or WebSocketException or ObjectDisposedException or InvalidOperationException)
        {
            // The receiving side notices a broken connection.
        }
    }

    /// <summary>The next text message; anything else (binary frames) is skipped. A closed connection is an <see cref="IOException"/>.</summary>
    public async Task<string> Receive(CancellationToken cancel)
    {
        var buffer = new byte[16 * 1024];
        using var message = new MemoryStream();
        for (;;)
        {
            var result = await socket.ReceiveAsync(buffer, cancel);
            if (result.MessageType == WebSocketMessageType.Close) throw new IOException("the connection was closed");
            message.Write(buffer, 0, result.Count);
            if (!result.EndOfMessage) continue;
            if (result.MessageType == WebSocketMessageType.Text) return Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length);
            message.SetLength(0);
        }
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        stop.Cancel();
        outbox.Writer.TryComplete();
        socket.Dispose();
        stop.Dispose();
    }
}

/// <summary>
/// A call's live socket (`GET /v1/live`): audio goes up, events come down. It reconnects by itself while the call is live, asking for the events it
/// missed (`after`), and says when the call is over for good. Used from the UI thread; the callbacks are called on it.
/// </summary>
public sealed class LiveCall
{
    public static string ClientVersion => $"windows/{Env.Version}";

    public string Id { get; }

    /// <summary>When the call began for the app (its `POST` returned): the server's times count from about then.</summary>
    public DateTime StartedAt { get; } = DateTime.Now;

    /// <summary>Every event, in order, once.</summary>
    public Action<CallEvent> OnEvent { get; set; } = _ => { };

    /// <summary>The call is over for good: ended by the server, or it no longer knows it. Says why.</summary>
    public Action<string> OnGone { get; set; } = _ => { };

    /// <summary>The socket could not be opened or broke (told once for each kind of trouble in a row), for the session log.</summary>
    public Action<string> OnTrouble { get; set; } = _ => { };

    /// <summary>Where the microphone's and the call's audio goes; thread-safe, for the capture threads. It outlives the call (the app owns it).</summary>
    public AudioSink Audio { get; }

    private readonly CueApi api;
    private readonly CancellationTokenSource cancel = new();
    private LiveSocket? socket;
    private bool connected;
    private bool live = true;
    private int lastSeq;
    private bool started;

    /// <summary>The newest settings sent, which go again on every connection, and the commands sent while there was none.</summary>
    private readonly Dictionary<string, object?> settings = [];

    private readonly List<Dictionary<string, object?>> pending = [];

    public LiveCall(CueApi api, CallInfo info, AudioSink audio)
    {
        this.api = api;
        Audio = audio;
        Id = info.CallId;
    }

    public void Connect()
    {
        if (started) return;
        started = true;
        _ = Run();
    }

    /// <summary>Ends the socket for good (the app ends the call itself over HTTP).</summary>
    public void Close()
    {
        live = false;
        cancel.Cancel();
        socket?.Dispose();
        socket = null;
        connected = false;
        Audio.Stop();
    }

    /// <summary>A command of the contract (`config`, `ask`, `answerNow`, `prepare`). Held until the socket is up, if it is not.</summary>
    public void Send(Dictionary<string, object?> command)
    {
        if (command.GetValueOrDefault("type") as string == "config")
        {
            foreach (var (key, value) in command) settings[key] = value;
            if (!connected) return;
        }
        else if (!connected)
        {
            pending.Add(command);
            return;
        }
        Write(command);
    }

    private void Write(Dictionary<string, object?> command) =>
        socket?.TrySend(JsonSerializer.SerializeToUtf8Bytes(command), WebSocketMessageType.Text);

    private Uri Url
    {
        get
        {
            var builder = new UriBuilder(new Uri(CueApi.BaseUrl, "v1/live"))
            {
                Query = $"call={Uri.EscapeDataString(Id)}&after={lastSeq}",
            };
            builder.Scheme = builder.Scheme == "https" ? "wss" : "ws";
            builder.Port = CueApi.BaseUrl.Port;
            return builder.Uri;
        }
    }

    private async Task Run()
    {
        double[] delays = [0.5, 1, 2, 5];
        var attempt = 0;
        var refresh = false;
        var lastTrouble = "";
        void Trouble(string text)
        {
            // A socket that was closed on purpose (Stop Cue) breaks off what it was doing: not trouble.
            if (!live || text == lastTrouble) return;
            lastTrouble = text;
            OnTrouble(text);
        }
        while (live && !cancel.IsCancellationRequested)
        {
            string? gone = null;
            var heard = false;
            try
            {
                var token = await api.Bearer(refresh);
                refresh = false;
                using var current = new LiveSocket();
                socket = current;
                try
                {
                    await current.Connect(Url, token, ClientVersion, cancel.Token);
                    while (live)
                    {
                        var text = await current.Receive(cancel.Token);
                        heard = true;
                        if (CallEvent.Parse(text) is { } received) Handle(received, current);
                    }
                }
                catch (Exception e) when (e is WebSocketException or IOException or HttpRequestException)
                {
                    // A refused upgrade says why in its status; anything else is a connection that broke.
                    var status = current.HttpStatus;
                    switch (status)
                    {
                        case 404:
                            gone = "The call is over.";
                            break;
                        case 401:
                            refresh = true;
                            break;
                    }
                    Trouble(e.Message + (status is { } code ? $" (HTTP {code})" : ""));
                }
            }
            catch (OperationCanceledException) when (cancel.IsCancellationRequested)
            {
            }
            catch (CueApiException e) when (e.Kind == CueApiError.Ended)
            {
                gone = e.Message;
            }
            catch (Exception e)
            {
                // Offline, say: tried again below.
                Trouble(e.Message);
            }
            connected = false;
            socket = null;
            Audio.Disconnect();
            if (!live) break;
            if (gone is not null)
            {
                live = false;
                OnGone(gone);
                break;
            }
            if (heard) attempt = 0;
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(delays[Math.Min(attempt, delays.Length - 1)]), cancel.Token);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            attempt++;
        }
    }

    private void Handle(CallEvent received, LiveSocket current)
    {
        if (received.Type == "ready")
        {
            connected = true;
            Audio.Connect(current);
            // The settings go again, then what was asked while there was no socket.
            if (settings.Count > 0) Write(settings);
            var waiting = pending.ToArray();
            pending.Clear();
            foreach (var command in waiting) Write(command);
            // `ready` says how far the call's events have got; it is not one of them, and the statuses sent after it on a first connection
            // carry older numbers than its own.
            OnEvent(received);
            return;
        }
        if (received.Seq <= lastSeq) return; // replayed: seen already
        lastSeq = Math.Max(lastSeq, received.Seq);
        OnEvent(received);
        if (received.Type == "ended" || (received.Type == "error" && received.Fatal == true))
        {
            live = false;
            OnGone(received.Type == "ended" ? "The call has ended." : received.Message ?? "The call stopped.");
        }
    }
}
