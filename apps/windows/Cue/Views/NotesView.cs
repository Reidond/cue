using System.Globalization;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Windows.ApplicationModel.DataTransfer;

namespace Cue;

/// <summary>
/// A project's notes: the list on the left, the note on the right (the Mac's ProjectNotesView). The note is its Markdown copy rendered, with the steps a
/// new one goes through while it is made, the names its summary suggested (Apply, ✕), a player when it has audio (the transcript's timestamps play from
/// there) and a click on a speaker's name to rename them. Which note is open is the dashboard's (<see cref="DashboardModel.NoteId"/>).
/// A note in two languages is laid out as Settings says (<see cref="NoteLayout"/>): a switch between them above it, or one after the other.
/// Made once for a project; <see cref="Update"/> brings it up to date.
/// </summary>
internal sealed class NotesView : UserControl
{
    private readonly AppState state;
    private string projectId;

    private readonly ListView list = new() { SelectionMode = ListViewSelectionMode.Single };
    private readonly AutoSuggestBox search = new() { PlaceholderText = "Search notes", QueryIcon = new SymbolIcon(Symbol.Find) };
    private readonly Grid notes = new();
    private readonly Grid empty = new();
    private readonly Border detailHost = new();
    private readonly PlayerBar playerBar;
    private readonly MarkdownView markdown = new();

