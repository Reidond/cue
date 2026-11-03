using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;

namespace Cue;

/// <summary>
/// Settings › General: who the speaker is, the languages Cue is read in (the account's) and how two of them are laid out (this PC's), what the
/// notes of a recorded call get, and updates. The rest (answers, the library) comes with the slices that have them.
/// </summary>
public sealed class GeneralView : UserControl
{
    private readonly AppState state;
    private readonly StackPanel languages = new() { Spacing = 8 };
    private string languagesShown = "";
    private bool choosing;
    private readonly StackPanel updates = new() { Spacing = 8 };

    public GeneralView(AppState state)
    {
        this.state = state;
        var name = new TextBox
        {
            Text = state.Preferences.SpeakerName,
            PlaceholderText = "How notes and answers refer to you",
            MinWidth = 280,
        };
        AutomationProperties.SetName(name, "Your name");
        name.TextChanged += (_, _) => state.Preferences.SpeakerName = name.Text;
        var row = new Grid { ColumnSpacing = 16 };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.Children.Add(new TextBlock { Text = "Your name", VerticalAlignment = VerticalAlignment.Center });
        Grid.SetColumn(name, 1);
        row.Children.Add(name);

        var preferences = state.Preferences;
        var notes = Ui.Card(
            Ui.Padded(Toggle("Write a summary of each call", null, preferences.SummarizeRecordings, on => preferences.SummarizeRecordings = on)),
            Ui.Padded(Toggle("Keep audio", "Saved next to the notes, about 15 MB per hour", preferences.KeepAudio, on => preferences.KeepAudio = on)));

        Content = new StackPanel
        {
            Spacing = 8,
            Children =
            {
                Ui.Card(Ui.Padded(row)),
                Ui.Header("Languages"),
                languages,
                Ui.Header("Notes"),
                notes,
                Ui.Caption("Win+Alt+C records a call into the current project. Let people know when you record — consent rules vary by place."),
                Ui.Header("Updates"),
                updates,
            },
        };
        // Drawn at once, and again as updating goes on.
        state.Updates.PropertyChanged += OnUpdatesChanged;
        RenderUpdates();
        Unloaded += (_, _) => state.Updates.PropertyChanged -= OnUpdatesChanged;
        RenderLanguages();
        // The account's languages are read at sign-in and now and then (another PC may change them): the pickers follow.
        Loaded += (_, _) => state.Api.PropertyChanged += OnAccountChanged;
        Unloaded += (_, _) => state.Api.PropertyChanged -= OnAccountChanged;
    }

