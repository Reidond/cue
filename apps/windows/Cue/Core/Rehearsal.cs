using System.Buffers.Binary;
using System.Diagnostics;

namespace Cue;

/// <summary>
/// Rehearsal mode: plays an audio file into a channel as if it were live speech (CUE_REHEARSE_PARTICIPANT=FILE for the call, CUE_REHEARSE_ME=FILE for your
/// microphone). It stands in for the system at the exact point audio is read from it: what comes after (the meters, the sink, the socket, the backend) is
/// the real thing. Handy for testing the whole pipeline with recorded questions, and for the end-to-end cases, which have no microphone.
/// </summary>
public static class Rehearsal
{
    /// <summary>
    /// Pushes 0.1 s chunks in real time, each with the host time it is "captured" at, like the live sources do. Returns the playback length in seconds.
    /// The file is a WAV (16-, 24- or 32-bit PCM or 32-bit float, any rate and channel count).
    /// </summary>
    public static double Play(string path, Action<float[], double> push)
    {
        float[] samples = [.. Read(path), .. new float[(int)(Audio.SampleRate * 3)]]; // trailing silence lets the last utterance end as live speech would
        const int chunk = (int)(Audio.SampleRate / 10);
        var host = Audio.HostSeconds();
        var thread = new Thread(() =>
        {
            var clock = Stopwatch.StartNew();
            for (var start = 0; start < samples.Length; start += chunk)
            {
                var offset = start / Audio.SampleRate;
                push(samples[start..Math.Min(start + chunk, samples.Length)], host + offset);
                var wait = offset + 0.1 - clock.Elapsed.TotalSeconds;
                if (wait > 0) Thread.Sleep(TimeSpan.FromSeconds(wait));
            }
        })
        {
            IsBackground = true,
            Name = "Cue rehearsal",
        };
        thread.Start();
        return samples.Length / Audio.SampleRate;
    }

    /// <summary>The file's samples as 16 kHz mono floats.</summary>
    public static float[] Read(string path)
    {
        var bytes = File.ReadAllBytes(path);
        if (bytes.Length < 12 || !bytes.AsSpan(0, 4).SequenceEqual("RIFF"u8) || !bytes.AsSpan(8, 4).SequenceEqual("WAVE"u8))
            throw new InvalidDataException("not a WAV file");
        int format = 0, channels = 0, rate = 0, bits = 0;
        var offset = 12;
        while (offset + 8 <= bytes.Length)
        {
            var id = bytes.AsSpan(offset, 4);
            var size = (int)Math.Min(BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(offset + 4)), (uint)(bytes.Length - offset - 8));
            var body = offset + 8;
            if (id.SequenceEqual("fmt "u8))
            {
                format = BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(body));
                channels = BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(body + 2));
                rate = (int)BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(body + 4));
                bits = BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(body + 14));
                // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the sub-format GUID.
                if (format == 0xFFFE && size >= 26) format = BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(body + 24));
            }
            else if (id.SequenceEqual("data"u8))
            {
                if (channels == 0 || rate == 0) throw new InvalidDataException("no format before the audio");
                return new Resampler(rate, channels).Process(Decode(bytes.AsSpan(body, size), format, bits));
            }
            offset = body + size + (size & 1);
        }
        throw new InvalidDataException("no audio in the file");
    }

    private static float[] Decode(ReadOnlySpan<byte> data, int format, int bits)
    {
        var width = bits / 8;
        if (width is < 2 or > 4 || (format != 1 && format != 3)) throw new InvalidDataException($"unsupported audio format (tag {format}, {bits} bits)");
        var output = new float[data.Length / width];
        for (var i = 0; i < output.Length; i++)
        {
            var sample = data[(i * width)..];
            output[i] = (format, bits) switch
            {
                (1, 16) => BinaryPrimitives.ReadInt16LittleEndian(sample) / 32768f,
                (1, 24) => ((sample[0] << 8 | sample[1] << 16 | sample[2] << 24) >> 8) / 8388608f,
                (1, 32) => BinaryPrimitives.ReadInt32LittleEndian(sample) / 2147483648f,
                (3, 32) => BinaryPrimitives.ReadSingleLittleEndian(sample),
                _ => throw new InvalidDataException($"unsupported audio format (tag {format}, {bits} bits)"),
            };
        }
        return output;
    }
}
