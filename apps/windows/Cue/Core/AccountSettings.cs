namespace Cue;

/// <summary>
/// The settings that are the person's, not this PC's: their name, Auto, questions from the room, summaries and keeping audio. They are kept in the Cue
/// account (`Me.settings`, `PATCH /v1/me/settings`), so every Mac and PC the person signs in to follows them and the server makes calls and notes with
/// them. <see cref="Preferences"/> keeps the local copy, which is what the app reads; while someone is signed in the account is the truth. At sign-in
/// the account gets the ones it has none of from this PC, then its own are put into the preferences, and again on every look at the account (another
/// device may have changed them); a change made here goes to the account (the name a moment after the last keystroke). The session log says what is
/// in effect (`⚙️ Settings: …`) whenever that changes.
/// </summary>
public sealed class AccountSettings
{
    /// <summary>A setting: its name in the account (and in `setting KEY | VALUE`) and in <see cref="Preferences"/>, its value here and there.</summary>
    private sealed record Field(string Key, string Property, Func<Preferences, object> Local, Action<Preferences, object> Use, Func<CueMe.SettingsInfo, object?> Account)
    {
        public bool IsName => Key == "speakerName";
    }

    private static readonly Field[] Fields =
    [
        new("speakerName", nameof(Preferences.SpeakerName), p => p.SpeakerName, (p, value) => p.SpeakerName = (string)value, s => s.SpeakerName),
        new("autoAnswer", nameof(Preferences.AutoAnswer), p => p.AutoAnswer, (p, value) => p.AutoAnswer = (bool)value, s => s.AutoAnswer),
        new("micQuestions", nameof(Preferences.MicQuestions), p => p.MicQuestions, (p, value) => p.MicQuestions = (bool)value, s => s.MicQuestions),
        new("summarize", nameof(Preferences.SummarizeRecordings), p => p.SummarizeRecordings, (p, value) => p.SummarizeRecordings = (bool)value, s => s.Summarize),
        new("keepAudio", nameof(Preferences.KeepAudio), p => p.KeepAudio, (p, value) => p.KeepAudio = (bool)value, s => s.KeepAudio),
    ];

    private readonly CueApi api;
    private readonly SessionLog log;
    private readonly Preferences preferences;

    /// <summary>Saves go one after another, in the order they were made.</summary>
    private readonly SemaphoreSlim saving = new(1, 1);

    /// <summary>Changes made here, counted per setting: a save that ends after a newer change leaves it to that one's save.</summary>
    private readonly Dictionary<string, int> edits = [];

    /// <summary>
    /// Per setting, the account's reads (<see cref="CueApi.MeReads"/>) that may not know of what was saved here: every one while a save is under way,
    /// the ones asked for before it ended after it. Their value for it is not put back.
    /// </summary>
    private readonly Dictionary<string, long> unsaved = [];

    /// <summary>What the account has of each setting as far as this PC knows: from the reads that know of the saves made here, and from those saves'
    /// answers. A save the account refuses puts it back.</summary>
    private readonly Dictionary<string, object> known = [];

    private CancellationTokenSource? nameSave;

    /// <summary>Someone is signed in and the sign-in's look at the settings is done: the account's are followed, and changes go to it.</summary>
    private bool following;

    /// <summary>The account's values are being put into the preferences: not a change made here.</summary>
    private bool applying;

    /// <summary>What the session log said last (`⚙️ Settings: …`); null while signed out.</summary>
    private string? said;