    // A note in two languages: the switch between them, the transcript's heading with the Translations switch, the transcript under it.
    private readonly StackPanel note = new();
    private readonly SelectorBar languageSwitch = new() { Margin = new Thickness(-12, 0, 0, 12) };
    private readonly SelectorBarItem ownItem = new();
    private readonly SelectorBarItem translatedItem = new();
    private readonly TextBlock transcriptHeading = new() { Style = (Style)Application.Current.Resources["SubtitleTextBlockStyle"], VerticalAlignment = VerticalAlignment.Center, TextWrapping = TextWrapping.Wrap };
    private readonly ToggleSwitch translations = new() { OnContent = "Translations", OffContent = "Translations", MinWidth = 0, VerticalAlignment = VerticalAlignment.Center };
    private readonly Grid transcriptRow = new() { ColumnSpacing = 16, Margin = new Thickness(0, 28, 0, 0) };
    private readonly MarkdownView transcript = new() { Margin = new Thickness(0, 12, 0, 0) };
    private bool switching;
    private readonly StackPanel body = new() { Spacing = 20, MaxWidth = 720, HorizontalAlignment = HorizontalAlignment.Left };
    private readonly ScrollViewer scroller = new() { VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
    private readonly Grid detail = new() { RowSpacing = 12 };
    private readonly TextBlock noSelection = new()
    {
        Text = "Select a note to read it. Summaries and transcripts are saved as Markdown in the project’s Notes folder.",
        TextWrapping = TextWrapping.Wrap,
        Foreground = Ui.Theme("TextFillColorSecondaryBrush"),
        VerticalAlignment = VerticalAlignment.Center,
        HorizontalAlignment = HorizontalAlignment.Center,
        TextAlignment = TextAlignment.Center,
        MaxWidth = 320,
    };

    private CommandBar actions = new();
    private string listShown = "";
    private string detailShown = "";
    private bool updating;

    public NotesView(AppState state, Project project)
    {
        this.state = state;
        projectId = project.Id;
        playerBar = new PlayerBar(state.Player);

        search.TextChanged += (_, _) => Refresh();
        AutomationProperties.SetName(search, "Search notes");
        AutomationProperties.SetName(list, "Notes");
        list.SelectionChanged += (_, _) =>
        {
            if (!updating && list.SelectedItem is ListViewItem { Tag: string id }) state.Dashboard.NoteId = id;
        };

        // Left: Record and the search over the list.
        var toolbar = new StackPanel { Spacing = 8, Margin = new Thickness(0, 0, 12, 8) };
        toolbar.Children.Add(new RecordControl(state, RecordingTrigger.Dashboard, subtle: false));
        toolbar.Children.Add(search);
        var left = new Grid { Width = 280 };
        left.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        left.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        left.Children.Add(toolbar);
        Grid.SetRow(list, 1);
        left.Children.Add(list);

        // Right: the note.
        detail.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        detail.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        actions = Actions();
        var header = new StackPanel { Spacing = 8, Margin = new Thickness(16, 0, 0, 0) };
        header.Children.Add(actions);
        header.Children.Add(playerBar);
        detail.Children.Add(header);
        note.Children.Add(markdown);
        body.Children.Add(note);
        languageSwitch.Items.Add(ownItem);
        languageSwitch.Items.Add(translatedItem);
        AutomationProperties.SetName(languageSwitch, "Language");
        languageSwitch.SelectionChanged += (_, _) =>
        {
            if (switching) return;
            state.Dashboard.NoteLanguage = ReferenceEquals(languageSwitch.SelectedItem, translatedItem) ? (string?)translatedItem.Tag : null;
        };
        AutomationProperties.SetName(translations, "Translations");
        ToolTipService.SetToolTip(translations, "Show each line's translation under it");
        translations.Toggled += (_, _) =>
        {
            if (!switching) state.Dashboard.NoteTranslations = translations.IsOn;
        };
        transcriptRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        transcriptRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        transcriptRow.Children.Add(transcriptHeading);
        Grid.SetColumn(translations, 1);
        transcriptRow.Children.Add(translations);
        scroller.Content = new Grid { Padding = new Thickness(16, 0, 16, 24), Children = { body } };
        Grid.SetRow(scroller, 1);
        detail.Children.Add(scroller);
        detailHost.Child = detail;

        notes.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        notes.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        notes.Children.Add(left);
        Grid.SetColumn(detailHost, 1);
        notes.Children.Add(detailHost);

        // No notes yet: one empty state in place of both.
        var emptyText = new StackPanel { Spacing = 8, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, MaxWidth = 360 };
        emptyText.Children.Add(new FontIcon { Glyph = "", FontSize = 40, Foreground = Ui.Theme("TextFillColorSecondaryBrush"), Margin = new Thickness(0, 0, 0, 4) });
        emptyText.Children.Add(new TextBlock { Text = "No Notes", Style = (Style)Application.Current.Resources["SubtitleTextBlockStyle"], HorizontalAlignment = HorizontalAlignment.Center });
        emptyText.Children.Add(new TextBlock
        {
            Text = "Press Win+Alt+C or the record button to record a call into this project. Its summary and transcript will be here.",
            Foreground = Ui.Theme("TextFillColorSecondaryBrush"),
            TextWrapping = TextWrapping.Wrap,
            TextAlignment = TextAlignment.Center,
        });
        emptyText.Children.Add(new RecordControl(state, RecordingTrigger.Dashboard, subtle: false) { HorizontalAlignment = HorizontalAlignment.Center });
        empty.Children.Add(emptyText);

        Content = new Grid { Children = { notes, empty } };
        Loaded += (_, _) =>
        {
            // Taken out and put back at once, the page is told Loaded before the Unloaded it had: subscribed once, and that Unloaded is ignored below.
            state.Recordings.Changed -= OnChanged;
            state.Recordings.Changed += OnChanged;
            state.Dashboard.PropertyChanged += OnLanguageChanged;
            state.Preferences.PropertyChanged += OnLanguageChanged;
            state.Recordings.Reload();
            Refresh();
        };
        Unloaded += (_, _) =>
        {
            // Back on the page already: unsubscribing now left it showing a note's first steps while the note was made.
            if (IsLoaded) return;
            state.Recordings.Changed -= OnChanged;
            state.Dashboard.PropertyChanged -= OnLanguageChanged;
            state.Preferences.PropertyChanged -= OnLanguageChanged;
            state.Player.Load(null, null);
            detailShown = "";
        };
    }

    private void OnChanged() => Refresh();

    /// <summary>The language the note is read in, the Translations switch, or the layout of two languages changed.</summary>
    private void OnLanguageChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e)
    {
        if (e.PropertyName is nameof(DashboardModel.NoteLanguage) or nameof(DashboardModel.NoteTranslations) or nameof(Preferences.NoteLayout)) Refresh();
    }

