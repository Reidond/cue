using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Cue;

/// <summary>Why audio could not be opened, worded for the status line (the Mac's `CaptureError`).</summary>
public sealed class CaptureException(string message) : Exception(message);

/// <summary>Where audio is taken from.</summary>
public enum CaptureSource
{
    /// <summary>The default microphone: the presenter's own voice.</summary>
    Microphone,

    /// <summary>Everything the PC plays except Cue's own process tree (WASAPI process loopback; Windows 10 build 20348 and Windows 11): the other people on the call.</summary>
    CallExcludingCue,

    /// <summary>Everything the default speakers play, Cue's own sound included: where process loopback is not available.</summary>
    CallEndpoint,
}

/// <summary>
/// One WASAPI capture stream, delivering 16 kHz mono samples (floats in -1…1) with the host time the first of them was captured at, from its own thread:
/// <see cref="OnSamples"/> must be thread-safe (the sink and the meters are). The format is asked of the audio engine, which converts (`AUTOCONVERTPCM`);
/// where it will not, 48 kHz stereo is taken and converted here. The recordings slice can subscribe to <see cref="LiveModel.Samples"/> for both sides.
/// </summary>
public sealed class WasapiCapture : IDisposable
{
    private readonly CaptureSource source;
    private IAudioClient? client;
    private IAudioCaptureClient? capture;
    private IntPtr eventHandle;
    private Thread? thread;
    private volatile bool stopping;
    private int rate;
    private int channels;
    private Resampler? resampler;

    public WasapiCapture(CaptureSource source) => this.source = source;

    public Action<float[], double> OnSamples { get; set; } = (_, _) => { };

    /// <summary>The stream broke after it started (the device was unplugged, say). Says why.</summary>
    public Action<string> OnStopped { get; set; } = _ => { };

    /// <summary>
    /// Opens the stream and starts delivering. Throws <see cref="CaptureException"/> with a sentence for the person. The stream's COM objects are made, used
    /// and let go of on one thread of their own (a multithreaded apartment): the audio client is not one that can be called from another apartment, the UI's.
    /// </summary>
    public void Start()
    {
        var opened = new TaskCompletionSource();
        thread = new Thread(() => Run(opened)) { IsBackground = true, Name = $"Cue {source} capture", Priority = ThreadPriority.AboveNormal };
        thread.SetApartmentState(ApartmentState.MTA);
        thread.Start();
        opened.Task.GetAwaiter().GetResult();
    }

    private void Open()
    {
        var attempts = new[] { (Rate: 16_000, Channels: 1), (Rate: 48_000, Channels: 2) };
        var failure = 0;
        foreach (var (attemptRate, attemptChannels) in attempts)
        {
            var audio = Activate();
            var format = WasapiNative.Pcm16(attemptRate, attemptChannels);
            try
            {
                var flags = WasapiNative.StreamEventCallback | WasapiNative.StreamAutoConvertPcm | WasapiNative.StreamSrcDefaultQuality
                    | (source == CaptureSource.Microphone ? 0 : WasapiNative.StreamLoopback);
                failure = audio.Initialize(WasapiNative.Shared, flags, 200_000, 0, format, IntPtr.Zero);
                if (failure < 0)
                {
                    Marshal.ReleaseComObject(audio);
                    continue;
                }
            }
            finally
            {
                Marshal.FreeHGlobal(format);
            }
            client = audio;
            rate = attemptRate;
            channels = attemptChannels;
            break;
        }
        if (client is null) throw Failed(failure);
        resampler = rate == (int)Audio.SampleRate && channels == 1 ? null : new Resampler(rate, channels);

        eventHandle = WasapiNative.CreateEventW(IntPtr.Zero, false, false, IntPtr.Zero);
        Check(client.SetEventHandle(eventHandle));
        var iid = WasapiNative.IAudioCaptureClientId;
        Check(client.GetService(ref iid, out var service));
        capture = (IAudioCaptureClient)service;
        Check(client.Start());
    }

    private void Check(int result)
    {
        if (result < 0) throw Failed(result);
    }

    private IAudioClient Activate()
    {
        switch (source)
        {
            case CaptureSource.CallExcludingCue:
                return ActivateProcessLoopback();
            default:
                var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorClass();
                var flow = source == CaptureSource.Microphone ? WasapiNative.Capture : WasapiNative.Render;
                var result = enumerator.GetDefaultAudioEndpoint(flow, WasapiNative.Console, out var device);
                if (result < 0) throw Failed(result);
                var iid = WasapiNative.IAudioClientId;
                result = device.Activate(ref iid, WasapiNative.ClsctxAll, IntPtr.Zero, out var audio);
                if (result < 0) throw Failed(result);
                return (IAudioClient)audio;
        }
    }

