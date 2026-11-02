using System.Buffers.Binary;
using System.Threading.Channels;
using Windows.Media.MediaProperties;
using Windows.Media.Transcoding;
using Windows.Storage;

namespace Cue;

/// <summary>A finished recording's audio. <paramref name="Mixed"/> is the mixed AAC file, null when making it failed.</summary>
/// <param name="Folder">The working folder: `mic.wav`, `call.wav` and, until it is moved, `mixed.m4a`.</param>
/// <param name="Error">The first thing that went wrong, if anything did.</param>
public sealed record AudioRecording(string Folder, string? Mixed, double Duration, string? Error);

/// <summary>
/// Records the audio of a call while Cue records its transcript, from the same 16 kHz samples speech recognition gets (<see cref="LiveModel.Samples"/>).
/// Writes, on a thread of its own:
///
/// - `mic.wav` and `call.wav`, each side on its own (16-bit PCM, 16 kHz mono): working copies for processing the note, kept in the recording's working
///   folder until its notes are ready;
/// - `mixed.m4a`, both sides mixed (AAC, made by Windows' own encoder when the recording ends), which <see cref="RecordingStore"/> moves next to the note
///   when Keep audio is on.
///
/// Each chunk is placed by its capture time relative to the start, so both sides line up even when one delivers nothing for a while (WASAPI's loopback
/// is quiet while the PC plays nothing): the gap becomes silence. All the files are as long as the recording and start when it starts, so a transcript
/// offset is a time in each of them. The Mac's `AudioRecorder`.
/// </summary>
public sealed class AudioRecorder
{
    public const string MicFile = "mic.wav";
    public const string CallFile = "call.wav";
    public const string MixedFile = "mixed.m4a";
    private const string MixedWav = "mixed.wav";

    private readonly Channel<Action> queue = Channel.CreateUnbounded<Action>(new UnboundedChannelOptions { SingleReader = true });

    /// <summary>Only touched on the worker.</summary>
    private AudioSession? session;

    private volatile bool recording;

    public AudioRecorder() => _ = Task.Run(Work);

    private async Task Work()
    {
        await foreach (var work in queue.Reader.ReadAllAsync())
        {
            try
            {
                work();
            }
            catch (Exception e)
            {
                session?.Fail(e.Message);
            }
        }
    }

    // MARK: Working folders

    /// <summary>Where a recording's working audio lives, found from its start time (a note's `date:`): `Application Support\Cue\recordings\2026-10-24T110500Z\`.</summary>
    public static string WorkingFolder(DateTime startedAt) =>
        Path.Combine(Storage.AppSupport, "recordings", NoteMarkdown.Stamp(startedAt).Replace(":", "", StringComparison.Ordinal));

    /// <summary>Working audio left behind by recordings that were never processed (Cue quit or crashed meanwhile).</summary>
    public static void RemoveStaleWorkingFolders(TimeSpan? olderThan = null)
    {
        var folder = Path.Combine(Storage.AppSupport, "recordings");
        if (!Directory.Exists(folder)) return;
        foreach (var item in Directory.EnumerateDirectories(folder))
        {
            try
            {
                if (DateTime.UtcNow - Directory.GetLastWriteTimeUtc(item) > (olderThan ?? TimeSpan.FromDays(7))) Directory.Delete(item, recursive: true);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
            }
        }
    }

    // MARK: Recording

    /// <summary>Starts recording both sides; `date` is the start of every file.</summary>
    public void Start(DateTime date)
    {
        var folder = WorkingFolder(date);
        var start = Audio.HostSeconds() - (DateTime.Now - date).TotalSeconds;
        recording = true;
        queue.Writer.TryWrite(() =>
        {
            session?.Cancel();
            session = new AudioSession(folder, date, start);
        });
    }

    /// <summary>16 kHz samples from one side; `time` is the host time of the first one. Ignored unless recording. Thread-safe.</summary>
    public void Push(float[] samples, Side side, double time)
    {
        if (!recording) return;
        var copy = (float[])samples.Clone();
        queue.Writer.TryWrite(() => session?.Add(copy, side, time));
    }

    /// <summary>Nothing captured after `date` goes into the files; what was captured before may still arrive.</summary>
    public void Stop(DateTime date) => queue.Writer.TryWrite(() => session?.Stop(date));