    /// <summary>Brings the page up to date: the project's notes, the one open.</summary>
    public void Update(Project project)
    {
        projectId = project.Id;
        Refresh();
    }

    // MARK: The list

    private IReadOnlyList<RecordingFile> Files()
    {
        var all = state.Projects.Find(projectId) is { } project ? state.Recordings.FilesIn(project) : [];
        var query = search.Text.Trim();
        return query.Length == 0 ? all : [.. all.Where(file => file.Title.Contains(query, StringComparison.CurrentCultureIgnoreCase))];
    }

    private void Refresh()
    {
        if (state.Projects.Find(projectId) is not { } project) return;
        var everything = state.Recordings.FilesIn(project);
        empty.Visibility = everything.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        notes.Visibility = everything.Count == 0 ? Visibility.Collapsed : Visibility.Visible;
        if (everything.Count == 0)
        {
            state.Dashboard.NoteId = null;
            state.Player.Load(null, null);
            return;
        }

        // The open note belongs to this project, else the newest.
        var open = state.Dashboard.NoteId;
        if (open is null || everything.All(file => file.Id != open))
        {
            open = everything[0].Id;
            state.Dashboard.NoteId = open;
        }

        var files = Files();
        var signature = string.Join('\n', files.Select(file => $"{file.Id}\t{file.Title}\t{file.Date:O}\t{file.Duration}\t{state.Recordings.IsProcessing(file.Id)}")) + "\n" + open;
        if (signature != listShown)
        {
            listShown = signature;
            updating = true;
            try
            {
                list.Items.Clear();
                foreach (var file in files) list.Items.Add(Row(file));
                list.SelectedItem = list.Items.OfType<ListViewItem>().FirstOrDefault(item => (string?)item.Tag == open);
            }
            finally
            {
                updating = false;
            }
        }
        else if (list.SelectedItem is not ListViewItem { Tag: string current } || current != open)
        {
            updating = true;
            try
            {
                list.SelectedItem = list.Items.OfType<ListViewItem>().FirstOrDefault(item => (string?)item.Tag == open);
            }
            finally
            {
                updating = false;
            }
        }
        Show(state.Recordings.Find(open));
    }

    private ListViewItem Row(RecordingFile file)
    {
        var title = new TextBlock { Text = file.Title, TextWrapping = TextWrapping.Wrap, MaxLines = 2, TextTrimming = TextTrimming.CharacterEllipsis };
        var when = file.Date.ToLocalTime().ToString("g", CultureInfo.CurrentCulture);
        var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        line.Children.Add(new TextBlock
        {
            Text = file.Duration.Length == 0 ? when : $"{when} · {file.Duration}",
            Style = (Style)Application.Current.Resources["CaptionTextBlockStyle"],
            Foreground = Ui.Theme("TextFillColorSecondaryBrush"),
        });
        if (state.Recordings.IsProcessing(file.Id)) line.Children.Add(new ProgressRing { Width = 12, Height = 12, IsActive = true });
        var item = new ListViewItem { Tag = file.Id, Content = new StackPanel { Spacing = 2, Padding = new Thickness(0, 6, 0, 6), Children = { title, line } } };
        AutomationProperties.SetName(item, file.Title);
        item.ContextFlyout = RowMenu(file);
        return item;
    }

