using System.Text.Json;
using System.Text.Json.Serialization;

namespace Cue;

// The Cue API's notes and recording uploads (packages/contract: notes.ts). The shapes follow it by hand, as the Mac's NotesAPI.swift does.
//
// After a call the recording goes up as a resumable multipart upload (`RecordingUploader`), the server's notes Workflow reads it, and the notes are
// kept on the server. The app follows the Workflow's progress events, then keeps a Markdown copy of the note in the library.

/// <summary>Where an upload of one side of a recording stands.</summary>
/// <param name="Status">"open" or "done".</param>
/// <param name="Parts">The parts that landed: a resumed upload sends the rest.</param>
public sealed record RemoteUpload(string UploadId, string Side, string Status, List<RemoteUploadPart> Parts, long? Size);

public sealed record RemoteUploadPart(int PartNumber, long Size);

/// <summary>One paragraph of a note's transcript. `speaker` is written even when null: the contract wants the key.</summary>
/// <param name="Channel">"me" or "others".</param>
/// <param name="Start">Seconds since the recording began.</param>
public sealed record RemoteTurn(
    string Channel,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] int? Speaker,
    string Label,
    double Start,
    string Text);

public sealed record RemoteMeeting(string Title, List<string> Attendees);

/// <summary>A step of the notes Workflow as the note lists it: "transcript", "speakers", "names", "summary" or "translate", in a state of "pending", "running", "done" or "failed".</summary>
public sealed record RemoteNoteStep(string Id, string Title, string State, string? Detail);

/// <summary>With two languages chosen, the note in the other one: its code and English name, the title, the summary (Markdown) and one string per turn of
/// the transcript, in the same order (an empty one for a line that couldn't be translated).</summary>
public sealed record RemoteNoteTranslation(string Language, string Name, string Title, string Summary, List<string> Transcript);

/// <summary>A note as the account holds it. Times are milliseconds since the epoch.</summary>
/// <param name="Status">"processing" or "ready".</param>
/// <param name="Audio">The sides still in storage: "me", "others", "mixed".</param>
/// <param name="Translation">The note in the other of the person's two languages; null with one.</param>
public sealed record RemoteNote(
    string Id,
    string? CallId,
    string? ProjectId,
    string Title,
    double StartedAt,
    double DurationSeconds,
    string Status,
    string Language,
    string Speaker,
    RemoteMeeting? Meeting,
    List<string> Participants,
    string Summary,
    string TranscriptHeading,
    List<RemoteTurn> Transcript,
    Dictionary<string, string> Suggestions,
    List<RemoteNoteStep> Steps,
    List<string> Audio,
    double CreatedAt,
    RemoteNoteTranslation? Translation = null)
{
    public DateTime Started => DateTimeOffset.FromUnixTimeMilliseconds((long)StartedAt).UtcDateTime;
}

/// <summary>What the Workflow does, one event per line of the session log.</summary>
/// <param name="Kind">"step", "suggestion" or "note".</param>
/// <param name="Step">"transcript", "speakers", "names" or "summary" for a step.</param>
/// <param name="State">"running", "done", "failed" or (the `note` event) "ready".</param>
/// <param name="Line">The session log line this event stands for, if it stands for one.</param>
public sealed record NoteProgressEvent(int Seq, string Kind, string? Step, string State, string? Line, string? Detail, double At);

/// <summary>`POST /v1/calls/:id/notes`. The person's name, and whether the notes get a summary and keep the audio, are the account's (<see cref="AccountSettings"/>).</summary>
public sealed record NewNotesBody(
    string? Title,
    long Take,
    long EndedAt,
    IReadOnlyList<string> Sides,
    RemoteMeeting? Meeting,
    string? Language,
    string? ProjectId);

