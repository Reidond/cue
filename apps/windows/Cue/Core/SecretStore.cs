using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace Cue;

/// <summary>
/// A secret kept in Windows Credential Manager (a generic credential per account), like the Mac's keychain item; under CUE_HOME in
/// `CUE_HOME/Keychain.json` instead, so end-to-end runs never read or change the user's own.
/// </summary>
public static class SecretStore
{
    private const string Service = "com.andriishafar.cue";
    private static string? SandboxFile => Storage.Home is { } home ? Path.Combine(home, "Keychain.json") : null;

    public static string? Get(string account)
    {
        if (SandboxFile is { } file) return Sandbox(file).GetValueOrDefault(account);
        if (!CredRead(Target(account), CredTypeGeneric, 0, out var pointer)) return null;
        try
        {
            var credential = Marshal.PtrToStructure<Credential>(pointer);
            if (credential.CredentialBlob == IntPtr.Zero || credential.CredentialBlobSize == 0) return null;
            var bytes = new byte[credential.CredentialBlobSize];
            Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
            return Encoding.UTF8.GetString(bytes);
        }
        finally
        {
            CredFree(pointer);
        }
    }

    public static void Set(string value, string account, string label)
    {
        if (SandboxFile is { } file)
        {
            var secrets = Sandbox(file);
            secrets[account] = value;
            Write(file, secrets);
            return;
        }
        var bytes = Encoding.UTF8.GetBytes(value);
        var blob = Marshal.AllocHGlobal(bytes.Length);
        var target = Marshal.StringToHGlobalUni(Target(account));
        var comment = Marshal.StringToHGlobalUni(label);
        var user = Marshal.StringToHGlobalUni(account);
        try
        {
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            var credential = new Credential
            {
                Type = CredTypeGeneric,
                TargetName = target,
                Comment = comment,
                CredentialBlobSize = (uint)bytes.Length,
                CredentialBlob = blob,
                Persist = CredPersistLocalMachine,
                UserName = user,
            };
            if (!CredWrite(ref credential, 0))
                throw new CueApiException(CueApiError.Server, $"Couldn't save it in Windows Credential Manager: {new Win32Exception().Message}");
        }
        finally
        {
            Marshal.FreeHGlobal(blob);
            Marshal.FreeHGlobal(target);
            Marshal.FreeHGlobal(comment);
            Marshal.FreeHGlobal(user);
        }
    }

    public static void Remove(string account)
    {
        if (SandboxFile is { } file)
        {
            var secrets = Sandbox(file);
            if (secrets.Remove(account)) Write(file, secrets);
            return;
        }
        CredDelete(Target(account), CredTypeGeneric, 0);
    }

    private static string Target(string account) => $"{Service}/{account}";

    private static Dictionary<string, string> Sandbox(string file)
    {
        try
        {
            return JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(file)) ?? [];
        }
        catch (Exception e) when (e is IOException or JsonException)
        {
            return [];
        }
    }

    private static void Write(string file, Dictionary<string, string> secrets) =>
        Storage.WriteAtomically(file, JsonSerializer.Serialize(secrets.OrderBy(pair => pair.Key, StringComparer.Ordinal).ToDictionary()));

    private const uint CredTypeGeneric = 1;
    private const uint CredPersistLocalMachine = 2;

    [StructLayout(LayoutKind.Sequential)]
    private struct Credential
    {
        public uint Flags;
        public uint Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite(ref Credential credential, uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDelete(string target, uint type, uint flags);

    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr buffer);
}