    private MenuFlyout RowMenu(RecordingFile file)
    {
        var explorer = new MenuFlyoutItem { Text = "Show in Explorer", Icon = new FontIcon { Glyph = "" } };
        explorer.Click += (_, _) => Shell.ShowFileInExplorer(file.Path);
        var trash = new MenuFlyoutItem { Text = "Move to Recycle Bin", Icon = new FontIcon { Glyph = "" } };
        trash.Click += (_, _) => _ = NoteDialogs.Trash(state, file, XamlRoot);
        var menu = new MenuFlyout();
        menu.Items.Add(explorer);
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(trash);
        return menu;
    }

    // MARK: The note

    private CommandBar Actions()
    {
        AppBarButton Button(string label, string glyph, Action run, string? name = null)
        {
            var button = new AppBarButton { Label = label, Icon = new FontIcon { Glyph = glyph }, LabelPosition = CommandBarLabelPosition.Collapsed };
            // The name a screen reader says; the dialog that follows has a button called "Move to Recycle Bin" of its own.
            if (name is not null) AutomationProperties.SetName(button, name);
            ToolTipService.SetToolTip(button, label);
            button.Click += (_, _) => run();
            return button;
        }
        var bar = new CommandBar
        {
            DefaultLabelPosition = CommandBarDefaultLabelPosition.Collapsed,
            IsDynamicOverflowEnabled = false,
            OverflowButtonVisibility = CommandBarOverflowButtonVisibility.Collapsed,
            HorizontalAlignment = HorizontalAlignment.Right,
            Background = new Microsoft.UI.Xaml.Media.SolidColorBrush(Microsoft.UI.Colors.Transparent),
        };
        bar.PrimaryCommands.Add(Button("Copy Markdown", "", () =>
        {
            if (state.Recordings.Find(state.Dashboard.NoteId) is not { } file) return;
            var data = new DataPackage();
            data.SetText(state.Recordings.Contents(file.Id));
            Clipboard.SetContent(data);
        }));
        bar.PrimaryCommands.Add(Button("Show in Explorer", "", () =>
        {
            if (state.Recordings.Find(state.Dashboard.NoteId) is { } file) Shell.ShowFileInExplorer(file.Path);
        }));
        bar.PrimaryCommands.Add(Button("Move to Recycle Bin", "", () =>
        {
            if (state.Recordings.Find(state.Dashboard.NoteId) is { } file) _ = NoteDialogs.Trash(state, file, XamlRoot);
        }, "Move this note to the Recycle Bin"));
        return bar;
    }

    /// <summary>Shows a note; nothing is redrawn when it is what is shown already.</summary>
    private void Show(RecordingFile? file)
    {
        if (file is null)
        {
            if (!ReferenceEquals(detailHost.Child, noSelection)) detailHost.Child = noSelection;
            detailShown = "";
            return;
        }
        // Set again, the note's tools would be taken out and put back, and the player bar could stop following the player (see PlayerBar).
        if (!ReferenceEquals(detailHost.Child, detail)) detailHost.Child = detail;
        var processing = state.Recordings.IsProcessing(file.Id);
        var steps = state.Recordings.Steps(file.Id);
        var info = new FileInfo(file.Path);
        var signature = string.Join(
            '|',
            file.Id,
            file.Path,
            info.Exists ? info.LastWriteTimeUtc.Ticks : 0,
            info.Exists ? info.Length : 0,
            processing,
            steps is null ? "" : string.Join(',', steps.Select(step => $"{step.Step}:{step.State}:{step.Detail}")),
            file.HasAudio,
            state.Preferences.NoteLayout,
            state.Dashboard.NoteLanguage,
            state.Dashboard.NoteTranslations,
            string.Join(',', state.Api.Languages));
        if (signature == detailShown) return;
        var text = state.Recordings.Contents(file.Id);
        var moved = detailShown.Split('|')[0] != file.Id;
        detailShown = signature;
        var offset = moved ? 0 : scroller.VerticalOffset;

        // The audio: next to the note, or the account's.
        if (file.Audio is { } audio) state.Player.Load(audio, file.Id);
        else if (file.StreamsAudio && file.NoteId is { } noteId) _ = state.Player.Stream(noteId, file.Id);
        else state.Player.Load(null, null);
        playerBar.Visibility = file.HasAudio ? Visibility.Visible : Visibility.Collapsed;

        // The page: the steps (while it is made, or when one failed), the suggested names, the note.
        while (body.Children.Count > 1) body.Children.RemoveAt(0);
        var at = 0;
        if (steps is not null) body.Children.Insert(at++, Steps(steps));
        if (file.Suggestions.Count > 0 && !processing) body.Children.Insert(at++, Suggestions(file));
        ShowNote(
            text,
            file.HasAudio ? seconds => state.Player.PlayFrom(seconds) : null,
            processing ? null : name => _ = NoteDialogs.Rename(state, file, name, XamlRoot));
        if (moved) scroller.ChangeView(null, 0, null, disableAnimation: true);
        else DispatcherQueue.TryEnqueue(() => scroller.ChangeView(null, offset, null, disableAnimation: true));
    }