/// <summary>`POST /v1/notes/import`: an old note of this PC's library, taken apart.</summary>
public sealed record NoteImportBody(
    string Stamp,
    string ProjectId,
    string Title,
    long StartedAt,
    double DurationSeconds,
    string Language,
    string Speaker,
    RemoteMeeting? Meeting,
    IReadOnlyList<string> Participants,
    string Summary,
    string TranscriptHeading,
    IReadOnlyList<RemoteTurn> Transcript,
    IReadOnlyDictionary<string, string> Suggestions);

public static class NotesApi
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };

    public static T Decode<T>(byte[] data)
    {
        try
        {
            return JsonSerializer.Deserialize<T>(data, Json) ?? throw new JsonException("empty");
        }
        catch (JsonException e)
        {
            throw CueApiException.Server($"Cue answered something unexpected: {e.Message}");
        }
    }

    private static string RecordingPath(string call, string side) => $"v1/calls/{call}/recording/{side}";

    private static readonly byte[] Empty = "{}"u8.ToArray();

    // MARK: Recording upload

    /// <summary>Begins the upload of one side of a recording; the same call again says what already arrived.</summary>
    public static async Task<RemoteUpload> BeginUpload(this CueApi api, string call, string side, long take) =>
        Decode<RemoteUpload>(await api.Request("POST", RecordingPath(call, side), new Dictionary<string, string> { ["take"] = take.ToString(System.Globalization.CultureInfo.InvariantCulture) }, json: Empty));

    /// <summary>Sends one part (numbered from 1) of an upload.</summary>
    public static async Task PutPart(this CueApi api, string call, string side, long take, int part, byte[] data, CancellationToken cancel = default) =>
        await api.Request(
            "PUT",
            RecordingPath(call, side),
            new Dictionary<string, string>
            {
                ["take"] = take.ToString(System.Globalization.CultureInfo.InvariantCulture),
                ["part"] = part.ToString(System.Globalization.CultureInfo.InvariantCulture),
            },
            body: data,
            contentType: "application/octet-stream",
            timeout: TimeSpan.FromSeconds(180),
            cancel: cancel);

    public static async Task<RemoteUpload> CompleteUpload(this CueApi api, string call, string side, long take) =>
        Decode<RemoteUpload>(
            await api.Request("POST", RecordingPath(call, side) + "/complete", new Dictionary<string, string> { ["take"] = take.ToString(System.Globalization.CultureInfo.InvariantCulture) }, json: Empty));

    // MARK: Notes

    /// <summary>Starts the notes of a recording once its uploads are in. The same `take` again returns the same note.</summary>
    public static async Task<RemoteNote> StartNotes(this CueApi api, string call, NewNotesBody body) =>
        Decode<RemoteNote>(await api.Request("POST", $"v1/calls/{call}/notes", json: JsonSerializer.SerializeToUtf8Bytes(body, Json)));

    private sealed record NoteList(List<RemoteNote> Notes);

    public static async Task<List<RemoteNote>> ListNotes(this CueApi api) => Decode<NoteList>(await api.Get("v1/notes")).Notes;

    public static async Task<RemoteNote> Note(this CueApi api, string id) => Decode<RemoteNote>(await api.Get($"v1/notes/{id}"));

    /// <summary>One change to a note: rename a person throughout, apply a suggested name, or dismiss it.</summary>
    public static async Task<RemoteNote> PatchNote(this CueApi api, string id, object patch) =>
        Decode<RemoteNote>(await api.Request("PATCH", $"v1/notes/{id}", json: JsonSerializer.SerializeToUtf8Bytes(patch, Json)));

    private sealed record RenameChange(string From, string To);

    private sealed record RenamePatch(RenameChange Rename);

    private sealed record ApplyPatch(string Apply);

    private sealed record DismissPatch(string Dismiss);

    public static object Rename(string oldName, string newName) => new RenamePatch(new RenameChange(oldName, newName));

    public static object Apply(string label) => new ApplyPatch(label);

    public static object Dismiss(string label) => new DismissPatch(label);

    /// <summary>Moves a note to the trash (its audio is deleted from storage).</summary>
    public static async Task DeleteNote(this CueApi api, string id) => await api.Request("DELETE", $"v1/notes/{id}");

    public static async Task<RemoteNote> ImportNote(this CueApi api, NoteImportBody body) =>
        Decode<RemoteNote>(await api.Request("POST", "v1/notes/import", json: JsonSerializer.SerializeToUtf8Bytes(body, Json)));

    /// <summary>The mixed audio of an imported note, as one request.</summary>
    public static async Task PutImportAudio(this CueApi api, string noteId, string file) =>
        await api.Request("PUT", $"v1/notes/{noteId}/audio/mixed", file: file, contentType: "audio/mp4", timeout: TimeSpan.FromSeconds(300));
}

