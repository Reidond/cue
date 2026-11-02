using System.Buffers.Binary;
using System.Diagnostics;
using System.Net.WebSockets;

namespace Cue;

/// <summary>The audio Cue works with: 16 kHz, mono, as the speech services take it, and the host clock both sources are stamped with.</summary>
public static class Audio
{
    public const double SampleRate = 16_000;

    /// <summary>Now on the host clock, in seconds: the capture sources timestamp their audio with it (WASAPI's QPC positions are on the same clock).</summary>
    public static double HostSeconds() => Stopwatch.GetTimestamp() / (double)Stopwatch.Frequency;
}

/// <summary>
/// Turns what the capture threads deliver into the socket's binary frames: one byte for the channel (0 me, 1 others) and 16-bit little-endian PCM
/// (packages/contract: <c>AUDIO</c>). The server's clock is the samples it gets, so a source that delivers nothing for a while (WASAPI's loopback while the PC
/// plays nothing) is filled with silence by the host clock, and so is the stretch a dropped socket lost, up to <see cref="MaxGap"/>.
/// Thread-safe: the capture threads push, the UI thread connects and disconnects.
/// </summary>
public sealed class AudioSink
{
    private sealed class Lane
    {
        /// <summary>Host time (seconds) the audio sent or waiting ends at.</summary>
        public double End;

        public readonly List<float> Pending = [];
    }

    /// <summary>A frame is at least this many samples (100 ms).</summary>
    private const int Frame = (int)(Audio.SampleRate / 10);

    /// <summary>A gap bigger than this is not filled in.</summary>
    private const double MaxGap = 20;

    /// <summary>A source quieter than this long is silent, not late.</summary>
    private const double Lateness = 0.4;

    private readonly object gate = new();
    private readonly Dictionary<Side, Lane> lanes = [];

    /// <summary>The sources really open: their lanes start with the call, so a call side that stays silent for a while still has its clock.</summary>
    private readonly HashSet<Side> expected = [];

    private LiveSocket? socket;
    private Timer? timer;

    /// <summary>`samples` were captured from `time` (host seconds) on. Dropped while there is no socket.</summary>
    public void Push(float[] samples, Side side, double time)
    {
        lock (gate)
        {
            if (socket is null || samples.Length == 0) return;
            var lane = LaneOf(side, time);
            // Audio that comes later than the last one ended: the source was silent, or the socket was down.
            if (time - lane.End > 0.25) Fill(lane, Math.Min(time - lane.End, MaxGap));
            lane.Pending.AddRange(samples);
            lane.End += samples.Length / Audio.SampleRate;
            Flush(lane, side);
        }
    }

    private Lane LaneOf(Side side, double time)
    {
        if (!lanes.TryGetValue(side, out var lane)) lanes[side] = lane = new Lane { End = time };
        return lane;
    }

    /// <summary>A source that is really open (the microphone, the call audio): its clock runs from the moment the socket is up.</summary>
    public void Expect(Side side)
    {
        lock (gate) expected.Add(side);
    }

    /// <summary>A source that closed: its clock no longer runs with the call's.</summary>
    public void Forget(Side side)
    {
        lock (gate)
        {
            expected.Remove(side);
            lanes.Remove(side);
        }
    }

    public void Connect(LiveSocket live)
    {
        lock (gate)
        {
            socket = live;
            var now = Audio.HostSeconds();
            foreach (var side in expected) LaneOf(side, now);
            timer ??= new Timer(_ => FillSilence(), null, 100, 100);
        }
    }

    /// <summary>The socket is gone (maybe for a moment): what waited for it is dropped.</summary>
    public void Disconnect()
    {
        lock (gate)
        {
            socket = null;
            foreach (var lane in lanes.Values) lane.Pending.Clear();
        }
    }

    public void Stop()
    {
        lock (gate)
        {
            socket = null;
            timer?.Dispose();
            timer = null;
            lanes.Clear();
        }
    }

    /// <summary>Keeps the server's clock going for a source that has delivered nothing lately.</summary>
    private void FillSilence()
    {
        lock (gate)
        {
            if (socket is null) return;
            var now = Audio.HostSeconds();
            foreach (var (side, lane) in lanes)
            {
                if (now - lane.End <= Lateness) continue;
                Fill(lane, Math.Min(now - lane.End - 0.1, MaxGap));
                Flush(lane, side);
            }
        }
    }

    private static void Fill(Lane lane, double seconds)
    {
        if (seconds <= 0) return;
        var count = (int)(seconds * Audio.SampleRate);
        lane.Pending.AddRange(new float[count]);
        lane.End += count / Audio.SampleRate;
    }

    private void Flush(Lane lane, Side side)
    {
        if (socket is null || lane.Pending.Count < Frame) return;
        var data = new byte[1 + lane.Pending.Count * 2];
        data[0] = side == Side.Me ? (byte)0 : (byte)1;
        for (var i = 0; i < lane.Pending.Count; i++)
            BinaryPrimitives.WriteInt16LittleEndian(data.AsSpan(1 + i * 2), (short)(Math.Clamp(lane.Pending[i], -1f, 1f) * short.MaxValue));
        lane.Pending.Clear();
        socket.TrySend(data, WebSocketMessageType.Binary);
    }
}

/// <summary>How loud a source is right now, smoothed, for the level meters.</summary>
public sealed class LevelMeter
{
    private float level;

    /// <summary>Written by a capture thread, read by the UI one: stale at worst.</summary>
    public float Level => Volatile.Read(ref level);

    public void Add(ReadOnlySpan<float> samples)
    {
        if (samples.Length == 0) return;
        var sum = 0f;
        foreach (var sample in samples) sum += sample * sample;
        var rms = MathF.Sqrt(sum / samples.Length);
        Volatile.Write(ref level, level * 0.7f + rms * 0.3f);
    }
}