    // MARK: Two languages

    /// <summary>
    /// The note itself. With its translation, as the layout has it: Switch puts the two languages' names above the note, and the one chosen gives the
    /// title and summary, and the transcript's lines with the other language's under each (the Translations switch hides those); One after another
    /// has the summary, then the translated one under the language's name, then the transcript with each line's translation.
    /// </summary>
    private void ShowNote(string text, Action<double>? onTimestamp, Action<string>? onSpeaker)
    {
        if (BilingualNote.Parse(text) is not { } bilingual)
        {
            Arrange(markdown);
            markdown.Show(text, onTimestamp, onSpeaker);
            return;
        }
        var switched = state.Preferences.NoteLayout == NoteLayout.Switch;
        // The parts stay in the tree while only what they show changes (the switch keeps its selection, and its focus).
        if (switched) Arrange(languageSwitch, markdown, transcriptRow, transcript);
        else Arrange(markdown, transcriptRow, transcript);
        var translated = switched && state.Dashboard.NoteLanguage == bilingual.Language;
        var withTranslations = !switched || state.Dashboard.NoteTranslations;
        if (switched)
        {
            var own = OwnLanguage(bilingual);
            switching = true;
            try
            {
                ownItem.Text = own is null ? "Original" : Languages.NativeOf(own);
                ownItem.Tag = own;
                translatedItem.Text = Languages.NativeOf(bilingual.Language);
                translatedItem.Tag = bilingual.Language;
                AutomationProperties.SetName(ownItem, ownItem.Text);
                AutomationProperties.SetName(translatedItem, translatedItem.Text);
                ownItem.IsSelected = !translated;
                translatedItem.IsSelected = translated;
                languageSwitch.SelectedItem = translated ? translatedItem : ownItem;
                translations.IsOn = withTranslations;
            }
            finally
            {
                switching = false;
            }
        }

        var head = bilingual.Front + "\n"
            + (translated
                ? $"# {bilingual.TranslatedTitle}\n\n{bilingual.TranslatedSummary}\n"
                : $"# {bilingual.Title}\n\n{bilingual.Summary}\n"
                  + (switched || bilingual.TranslatedSummary.Length == 0 ? "" : $"\n## {Languages.NativeOf(bilingual.Language)}\n\n{Demoted(bilingual.TranslatedSummary)}\n"));
        markdown.Show(head, onTimestamp, onSpeaker);

        transcriptHeading.Text = bilingual.Heading;
        translations.Visibility = switched ? Visibility.Visible : Visibility.Collapsed;
        // The language read first is the turn's line; the other one, when it is shown, is the "> " line under it.
        var turns = bilingual.Turns.Select(turn =>
        {
            var (first, second) = translated && turn.Translation is { Length: > 0 } said ? (said, turn.Text) : (turn.Text, turn.Translation);
            return withTranslations && second is { Length: > 0 } ? $"{turn.Header}\n{first}\n> {second}" : $"{turn.Header}\n{first}";
        });
        transcript.Show(string.Join("\n\n", turns), onTimestamp, onSpeaker);
    }