    private void OnUpdatesChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e) => RenderUpdates();

    /// <summary>The version, and for a Cue that updates itself: the switch, where updating is, and Check Now or Restart to Update.</summary>
    private void RenderUpdates()
    {
        updates.Children.Clear();
        var updater = state.Updates;
        if (updater.Feed is null)
        {
            updates.Children.Add(Ui.Card(Ui.Row("Version", updater.Version)));
            return;
        }
        var preferences = state.Preferences;
        var action = new Button { Content = updater.Phase == UpdatePhase.Ready ? "Restart to Update" : "Check Now" };
        action.IsEnabled = updater.Phase is not (UpdatePhase.Checking or UpdatePhase.Downloading);
        action.Click += async (_, _) =>
        {
            if (updater.Phase == UpdatePhase.Ready) updater.Restart();
            else await updater.Check();
        };
        var status = new Grid { ColumnSpacing = 16 };
        status.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        status.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        status.Children.Add(new TextBlock { Text = updater.Status, TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center });
        Grid.SetColumn(action, 1);
        status.Children.Add(action);
        updates.Children.Add(Ui.Card(
            Ui.Row("Version", updater.Version),
            Ui.Padded(Toggle("Update Cue automatically", null, preferences.AutomaticUpdates, on => preferences.AutomaticUpdates = on)),
            Ui.Padded(status)));
        updates.Children.Add(Ui.Caption("Cue looks for a new version when it opens and every few hours, and installs it when Cue restarts, quits or next opens. Windows asks for permission, as Cue is installed for everyone on this PC."));
    }

    private void OnAccountChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e)
    {
        if (e.PropertyName is nameof(CueApi.Me) or nameof(CueApi.Phase)) RenderLanguages();
    }

    // MARK: Languages

    /// <summary>
    /// The Languages group: "Read Cue in" (the first language, or none), then the second once there is a first; with two, how answers and notes lay
    /// them out. The choice goes to the account at once.
    /// </summary>
    private void RenderLanguages()
    {
        var chosen = state.Api.Languages;
        var signedIn = state.Api.IsSignedIn;
        var shown = $"{signedIn}|{string.Join(",", chosen)}";
        if (shown == languagesShown) return;
        languagesShown = shown;
        // A picker that had the keyboard focus has it again in the new card.
        var focused = XamlRoot is { } root && FocusManager.GetFocusedElement(root) is ComboBox box ? AutomationProperties.GetName(box) : null;
        languages.Children.Clear();

        var first = chosen.Count > 0 ? chosen[0] : null;
        var second = chosen.Count > 1 ? chosen[1] : null;
        var rows = new List<UIElement>
        {
            Ui.Padded(Choice(
                "Read Cue in",
                "Answers and notes are in the language spoken in the call",
                LanguagePicker("Read Cue in", first, null, signedIn, code => Save(First(code, first, second))))),
        };
        if (first is not null)
        {
            rows.Add(Ui.Padded(Choice(
                "Second language",
                "Each line of an answer and of a note comes with its translation",
                LanguagePicker("Second language", second, first, signedIn, code => Save(code is null ? new[] { first } : new[] { first, code })))));
        }
        if (second is not null)
        {
            var preferences = state.Preferences;
            rows.Add(Ui.Padded(Choice(
                "Answers",
                "How the overlay shows an answer in both",
                Picker<AnswerLayout>(
                    "Answers",
                    [("Subtitles", AnswerLayout.Subtitles), ("Side by side", AnswerLayout.Mirror), ("Focus", AnswerLayout.Focus)],
                    preferences.AnswerLayout,
                    layout => preferences.AnswerLayout = layout))));
            rows.Add(Ui.Padded(Choice(
                "Notes",
                "How a note shows its translation",
                Picker<NoteLayout>(
                    "Notes",
                    [("Switch between them", NoteLayout.Switch), ("One after another", NoteLayout.Both)],
                    preferences.NoteLayout,
                    layout => preferences.NoteLayout = layout))));
        }
        languages.Children.Add(Ui.Card([.. rows]));
        languages.Children.Add(Ui.Caption(second is null
            ? "Choose two to have every answer and note in both: the language spoken in the call, and the other one beside it."
            : $"Answers come in the language spoken ({Languages.NameOf(first!)} or {Languages.NameOf(second)}), each line followed by its translation; notes are translated too."));
        if (focused is not null)
        {
            var again = Pickers(languages).FirstOrDefault(picker => AutomationProperties.GetName(picker) == focused);
            if (again is not null) DispatcherQueue.TryEnqueue(() => again.Focus(FocusState.Programmatic));
        }
    }

    private static IEnumerable<ComboBox> Pickers(DependencyObject parent)
    {
        for (var i = 0; i < Microsoft.UI.Xaml.Media.VisualTreeHelper.GetChildrenCount(parent); i++)
        {
            var child = Microsoft.UI.Xaml.Media.VisualTreeHelper.GetChild(parent, i);
            if (child is ComboBox box) yield return box;
            foreach (var nested in Pickers(child)) yield return nested;
        }
    }

    /// <summary>The languages once the first is `code`: none without a first; the second kept, or (picked as the first) the two swapped.</summary>
    private static string[] First(string? code, string? first, string? second) =>
        code is null ? [] : second is null ? [code] : second == code && first is not null ? [code, first] : [code, second];

    private void Save(IReadOnlyList<string> codes)
    {
        if (choosing) return;
        _ = state.Api.SetLanguages(codes);
    }

    /// <summary>"None", then the languages by their own names; `excluded` (the first language, for the second) is left out.</summary>
    private ComboBox LanguagePicker(string name, string? selected, string? excluded, bool enabled, Action<string?> chose)
    {
        var options = new List<(string Label, string? Code)> { ("None", null) };
        options.AddRange(Languages.ByNativeName.Where(language => language.Code != excluded).Select(language => (language.Native, (string?)language.Code)));
        return Picker(name, options, selected, chose, enabled);
    }

    /// <summary>A drop-down of the system's, named for screen readers, that says when the person picks another option (not when it is set here).</summary>
    private ComboBox Picker<T>(string name, IReadOnlyList<(string Label, T Value)> options, T selected, Action<T> chose, bool enabled = true)
    {
        var box = new ComboBox { MinWidth = 200, IsEnabled = enabled };
        AutomationProperties.SetName(box, name);
        foreach (var (label, _) in options)
        {
            var item = new ComboBoxItem { Content = label };
            AutomationProperties.SetName(item, label);
            box.Items.Add(item);
        }
        choosing = true;
        try
        {
            var index = options.ToList().FindIndex(option => EqualityComparer<T>.Default.Equals(option.Value, selected));
            box.SelectedIndex = Math.Max(index, 0);
        }
        finally
        {
            choosing = false;
        }
        box.SelectionChanged += (_, _) =>
        {
            if (!choosing && box.SelectedIndex >= 0 && box.SelectedIndex < options.Count) chose(options[box.SelectedIndex].Value);
        };
        return box;
    }

    /// <summary>A line of a card: what it is (and a word on it) on the left, its drop-down on the right.</summary>
    private static Grid Choice(string label, string description, FrameworkElement control)
    {
        var grid = new Grid { ColumnSpacing = 16 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var text = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        text.Children.Add(new TextBlock { Text = label });
        text.Children.Add(Ui.Caption(description));
        grid.Children.Add(text);
        control.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(control, 1);
        grid.Children.Add(control);
        return grid;
    }

    /// <summary>A line of a card: what it is (and a word on it) on the left, its switch on the right.</summary>
    private static Grid Toggle(string label, string? description, bool on, Action<bool> set)
    {
        var grid = new Grid { ColumnSpacing = 16 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var text = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        text.Children.Add(new TextBlock { Text = label });
        if (description is not null) text.Children.Add(Ui.Caption(description));
        grid.Children.Add(text);
        var toggle = new ToggleSwitch { IsOn = on, MinWidth = 0 };
        AutomationProperties.SetName(toggle, label);
        toggle.Toggled += (_, _) => set(toggle.IsOn);
        Grid.SetColumn(toggle, 1);
        grid.Children.Add(toggle);
        return grid;
    }
}