public sealed partial class CueApi
{
    private static readonly JsonSerializerOptions EventJson = new(JsonSerializerDefaults.Web);

    /// <summary>
    /// Follows a note's progress events (server-sent events) after `after` until the stream ends: the server ends it after the `note` event. `onEvent`
    /// gets each event once, in order.
    /// </summary>
    public async Task FollowNoteEvents(string id, int after, Action<NoteProgressEvent> onEvent, CancellationToken cancel = default)
    {
        var token = await Bearer();
        for (var attempt = 0; attempt < 2; attempt++)
        {
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(cancel);
            limit.CancelAfter(TimeSpan.FromMinutes(10));
            using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(BaseUrl, $"v1/notes/{id}/events?after={after}"));
            request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
            request.Headers.TryAddWithoutValidation("Cue-Version", $"windows/{Env.Version}");
            request.Headers.TryAddWithoutValidation("Accept", "text/event-stream");
            try
            {
                using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, limit.Token);
                var status = (int)response.StatusCode;
                if (status == 401 && attempt == 0)
                {
                    token = await Bearer(refreshing: true);
                    continue;
                }
                if (status != 200)
                {
                    var error = ApiErrorBody.In(await response.Content.ReadAsByteArrayAsync(limit.Token));
                    if (status == 401) throw new CueApiException(CueApiError.Ended, error?.Message ?? "Your session has ended. Sign in to Cue again.", error?.Code);
                    throw CueApiException.Server(error?.Message ?? $"Cue answered {status}.");
                }
                var last = after;
                using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(limit.Token));
                while (await reader.ReadLineAsync(limit.Token) is { } line)
                {
                    if (!line.StartsWith("data:", StringComparison.Ordinal)) continue;
                    NoteProgressEvent? note;
                    try
                    {
                        note = JsonSerializer.Deserialize<NoteProgressEvent>(line[5..], EventJson);
                    }
                    catch (JsonException)
                    {
                        continue;
                    }
                    if (note is null || note.Seq <= last) continue;
                    last = note.Seq;
                    onEvent(note);
                }
                return;
            }
            catch (Exception e) when (e is HttpRequestException or IOException or OperationCanceledException && !cancel.IsCancellationRequested)
            {
                throw CueApiException.Network(e is OperationCanceledException ? "the stream timed out." : e.Message);
            }
        }
        throw CueApiException.Server("Cue didn't accept the sign-in.");
    }

    /// <summary>Downloads a note's audio (the `mixed` side) from the account to `target`, for the player: the request carries the token.</summary>
    public async Task DownloadNoteAudio(string noteId, string target, CancellationToken cancel = default)
    {
        var token = await Bearer();
        for (var attempt = 0; attempt < 2; attempt++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(BaseUrl, $"v1/notes/{noteId}/audio/mixed"));
            request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
            request.Headers.TryAddWithoutValidation("Cue-Version", $"windows/{Env.Version}");
            try
            {
                using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancel);
                var status = (int)response.StatusCode;
                if (status == 401 && attempt == 0)
                {
                    token = await Bearer(refreshing: true);
                    continue;
                }
                if (status != 200)
                {
                    var error = ApiErrorBody.In(await response.Content.ReadAsByteArrayAsync(cancel));
                    throw CueApiException.Server(error?.Message ?? $"Cue answered {status}.");
                }
                var partial = target + ".part";
                await using (var file = File.Create(partial))
                {
                    await response.Content.CopyToAsync(file, cancel);
                }
                File.Move(partial, target, overwrite: true);
                return;
            }
            catch (Exception e) when (e is HttpRequestException or IOException)
            {
                throw CueApiException.Network(e.Message);
            }
        }
        throw CueApiException.Server("Cue didn't accept the sign-in.");
    }
}