    /// <summary>The note's parts, in order; nothing moves when they are the ones there already.</summary>
    private void Arrange(params UIElement[] parts)
    {
        if (note.Children.Count == parts.Length && note.Children.Zip(parts).All(pair => ReferenceEquals(pair.First, pair.Second))) return;
        note.Children.Clear();
        foreach (var part in parts) note.Children.Add(part);
    }

    /// <summary>
    /// The language a translated note was written in: the person's other one, else the one whose transcript heading it has; null when neither
    /// says (the switch then calls it the original).
    /// </summary>
    private string? OwnLanguage(BilingualNote bilingual)
    {
        var mine = state.Api.Languages;
        if (mine.Count == 2 && mine.Contains(bilingual.Language)) return mine.First(code => code != bilingual.Language);
        return Languages.All.FirstOrDefault(language =>
            language.Code != bilingual.Language
            && (language.Code == "en" || Lexicon.Load(language.Code) != Lexicon.English)
            && Lexicon.Load(language.Code).TranscriptHeading == bilingual.Heading)?.Code;
    }

    /// <summary>The translated summary under its language's name: its headings a level down, under that one.</summary>
    private static string Demoted(string markdown) =>
        string.Join("\n", markdown.Split('\n').Select(line => line.StartsWith('#') && line.TakeWhile(c => c == '#').Count() < 6 ? "#" + line : line));

    /// <summary>What happens to a new note after Stop, step by step; it stays on the page if a step failed.</summary>
    private static Border Steps(IReadOnlyList<NoteProgress> steps)
    {
        var rows = new StackPanel { Spacing = 10, Padding = new Thickness(12) };
        foreach (var step in steps)
        {
            FrameworkElement icon = step.State switch
            {
                StepState.Running => new ProgressRing { Width = 16, Height = 16, IsActive = true },
                StepState.Done => new FontIcon { Glyph = "", FontSize = 16, Foreground = Ui.Theme("SystemFillColorSuccessBrush") },
                StepState.Failed => new FontIcon { Glyph = "", FontSize = 16, Foreground = Ui.Theme("SystemFillColorCautionBrush") },
                _ => new FontIcon { Glyph = "", FontSize = 16, Foreground = Ui.Theme("TextFillColorTertiaryBrush") },
            };
            icon.VerticalAlignment = VerticalAlignment.Top;
            icon.Margin = new Thickness(0, 2, 0, 0);
            var text = new StackPanel { Spacing = 2 };
            text.Children.Add(new TextBlock
            {
                Text = step.Step.Title(),
                Foreground = Ui.Theme(step.State == StepState.Pending ? "TextFillColorSecondaryBrush" : "TextFillColorPrimaryBrush"),
            });
            if (step.Detail is { Length: > 0 } detail)
                text.Children.Add(new TextBlock { Text = detail, Style = (Style)Application.Current.Resources["CaptionTextBlockStyle"], Foreground = Ui.Theme("TextFillColorSecondaryBrush"), TextWrapping = TextWrapping.Wrap });
            var row = new Grid { ColumnSpacing = 10 };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(20) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.Children.Add(icon);
            Grid.SetColumn(text, 1);
            row.Children.Add(text);
            rows.Children.Add(row);
        }
        var card = Card(rows);
        AutomationProperties.SetName(card, "Processing steps");
        return card;
    }