    /// <summary>Pads both sides to the end, closes the files and makes the mixed AAC.</summary>
    public async Task<AudioRecording?> Finish()
    {
        var closed = new TaskCompletionSource<AudioRecording?>(TaskCreationOptions.RunContinuationsAsynchronously);
        recording = false;
        queue.Writer.TryWrite(() =>
        {
            var result = session?.Close();
            session = null;
            closed.SetResult(result);
        });
        var audio = await closed.Task;
        if (audio?.Mixed is not { } wav) return audio;
        var m4a = Path.Combine(audio.Folder, MixedFile);
        try
        {
            await Transcode(wav, m4a);
            File.Delete(wav);
            return audio with { Mixed = m4a };
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.Runtime.InteropServices.COMException or InvalidOperationException)
        {
            return audio with { Mixed = null, Error = audio.Error ?? $"Couldn't write the call's audio ({e.Message.Trim()})" };
        }
    }

    /// <summary>Stops and keeps nothing (Cue quits while recording).</summary>
    public void Cancel()
    {
        recording = false;
        queue.Writer.TryWrite(() =>
        {
            session?.Cancel();
            session = null;
        });
    }

    /// <summary>AAC in an MP4 file (`.m4a`) from the mixed WAV, by Windows' own encoder.</summary>
    private static async Task Transcode(string wav, string m4a)
    {
        var source = await StorageFile.GetFileFromPathAsync(wav);
        var folder = await StorageFolder.GetFolderFromPathAsync(Path.GetDirectoryName(m4a)!);
        var target = await folder.CreateFileAsync(Path.GetFileName(m4a), CreationCollisionOption.ReplaceExisting);
        var prepared = await new MediaTranscoder().PrepareFileTranscodeAsync(source, target, MediaEncodingProfile.CreateM4a(AudioEncodingQuality.Low));
        if (!prepared.CanTranscode) throw new IOException($"Windows can't make AAC audio here ({prepared.FailureReason})");
        await prepared.TranscodeAsync();
    }

    /// <summary>One recording's files and how far each side has got, in samples from the start.</summary>
    private sealed class AudioSession
    {
        private const double Rate = Audio.SampleRate;

        /// <summary>Timestamp jitter smaller than this is ignored: the chunk follows on directly.</summary>
        private const int Tolerance = (int)(0.05 * Rate);

        /// <summary>A side that delivers nothing is filled with silence once it is this far behind the other.</summary>
        private const int MaxLag = (int)(1.0 * Rate);

        /// <summary>Long silences are written in blocks, so neither side holds more than this unmixed.</summary>
        private const int Block = (int)(10 * Rate);

        private readonly string folder;
        private readonly DateTime startDate;

        /// <summary>Host time of the first sample.</summary>
        private readonly double start;

        private int? end;
        private readonly Lane mic;
        private readonly Lane call;
        private readonly WavWriter? mixer;

        /// <summary>Samples written to the mix; each side holds what it placed beyond this until the other catches up.</summary>
        private int mixed;

        private bool mixFailed;
        private string? error;

        private sealed class Lane(WavWriter? file)
        {
            public WavWriter? File { get; } = file;
            public int Placed { get; set; }
            public List<float> Unmixed { get; } = [];
        }