/// <summary>
/// Sends the files of a recording to the account as resumable multipart uploads: parts of <see cref="PartBytes"/>, each tried again when it fails, and an
/// upload that broke (the connection, the app quitting) carries on from the parts the server already has.
///
/// Test hooks: `CUE_UPLOAD_PART_BYTES=n` sets the part size (default 8 MiB; the server wants 5 MiB at least for all but the last part), and
/// `CUE_UPLOAD_BREAK=n` loses the connection once, as the part after the first `n` sent in this launch is about to go.
/// </summary>
public sealed class RecordingUploader(CueApi api, SessionLog log)
{
    public static readonly int PartBytes = int.TryParse(Env.Get("CUE_UPLOAD_PART_BYTES"), out var bytes) ? Math.Max(bytes, 1) : 8 * 1024 * 1024;

    private static readonly int? BreakAfter = int.TryParse(Env.Get("CUE_UPLOAD_BREAK"), out var parts) ? parts : null;
    private static int partsSent;
    private static bool broke;

    /// <summary>How many times an upload starts over (from what the server has) before it gives up.</summary>
    private const int Retries = 3;

    /// <summary>Uploads a file as `side` ("me", "others" or "mixed") of the recording that began at `take`; returns its size in bytes.</summary>
    public async Task<long> Upload(string file, string side, string call, long take, CancellationToken cancel = default)
    {
        var size = new FileInfo(file).Length;
        if (size <= 0) throw new IOException($"The audio of {Name(side)} is empty");
        var count = (int)((size + PartBytes - 1) / PartBytes);
        var attempt = 0;
        while (true)
        {
            try
            {
                var state = await api.BeginUpload(call, side, take);
                if (state.Status == "done") return size;
                if (state.Parts.Count > 0) log.Write($"⬆️ Resuming the upload of {Name(side)}: {state.Parts.Count} of {count} parts are there");
                var have = state.Parts.ToDictionary(part => part.PartNumber, part => part.Size);
                for (var part = 1; part <= count; part++)
                {
                    var offset = (long)(part - 1) * PartBytes;
                    var length = (int)Math.Min(PartBytes, size - offset);
                    if (have.TryGetValue(part, out var there) && there == length) continue;
                    if (BreakAfter is { } limit && !broke && partsSent >= limit)
                    {
                        broke = true;
                        throw CueApiException.Network("The connection was lost");
                    }
                    var data = new byte[length];
                    await using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1, useAsync: true))
                    {
                        stream.Seek(offset, SeekOrigin.Begin);
                        await stream.ReadExactlyAsync(data, cancel);
                    }
                    await api.PutPart(call, side, take, part, data, cancel);
                    partsSent++;
                }
                var done = await api.CompleteUpload(call, side, take);
                if (done.Status != "done") throw CueApiException.Server("The server didn't finish the upload");
                return size;
            }
            catch (Exception e) when (e is CueApiException or IOException)
            {
                // A session that ended is not worth trying again; anything else starts over from what the server has.
                if (e is CueApiException { Kind: CueApiError.Ended }) throw;
                attempt++;
                if (attempt > Retries || cancel.IsCancellationRequested) throw;
                log.Write($"{SessionLog.Warning} The upload stopped: {e.Message} — trying again");
                await Task.Delay(TimeSpan.FromSeconds(0.5 * (1 << (attempt - 1))), cancel);
            }
        }
    }

    /// <summary>"your side", "the call side", "the mixed audio".</summary>
    private static string Name(string side) =>
        side switch
        {
            "me" => "your side",
            "others" => "the call side",
            _ => "the mixed audio",
        };
}