    /// <summary>Who the summary thinks the people on the call are, each with Apply (renames them in the note) and ✕.</summary>
    private StackPanel Suggestions(RecordingFile file)
    {
        var chips = new StackPanel { Spacing = 8 };
        AutomationProperties.SetName(chips, "Suggested names");
        foreach (var (label, name) in file.Suggestions.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            var apply = new Button { Content = "Apply" };
            AutomationProperties.SetName(apply, $"Apply {name} to {label}");
            apply.Click += (_, _) => state.Recordings.ApplySuggestion(label, file.Id);
            var dismiss = new Button { Content = new FontIcon { Glyph = "", FontSize = 12 }, Padding = new Thickness(8, 5, 8, 5) };
            AutomationProperties.SetName(dismiss, $"Dismiss the name suggested for {label}");
            ToolTipService.SetToolTip(dismiss, "Dismiss the suggestion");
            dismiss.Click += (_, _) => state.Recordings.DismissSuggestion(label, file.Id);
            var row = new Grid { ColumnSpacing = 8, Padding = new Thickness(12, 6, 8, 6) };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var person = new FontIcon { Glyph = "", FontSize = 16, Foreground = Ui.Theme("TextFillColorSecondaryBrush"), VerticalAlignment = VerticalAlignment.Center };
            var text = new TextBlock { Text = $"{label} → {name}?", VerticalAlignment = VerticalAlignment.Center, TextWrapping = TextWrapping.Wrap };
            row.Children.Add(person);
            Grid.SetColumn(text, 1);
            row.Children.Add(text);
            Grid.SetColumn(apply, 2);
            row.Children.Add(apply);
            Grid.SetColumn(dismiss, 3);
            row.Children.Add(dismiss);
            chips.Children.Add(Card(row));
        }
        return chips;
    }

    private static Border Card(UIElement child) =>
        new()
        {
            Child = child,
            Background = Ui.Theme("CardBackgroundFillColorDefaultBrush"),
            BorderBrush = Ui.Theme("CardStrokeColorDefaultBrush"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(8),
        };
}

/// <summary>The dialogs of a note: renaming a person, and the Recycle Bin question.</summary>
internal static class NoteDialogs
{
    public static async Task Rename(AppState state, RecordingFile file, string person, XamlRoot root)
    {
        var name = new TextBox { Text = person };
        AutomationProperties.SetName(name, "Name");
        var content = new StackPanel { Spacing = 12, MinWidth = 320 };
        content.Children.Add(new TextBlock { Text = "The name changes everywhere in this note: the transcript, the summary and the participants.", TextWrapping = TextWrapping.Wrap });
        content.Children.Add(name);
        var dialog = new ContentDialog
        {
            Title = $"Rename “{person}”",
            Content = content,
            PrimaryButtonText = "Rename",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Primary,
            IsPrimaryButtonEnabled = true,
            XamlRoot = root,
        };
        name.TextChanged += (_, _) => dialog.IsPrimaryButtonEnabled = name.Text.Trim().Length > 0;
        dialog.Opened += (_, _) =>
        {
            name.Focus(FocusState.Programmatic);
            name.SelectAll();
        };
        if (await Show(dialog) == ContentDialogResult.Primary) state.Recordings.Rename(person, name.Text, file.Id);
    }

    public static async Task Trash(AppState state, RecordingFile file, XamlRoot root)
    {
        var dialog = new ContentDialog
        {
            Title = $"Move “{file.Title}” to the Recycle Bin?",
            Content = new TextBlock { Text = "You can restore it from the Recycle Bin in Explorer.", TextWrapping = TextWrapping.Wrap },
            PrimaryButtonText = "Move to Recycle Bin",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Close,
            XamlRoot = root,
        };
        if (await Show(dialog) == ContentDialogResult.Primary) state.Recordings.MoveToTrash(file.Id);
    }

