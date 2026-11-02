using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Cue;

/// <summary>
/// Where the browser hands the sign-in back to Cue (RFC 8252 §7.3, a loopback redirect): a listener on 127.0.0.1 and a port of the system's
/// choosing, for the one request `http://127.0.0.1:PORT/oauth/callback?…`. The backend registers the redirect without a port, so any port works.
/// Plain sockets rather than HttpListener, which wants a URL reservation on some Windows setups.
/// </summary>
public sealed class LoopbackReceiver : IDisposable
{
    public const string Path = "/oauth/callback";

    private readonly TcpListener listener;

    private LoopbackReceiver(TcpListener listener) => this.listener = listener;

    public int Port => ((IPEndPoint)listener.LocalEndpoint).Port;

    /// <summary>The redirect URI of this sign-in, exactly as the authorization and token requests carry it.</summary>
    public string RedirectUri => $"http://127.0.0.1:{Port}{Path}";

    public static LoopbackReceiver Start()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start(8);
        return new LoopbackReceiver(listener);
    }

    /// <summary>
    /// Waits for the browser to arrive at the redirect URI and answers it with a page that says what to do. Other requests (a favicon, a
    /// stranger's) are turned away, and so is a redirect that isn't this sign-in's (its `state`); `error` ones count, which is how the
    /// backend's pages send the person back to say why a sign-in failed.
    /// </summary>
    public async Task<Uri> WaitForCallback(string state, CancellationToken cancel)
    {
        for (;;)
        {
            using var client = await listener.AcceptTcpClientAsync(cancel);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancel);
            timeout.CancelAfter(TimeSpan.FromSeconds(10));
            string target;
            try
            {
                target = await ReadRequestTarget(client.GetStream(), timeout.Token);
            }
            catch (Exception e) when (e is IOException or OperationCanceledException && !cancel.IsCancellationRequested)
            {
                continue;
            }
            var uri = new Uri($"http://127.0.0.1:{Port}{target}");
            var query = System.Web.HttpUtility.ParseQueryString(uri.Query);
            var ours = uri.AbsolutePath == Path && (query["state"] == state || query["error"] is not null);
            await Respond(client.GetStream(), ours ? 200 : 404, ours ? Page(query["error"] is not null) : "Not found.", cancel);
            if (ours) return uri;
        }
    }

    public void Dispose() => listener.Stop();

    private static async Task<string> ReadRequestTarget(NetworkStream stream, CancellationToken cancel)
    {
        var buffer = new byte[8192];
        var length = 0;
        while (length < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(length), cancel);
            if (read == 0) break;
            length += read;
            if (Encoding.ASCII.GetString(buffer, 0, length).Contains("\r\n\r\n", StringComparison.Ordinal)) break;
        }
        var line = Encoding.ASCII.GetString(buffer, 0, length).Split("\r\n")[0].Split(' ');
        if (line.Length < 2 || line[0] != "GET" || !line[1].StartsWith('/')) throw new IOException("Not a request for a page.");
        return line[1];
    }

    private static async Task Respond(NetworkStream stream, int status, string html, CancellationToken cancel)
    {
        var body = Encoding.UTF8.GetBytes(html);
        var head = Encoding.ASCII.GetBytes(
            $"HTTP/1.1 {status} {(status == 200 ? "OK" : "Not Found")}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {body.Length}\r\n"
            + "Cache-Control: no-store\r\nConnection: close\r\n\r\n");
        try
        {
            await stream.WriteAsync(head, cancel);
            await stream.WriteAsync(body, cancel);
            await stream.FlushAsync(cancel);
        }
        catch (IOException)
        {
            // The browser went away: it has what it came for.
        }
    }

    private static string Page(bool failed) =>
        $$"""
        <!doctype html>
        <html lang="en"><head><meta charset="utf-8"><title>Cue</title>
        <style>:root { color-scheme: light dark; font: 16px/1.5 "Segoe UI", sans-serif; }
        body { margin: 0; min-height: 100vh; display: grid; place-items: center; text-align: center; }
        h1 { font-size: 1.5rem; margin: 0 0 .5rem; } p { color: GrayText; margin: 0; }</style></head>
        <body><main><h1>{{(failed ? "Sign-in didn't finish" : "You're signed in")}}</h1>
        <p>{{(failed ? "Go back to Cue to see why." : "You can close this tab and go back to Cue.")}}</p></main></body></html>
        """;
}