    /// <summary>The virtual device that hears every process but Cue's own tree.</summary>
    private static IAudioClient ActivateProcessLoopback()
    {
        var parameters = WasapiNative.ProcessLoopbackParameters((uint)Environment.ProcessId, out var blob);
        try
        {
            var handler = new ActivationHandler();
            var iid = WasapiNative.IAudioClientId;
            var result = WasapiNative.ActivateAudioInterfaceAsync(WasapiNative.ProcessLoopbackDevice, ref iid, parameters, handler, out var operation);
            if (result < 0) throw new CaptureException($"Windows does not offer process loopback ({Describe(result)})");
            if (!handler.Wait(TimeSpan.FromSeconds(10))) throw new CaptureException("Windows did not answer the request for call audio");
            GC.KeepAlive(operation);
            if (handler.Result < 0 || handler.Activated is not IAudioClient audio)
                throw new CaptureException($"Windows does not offer process loopback ({Describe(handler.Result)})");
            return audio;
        }
        finally
        {
            Marshal.FreeHGlobal(blob);
            Marshal.FreeHGlobal(parameters);
        }
    }

    private CaptureException Failed(int result)
    {
        var code = (uint)result;
        var what = source == CaptureSource.Microphone ? "microphone" : "call audio";
        return code switch
        {
            0x80070490 => new CaptureException(source == CaptureSource.Microphone ? "No microphone found" : "No speakers found to hear the call through"),
            0x80070005 or 0x88890010 => new CaptureException(
                source == CaptureSource.Microphone
                    ? "Microphone access denied (Settings › Privacy & security › Microphone: allow desktop apps to use it)"
                    : "No access to call audio"),
            _ => new CaptureException($"Couldn't open the {what}: {Describe(result)}"),
        };
    }

    private static string Describe(int result) => Marshal.GetExceptionForHR(result)?.Message.TrimEnd('.') ?? $"0x{(uint)result:X8}";

    private void Run(TaskCompletionSource opened)
    {
        try
        {
            Open();
        }
        catch (Exception e)
        {
            Release();
            opened.SetException(e);
            return;
        }
        opened.SetResult();
        try
        {
            while (!stopping)
            {
                WasapiNative.WaitForSingleObject(eventHandle, 100);
                if (stopping) break;
                Drain();
            }
        }
        catch (Exception e)
        {
            if (!stopping) OnStopped(e.Message);
        }
        finally
        {
            Release();
        }
    }

    /// <summary>Delivers every packet waiting. During silence a loopback stream has none, and the sink fills the clock in.</summary>
    private void Drain()
    {
        if (capture is null) return;
        for (;;)
        {
            Check(capture.GetNextPacketSize(out var packet));
            if (packet == 0) return;
            Check(capture.GetBuffer(out var data, out var frames, out var flags, out _, out var qpc));
            try
            {
                var count = (int)frames * channels;
                var samples = new float[count];
                if ((flags & WasapiNative.BufferSilent) == 0 && count > 0)
                {
                    var pcm = new short[count];
                    Marshal.Copy(data, pcm, 0, count);
                    for (var i = 0; i < count; i++) samples[i] = pcm[i] / 32768f;
                }
                var mono = resampler is null ? samples : resampler.Process(samples);
                if (mono.Length == 0) continue;
                // QPC positions are in 100 ns units on the clock the host seconds count (Stopwatch).
                var time = (flags & WasapiNative.BufferTimestampError) == 0 && qpc != 0
                    ? qpc / 10_000_000.0
                    : Audio.HostSeconds() - frames / (double)rate;
                OnSamples(mono, time);
            }
            finally
            {
                capture.ReleaseBuffer(frames);
            }
        }
    }

    /// <summary>Stops the stream: the capture's own thread stops it and lets go of what it holds.</summary>
    public void Dispose()
    {
        stopping = true;
        if (thread is { } running && running != Thread.CurrentThread) running.Join(2000);
    }

    private void Release()
    {
        try
        {
            client?.Stop();
        }
        catch (COMException)
        {
        }
        if (capture is not null) Marshal.ReleaseComObject(capture);
        if (client is not null) Marshal.ReleaseComObject(client);
        capture = null;
        client = null;
        if (eventHandle != IntPtr.Zero) WasapiNative.CloseHandle(eventHandle);
        eventHandle = IntPtr.Zero;
    }
}

/// <summary>Converts audio of any rate and channel count to 16 kHz mono floats, as it streams: linear interpolation, enough for speech.</summary>
public sealed class Resampler
{
    private readonly double step;
    private readonly int channels;
    private double position;
    private float previous;

    public Resampler(int inputRate, int channels)
    {
        step = inputRate / Audio.SampleRate;
        this.channels = Math.Max(channels, 1);
    }

    /// <summary>Interleaved samples in; the 16 kHz mono ones they make out. What is left over waits for the next call.</summary>
    public float[] Process(ReadOnlySpan<float> interleaved)
    {
        var frames = interleaved.Length / channels;
        var mono = new float[frames];
        for (var i = 0; i < frames; i++)
        {
            var sum = 0f;
            for (var c = 0; c < channels; c++) sum += interleaved[i * channels + c];
            mono[i] = sum / channels;
        }
        if (Math.Abs(step - 1) < 1e-9) return mono;
        var output = new List<float>((int)(frames / step) + 2);
        float At(int index) => index < 0 ? previous : mono[index];
        for (;;)
        {
            var index = (int)Math.Floor(position);
            if (index + 1 >= frames) break;
            var fraction = (float)(position - index);
            output.Add(At(index) * (1 - fraction) + At(index + 1) * fraction);
            position += step;
        }
        position -= frames;
        if (frames > 0) previous = mono[^1];
        return [.. output];
    }
}
