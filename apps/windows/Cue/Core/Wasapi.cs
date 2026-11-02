using System.Runtime.InteropServices;

namespace Cue;

// The few WASAPI (Core Audio) interfaces Cue captures with, declared by hand. NAudio would do for the microphone, but not for the call audio: process loopback
// (`ActivateAudioInterfaceAsync` with the virtual device `VAD\Process_Loopback`, which hears everything the PC plays except Cue's own process tree) is not in it,
// and with direct interop one code path serves the microphone, process loopback and the default render endpoint's loopback.

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
internal class MMDeviceEnumeratorClass
{
}

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDeviceEnumerator
{
    [PreserveSig]
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);

    [PreserveSig]
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDevice
{
    [PreserveSig]
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object activated);
}

[ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioClient
{
    [PreserveSig]
    int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);

    [PreserveSig]
    int GetBufferSize(out uint frames);

    [PreserveSig]
    int GetStreamLatency(out long latency);

    [PreserveSig]
    int GetCurrentPadding(out uint frames);

    [PreserveSig]
    int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);

    [PreserveSig]
    int GetMixFormat(out IntPtr format);

    [PreserveSig]
    int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);

    [PreserveSig]
    int Start();

    [PreserveSig]
    int Stop();

    [PreserveSig]
    int Reset();

    [PreserveSig]
    int SetEventHandle(IntPtr eventHandle);

    [PreserveSig]
    int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}

[ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioCaptureClient
{
    [PreserveSig]
    int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);

    [PreserveSig]
    int ReleaseBuffer(uint frames);

    [PreserveSig]
    int GetNextPacketSize(out uint frames);
}

[ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IActivateAudioInterfaceAsyncOperation
{
    [PreserveSig]
    int GetActivateResult(out int result, [MarshalAs(UnmanagedType.IUnknown)] out object activated);
}

[ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IActivateAudioInterfaceCompletionHandler
{
    [PreserveSig]
    int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
}

/// <summary>Marks an object as callable from any thread: Windows calls a completion handler from its own, and refuses one that does not say so.</summary>
[ComImport, Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAgileObject
{
}

/// <summary>Collects the result of <c>ActivateAudioInterfaceAsync</c>.</summary>
[ClassInterface(ClassInterfaceType.None)]
internal sealed class ActivationHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
{
    private readonly ManualResetEventSlim done = new(false);

    public int Result { get; private set; } = unchecked((int)0x80004005);

    public object? Activated { get; private set; }

    public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
    {
        var hr = operation.GetActivateResult(out var result, out var activated);
        Result = hr < 0 ? hr : result;
        Activated = Result >= 0 ? activated : null;
        done.Set();
        return 0;
    }

    public bool Wait(TimeSpan timeout) => done.Wait(timeout);
}

internal static class WasapiNative
{
    public const int Render = 0;
    public const int Capture = 1;
    public const int Console = 0;
    public const int ClsctxAll = 23;

    public const int Shared = 0;
    public const int StreamLoopback = 0x00020000;
    public const int StreamEventCallback = 0x00040000;
    public const int StreamAutoConvertPcm = unchecked((int)0x80000000);
    public const int StreamSrcDefaultQuality = 0x08000000;

    public const uint BufferDataDiscontinuity = 0x1;
    public const uint BufferSilent = 0x2;
    public const uint BufferTimestampError = 0x4;

    public static readonly Guid IAudioClientId = new("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
    public static readonly Guid IAudioCaptureClientId = new("C8ADBD64-E71E-48A0-A4DE-185C395CD317");

    public const string ProcessLoopbackDevice = "VAD\\Process_Loopback";

    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = true)]
    public static extern int ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
        ref Guid iid,
        IntPtr activationParams,
        IActivateAudioInterfaceCompletionHandler completionHandler,
        out IActivateAudioInterfaceAsyncOperation operation);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr CreateEventW(IntPtr attributes, bool manualReset, bool initialState, IntPtr name);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll")]
    public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("ole32.dll")]
    public static extern void CoTaskMemFree(IntPtr memory);

    /// <summary>A WAVEFORMATEX for 16-bit PCM, in unmanaged memory (free it with <see cref="Marshal.FreeHGlobal"/>).</summary>
    public static IntPtr Pcm16(int rate, int channels)
    {
        var format = Marshal.AllocHGlobal(18);
        Marshal.WriteInt16(format, 0, 1); // WAVE_FORMAT_PCM
        Marshal.WriteInt16(format, 2, (short)channels);
        Marshal.WriteInt32(format, 4, rate);
        Marshal.WriteInt32(format, 8, rate * channels * 2);
        Marshal.WriteInt16(format, 12, (short)(channels * 2));
        Marshal.WriteInt16(format, 14, 16);
        Marshal.WriteInt16(format, 16, 0);
        return format;
    }

    /// <summary>The PROPVARIANT <c>ActivateAudioInterfaceAsync</c> takes for process loopback: a blob with the target process and the mode (exclude it and its children).</summary>
    public static IntPtr ProcessLoopbackParameters(uint processId, out IntPtr blob)
    {
        // AUDIOCLIENT_ACTIVATION_PARAMS: type PROCESS_LOOPBACK (1), then the target's ID and the mode EXCLUDE_TARGET_PROCESS_TREE (1).
        blob = Marshal.AllocHGlobal(12);
        Marshal.WriteInt32(blob, 0, 1);
        Marshal.WriteInt32(blob, 4, (int)processId);
        Marshal.WriteInt32(blob, 8, 1);
        // PROPVARIANT: vt = VT_BLOB (65) at 0, the blob (size, pointer) at 8 and 16 on a 64-bit process.
        var variant = Marshal.AllocHGlobal(24);
        for (var i = 0; i < 24; i += 8) Marshal.WriteInt64(variant, i, 0);
        Marshal.WriteInt16(variant, 0, 65);
        Marshal.WriteInt32(variant, 8, 12);
        Marshal.WriteIntPtr(variant, 16, blob);
        return variant;
    }
}