    public AccountSettings(CueApi api, SessionLog log, Preferences preferences)
    {
        this.api = api;
        this.log = log;
        this.preferences = preferences;
        // Whatever changes one (Settings › General, the overlay's Auto and its hot key, `setting`) changes the preference: it goes to the account from there.
        preferences.PropertyChanged += (_, e) =>
        {
            if (!applying && Fields.FirstOrDefault(known => known.Property == e.PropertyName) is { } field) Changed(field);
        };
        api.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName == nameof(CueApi.Me) && following && api.Settings is { } account)
            {
                Use(account);
                Say();
            }
            else if (e.PropertyName == nameof(CueApi.Phase) && api.Phase == Phase.SignedOut)
            {
                Forget();
            }
        };
    }

    /// <summary>
    /// At sign-in, before anything else (a call or a recording goes by them): the account gets this PC's value of each setting it has none of yet (the
    /// first sign-in since it keeps them: `📦 Imported your settings from this PC`), then the account's are put into the preferences.
    /// </summary>
    public async Task SyncWithAccount()
    {
        // A backend that keeps none: this PC's stay as they are.
        if (api.Settings is not { } account) return;
        var missing = Fields.Where(field => field.Account(account) is null).ToDictionary(field => field.Key, field => field.Local(preferences));
        if (missing.Count > 0)
        {
            try
            {
                account = await api.SaveSettings(missing);
                log.Write("📦 Imported your settings from this PC");
            }
            catch (CueApiException e)
            {
                log.Write($"{SessionLog.Warning} Couldn't save your settings: {e.Message}");
            }
        }
        following = true;
        Use(account);
        Say();
    }

    /// <summary>
    /// `setting KEY | VALUE`: what changing it in Settings › General does. KEY is the account's name for it (`speakerName`, `autoAnswer`,
    /// `micQuestions`, `summarize`, `keepAudio`); VALUE the name, or `on`/`off` (`true`/`false`) for a switch.
    /// </summary>
    public void Change(string key, string value)
    {
        if (Fields.FirstOrDefault(known => known.Key == key) is not { } field) return;
        if (field.IsName)
        {
            field.Use(preferences, value);
        }
        else if (value.ToLowerInvariant() is "on" or "true" or "off" or "false")
        {
            field.Use(preferences, value.ToLowerInvariant() is "on" or "true");
        }
    }

    /// <summary>The person changed one here: saved to the account while signed in (the name once they stop typing); signed out it stays on this PC.</summary>
    private void Changed(Field field)
    {
        if (!following) return;
        edits[field.Key] = edits.GetValueOrDefault(field.Key) + 1;
        unsaved[field.Key] = long.MaxValue;
        if (!field.IsName)
        {
            _ = Save(field);
            return;
        }
        nameSave?.Cancel();
        var later = new CancellationTokenSource();
        nameSave = later;
        _ = SaveLater(field, later.Token);
    }

    private async Task SaveLater(Field field, CancellationToken later)
    {
        try
        {
            await Task.Delay(TimeSpan.FromMilliseconds(800), later);
        }
        catch (OperationCanceledException)
        {
            return;
        }
        await Save(field);
    }

    private async Task Save(Field field)
    {
        await saving.WaitAsync();
        try
        {
            // Signed out meanwhile, or an earlier save already took this change along.
            if (!following || unsaved.GetValueOrDefault(field.Key) != long.MaxValue) return;
            var edit = edits.GetValueOrDefault(field.Key);
            try
            {
                var saved = await api.SaveSettings(new Dictionary<string, object> { [field.Key] = field.Local(preferences) });
                if (!following) return;
                if (field.Account(saved) is { } value) known[field.Key] = value;
                if (edits.GetValueOrDefault(field.Key) == edit) unsaved[field.Key] = api.MeReads;
                log.Write("☁️ Saved your settings to your account");
                Say();
            }
            catch (CueApiException e)
            {
                if (!following) return;
                log.Write($"{SessionLog.Warning} Couldn't save your settings: {e.Message}");
                if (edits.GetValueOrDefault(field.Key) != edit) return;
                // The account still has what it had: so does this PC.
                unsaved.Remove(field.Key);
                if (known.TryGetValue(field.Key, out var was)) Apply(field, was);
            }
        }
        finally
        {
            saving.Release();
        }
    }

    /// <summary>The account's values into the preferences (and their copy in settings.json), but not over one whose save the read may not know of.</summary>
    private void Use(CueMe.SettingsInfo account)
    {
        foreach (var field in Fields)
        {
            if (field.Account(account) is { } value && api.MeRead > unsaved.GetValueOrDefault(field.Key))
            {
                known[field.Key] = value;
                Apply(field, value);
            }
        }
    }

    private void Apply(Field field, object value)
    {
        applying = true;
        try
        {
            field.Use(preferences, value);
        }
        finally
        {
            applying = false;
        }
    }

    /// <summary>`⚙️ Settings: …`: the settings in effect, whenever they differ from what the log said last (at sign-in, after another device's
    /// change arrives, after a save here).</summary>
    private void Say()
    {
        if (!following) return;
        static string OnOff(bool on) => on ? "on" : "off";
        var name = preferences.SpeakerName.Length == 0 ? "no name" : $"name “{preferences.SpeakerName}”";
        var line = $"⚙️ Settings: {name}, Auto {OnOff(preferences.AutoAnswer)}, questions from the room {OnOff(preferences.MicQuestions)}, "
            + $"summaries {OnOff(preferences.SummarizeRecordings)}, audio {(preferences.KeepAudio ? "kept" : "not kept")}";
        if (line == said) return;
        said = line;
        log.Write(line);
    }

    /// <summary>Signed out: changes stay on this PC, a name not saved yet isn't, and the next sign-in says the settings again.</summary>
    private void Forget()
    {
        following = false;
        said = null;
        nameSave?.Cancel();
        nameSave = null;
        unsaved.Clear();
        known.Clear();
    }
}

/// <summary>`setting KEY | VALUE` (Settings › General; it works signed out, as Settings does): see <see cref="AccountSettings.Change"/>.</summary>
internal static class SettingCommands
{
    public static void Register(AppState state) =>
        state.Control.Register("setting", argument =>
        {
            var bar = argument.IndexOf('|', StringComparison.Ordinal);
            if (bar > 0) state.Settings.Change(argument[..bar].Trim(), argument[(bar + 1)..].Trim());
            return Task.CompletedTask;
        }, needsSignIn: false);
}