    private static async Task<ContentDialogResult> Show(ContentDialog dialog)
    {
        try
        {
            return await dialog.ShowAsync();
        }
        catch (InvalidOperationException)
        {
            // Another dialog is open already.
            return ContentDialogResult.None;
        }
    }
}

/// <summary>Play/pause, the position and the speed, above a note that has audio.</summary>
internal sealed class PlayerBar : UserControl
{
    private readonly NotePlayer player;
    private readonly Button toggle = new();
    private readonly TextBlock position = new() { VerticalAlignment = VerticalAlignment.Center, MinWidth = 40, TextAlignment = TextAlignment.Right, Foreground = Ui.Theme("TextFillColorSecondaryBrush") };
    private readonly TextBlock length = new() { VerticalAlignment = VerticalAlignment.Center, MinWidth = 40, Foreground = Ui.Theme("TextFillColorSecondaryBrush") };
    private readonly Slider slider = new() { Minimum = 0, Maximum = 1, IsThumbToolTipEnabled = false, VerticalAlignment = VerticalAlignment.Center };
    private readonly DropDownButton speed = new();
    private bool updating;

    public PlayerBar(NotePlayer player)
    {
        this.player = player;
        AutomationProperties.SetName(toggle, "Play");
        toggle.Click += (_, _) => player.TogglePlay();
        AutomationProperties.SetName(slider, "Position");
        slider.ValueChanged += (_, e) =>
        {
            if (!updating) player.Seek(e.NewValue);
        };
        slider.AddHandler(PointerPressedEvent, new Microsoft.UI.Xaml.Input.PointerEventHandler((_, _) => player.Scrubbing = true), handledEventsToo: true);
        slider.AddHandler(PointerReleasedEvent, new Microsoft.UI.Xaml.Input.PointerEventHandler((_, _) => player.Scrubbing = false), handledEventsToo: true);
        slider.AddHandler(PointerCaptureLostEvent, new Microsoft.UI.Xaml.Input.PointerEventHandler((_, _) => player.Scrubbing = false), handledEventsToo: true);

        var menu = new MenuFlyout();
        foreach (var rate in NotePlayer.Rates)
        {
            var item = new RadioMenuFlyoutItem { Text = Label(rate), GroupName = "Speed", IsChecked = rate == player.Rate };
            item.Click += (_, _) => player.Rate = rate;
            menu.Items.Add(item);
        }
        speed.Flyout = menu;
        AutomationProperties.SetName(speed, "Playback speed");

        var row = new Grid { ColumnSpacing = 8, Padding = new Thickness(8, 4, 8, 4) };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.Children.Add(toggle);
        Grid.SetColumn(position, 1);
        row.Children.Add(position);
        Grid.SetColumn(slider, 2);
        row.Children.Add(slider);
        Grid.SetColumn(length, 3);
        row.Children.Add(length);
        Grid.SetColumn(speed, 4);
        row.Children.Add(speed);
        Content = new Border
        {
            Child = row,
            Background = Ui.Theme("CardBackgroundFillColorDefaultBrush"),
            BorderBrush = Ui.Theme("CardStrokeColorDefaultBrush"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(8),
        };
        // As the notes page's own: subscribed once, and a late Unloaded (the bar back on the page already) is ignored.
        Loaded += (_, _) =>
        {
            player.Changed -= Redraw;
            player.Changed += Redraw;
            Redraw();
        };
        Unloaded += (_, _) =>
        {
            if (!IsLoaded) player.Changed -= Redraw;
        };
    }

    /// <summary>1×, 1.5× (1,5× where that's the decimal separator), 2×.</summary>
    private static string Label(double rate) => rate.ToString("0.#", CultureInfo.CurrentCulture) + "×";

    private void Redraw()
    {
        toggle.Content = new FontIcon { Glyph = player.IsPlaying ? "" : "", FontSize = 14 };
        AutomationProperties.SetName(toggle, player.IsPlaying ? "Pause" : "Play");
        position.Text = RecordingStore.Clock(player.Time);
        length.Text = RecordingStore.Clock(player.Duration);
        speed.Content = Label(player.Rate);
        updating = true;
        try
        {
            slider.Maximum = Math.Max(player.Duration, 1);
            slider.Value = Math.Min(player.Time, slider.Maximum);
        }
        finally
        {
            updating = false;
        }
    }
}