        public AudioSession(string folder, DateTime startDate, double start)
        {
            this.folder = folder;
            this.startDate = startDate;
            this.start = start;
            WavWriter? Open(string name)
            {
                try
                {
                    return new WavWriter(Path.Combine(folder, name));
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                {
                    error ??= e.Message;
                    return null;
                }
            }
            try
            {
                if (Directory.Exists(folder)) Directory.Delete(folder, recursive: true);
                Directory.CreateDirectory(folder);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                error = e.Message;
            }
            mic = new Lane(Open(MicFile));
            call = new Lane(Open(CallFile));
            mixer = Open(MixedWav);
        }

        public void Fail(string why) => error ??= why;

        private Lane LaneOf(Side side) => side == Side.Me ? mic : call;

        public void Add(float[] samples, Side side, double time)
        {
            var lane = LaneOf(side);
            var position = (int)Math.Round((time - start) * Rate);
            var skip = 0;
            if (position < 0)
            {
                skip = -position;
                position = 0;
            }
            var count = samples.Length - skip;
            if (end is { } limit) count = Math.Min(count, Math.Max(0, limit - position));
            if (count <= 0) return;
            var chunk = new ArraySegment<float>(samples, skip, count);

            var gap = position - lane.Placed;
            if (gap > Tolerance)
            {
                // The source delivered nothing for a while: silence until this chunk.
                Silence(side, position);
            }
            else if (gap < -Tolerance)
            {
                // Overlaps what is already placed (clock drift, or late after being padded): keep the new part.
                var drop = Math.Min(-gap, chunk.Count);
                chunk = chunk.Slice(drop);
            }
            if (chunk.Count == 0) return;
            Place(chunk.AsSpan(), side);
            KeepUp(side);
            Mix(final: false);
        }

        public void Stop(DateTime date) => end = Math.Max(0, (int)Math.Round((date - startDate).TotalSeconds * Rate));

        public AudioRecording Close()
        {
            // A chunk can run a little past the end: the files are as long as the longest side.
            var length = Math.Max(end ?? 0, Math.Max(mic.Placed, call.Placed));
            Silence(Side.Me, length);
            Silence(Side.Others, length);
            Mix(final: true);
            mic.File?.Close();
            call.File?.Close();
            mixer?.Close();
            return new AudioRecording(folder, mixer is not null && !mixFailed ? Path.Combine(folder, MixedWav) : null, length / Rate, error);
        }

        public void Cancel()
        {
            mic.File?.Close();
            call.File?.Close();
            mixer?.Close();
            try
            {
                Directory.Delete(folder, recursive: true);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
            }
        }

        // MARK: Writing

        private void Place(ReadOnlySpan<float> samples, Side side)
        {
            if (samples.IsEmpty) return;
            var lane = LaneOf(side);
            if (lane.File is null || !lane.File.Write(samples)) error ??= "Couldn't write the call's audio";
            foreach (var sample in samples) lane.Unmixed.Add(sample);
            lane.Placed += samples.Length;
        }

        private void Silence(Side side, int position)
        {
            while (LaneOf(side).Placed < position)
            {
                Place(new float[Math.Min(position - LaneOf(side).Placed, Block)], side);
                KeepUp(side);
                Mix(final: false);
            }
        }

        /// <summary>Fills the other side with silence if it has fallen too far behind this one.</summary>
        private void KeepUp(Side side)
        {
            var other = side == Side.Me ? Side.Others : Side.Me;
            var behind = LaneOf(side).Placed - MaxLag - LaneOf(other).Placed;
            if (behind > 0) Place(new float[behind], other);
        }

        /// <summary>Sums what both sides have placed beyond the mix and writes it.</summary>
        private void Mix(bool final)
        {
            var ready = Math.Min(mic.Placed, call.Placed) - mixed;
            if (ready <= 0 || (!final && ready < (int)(Rate / 10))) return;
            var sum = new float[ready];
            for (var i = 0; i < ready; i++) sum[i] = Math.Clamp(mic.Unmixed[i] + call.Unmixed[i], -1f, 1f);
            mic.Unmixed.RemoveRange(0, ready);
            call.Unmixed.RemoveRange(0, ready);
            mixed += ready;
            if (mixer is not null && !mixer.Write(sum))
            {
                mixFailed = true;
                error ??= "Couldn't write the call's audio";
            }
        }
    }

    /// <summary>A 16-bit PCM, 16 kHz, mono WAV file written as the samples come: the header's sizes are filled in when it is closed.</summary>
    private sealed class WavWriter : IDisposable
    {
        private readonly FileStream stream;
        private long data;

        public WavWriter(string path)
        {
            stream = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read);
            stream.Write(new byte[44]);
        }

        /// <summary>False if the write failed.</summary>
        public bool Write(ReadOnlySpan<float> samples)
        {
            var bytes = new byte[samples.Length * 2];
            for (var i = 0; i < samples.Length; i++)
                BinaryPrimitives.WriteInt16LittleEndian(bytes.AsSpan(i * 2), (short)Math.Round(Math.Clamp(samples[i], -1f, 1f) * short.MaxValue));
            try
            {
                stream.Write(bytes);
                data += bytes.Length;
                return true;
            }
            catch (IOException)
            {
                return false;
            }
        }

        public void Close()
        {
            try
            {
                var header = new byte[44];
                "RIFF"u8.CopyTo(header);
                BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(4), (uint)(36 + data));
                "WAVEfmt "u8.CopyTo(header.AsSpan(8));
                BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(16), 16);
                BinaryPrimitives.WriteUInt16LittleEndian(header.AsSpan(20), 1); // PCM
                BinaryPrimitives.WriteUInt16LittleEndian(header.AsSpan(22), 1); // mono
                BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(24), (uint)Audio.SampleRate);
                BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(28), (uint)Audio.SampleRate * 2);
                BinaryPrimitives.WriteUInt16LittleEndian(header.AsSpan(32), 2);
                BinaryPrimitives.WriteUInt16LittleEndian(header.AsSpan(34), 16);
                "data"u8.CopyTo(header.AsSpan(36));
                BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(40), (uint)data);
                stream.Seek(0, SeekOrigin.Begin);
                stream.Write(header);
            }
            catch (IOException)
            {
            }
            finally
            {
                stream.Dispose();
            }
        }

        public void Dispose() => Close();
    }
}
