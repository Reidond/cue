using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage;
using Windows.Storage.Pickers;

namespace Cue;

/// <summary>
/// A project's overview: the materials first (drop files on it or pick them; the account reads them), then how Cue's reading of them went (the brief:
/// what the talk is about, the names and terms, answers to the likely questions), and under Advanced the person's own occasion and names and terms
/// (edits go straight to `project.json` and to the account a moment later; empty, Cue's are used). There is no language to choose: Cue hears it. Made
/// once for a project; <see cref="Update"/> brings it up to date.
/// </summary>
public sealed class ProjectOverviewView : UserControl
{
    private readonly AppState state;
    private readonly string projectId;
    private readonly TextBox occasion = new() { Header = "Occasion", AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 68 };
    private readonly TextBox vocabulary = new() { Header = "Names and terms", AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 68 };
    private readonly Border materialsHost = new();
    private readonly Border briefHost = new() { Margin = new Thickness(0, 8, 0, 0) };
    private readonly Expander advanced = new()
    {
        Header = "Advanced",
        HorizontalAlignment = HorizontalAlignment.Stretch,
        HorizontalContentAlignment = HorizontalAlignment.Stretch,
        Margin = new Thickness(0, 8, 0, 0),
    };

    private readonly StackPanel root = new() { Spacing = 8, Background = new SolidColorBrush(Colors.Transparent), AllowDrop = true };
    private Project project;
    private KnowledgeBase? knowledge;
    private bool reading;
    private bool dropTargeted;
    private FontIcon? dropIcon;

    /// <summary>What the materials' card was last made from.</summary>
    private string materialsShown = "";

    /// <summary>What the brief's row was last made from.</summary>
    private (ProjectBrief Brief, bool Files)? briefShown;

    /// <summary>Set while the fields are being filled from the project, so that is not taken for an edit.</summary>
    private bool updating;

    public ProjectOverviewView(AppState state, Project project)
    {
        this.state = state;
        this.project = project;
        projectId = project.Id;

        occasion.TextChanged += (_, _) => Edit(current => current.Occasion == occasion.Text ? current : current with { Occasion = occasion.Text });
        vocabulary.TextChanged += (_, _) => Edit(current => current.Vocabulary == vocabulary.Text ? current : current with { Vocabulary = vocabulary.Text });
        AutomationProperties.SetName(advanced, "Advanced");
        advanced.Content = new StackPanel
        {
            Spacing = 12,
            Children =
            {
                occasion,
                vocabulary,
                Ui.Caption(
                    "Cue writes these from your materials. Type to use your own words instead; clear a field to go back to Cue's. There is no language to choose: Cue hears what is spoken."),
            },
        };

        root.Children.Add(Ui.Header("Materials"));
        root.Children.Add(materialsHost);
        root.Children.Add(Ui.Caption(
            "Slides, documents and notes: PDF, PowerPoint, Word, Markdown or text, kept in your Cue account. Cue reads them and prepares the rest: what the talk is about, the names and terms to listen for, and answers to the questions people are likely to ask."));
        root.Children.Add(briefHost);
        root.Children.Add(advanced);
        root.DragEnter += (_, _) => Targeted(true);
        root.DragLeave += (_, _) => Targeted(false);
        root.DragOver += OnDragOver;
        root.Drop += OnDrop;
        Content = root;
        Update(project, null, true);
    }

    /// <summary>The project as it is now, and what the account has read from its files (null while it is being read).</summary>
    public void Update(Project next, KnowledgeBase? read, bool nowReading)
    {
        project = next;
        knowledge = read;
        reading = nowReading;
        updating = true;
        try
        {
            Fill(occasion, next.Occasion);
            Fill(vocabulary, next.Vocabulary);
        }
        finally
        {
            updating = false;
        }
        // Empty, a field shows what Cue wrote: that is what is used.
        var terms = next.Brief.Terms;
        occasion.PlaceholderText = next.Brief.Occasion.Length > 0 ? next.Brief.Occasion : "What the talk is about and who will ask, from your materials";
        vocabulary.PlaceholderText = terms.Count > 0 ? string.Join(", ", terms) : "People's names, jargon, product names, from your materials";
        RenderMaterials();
        RenderBrief();
    }

    /// <summary>A field takes what the project says, unless the person is typing in it.</summary>
    private static void Fill(TextBox box, string text)
    {
        if (box.Text != text && box.FocusState == FocusState.Unfocused) box.Text = text;
    }

    private void Edit(Func<Project, Project> change)
    {
        if (updating || state.Projects.Find(projectId) is not { } current) return;
        state.Projects.Update(change(current));
    }

    // MARK: What Cue prepared

    /// <summary>How Cue's reading of the materials went: under way, what it prepared, or why it couldn't. Only while the project has files.</summary>
    private void RenderBrief()
    {
        var files = project.Materials.Count > 0;
        if (briefShown == (project.Brief, files)) return;
        briefShown = (project.Brief, files);
        briefHost.Visibility = files ? Visibility.Visible : Visibility.Collapsed;
        if (!files)
        {
            briefHost.Child = null;
            return;
        }
        var brief = project.Brief;
        FrameworkElement icon;
        string text;
        Button? action = null;
        if (brief.Working)
        {
            text = "Reading your materials…";
            icon = new ProgressRing { Width = 20, Height = 20, IsActive = true };
            AutomationProperties.SetName(icon, text);
        }
        else if (brief.Ready)
        {
            text = $"Prepared {brief.AnswersText} and {brief.TermsText} from your materials";
            icon = Ui.Glyph("", 16, "SystemFillColorSuccessBrush");
            action = new Button { Content = "Show Answers" };
            action.Click += (_, _) => state.Dashboard.OpenProject(projectId, ProjectTab.Answers);
        }
        else if (brief.Failed)
        {
            text = brief.Error ?? "Cue couldn't read your materials";
            icon = Ui.Glyph("", 16, "SystemFillColorCautionBrush");
            action = PrepareButton("Try Again");
        }
        else
        {
            text = "Cue hasn't read these files yet";
            icon = Ui.Glyph("", 16, "TextFillColorTertiaryBrush");
            action = PrepareButton("Prepare");
        }

        var row = new Grid { Padding = new Thickness(16, 12, 16, 12), ColumnSpacing = 12, MinHeight = 64 };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(20) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        icon.HorizontalAlignment = HorizontalAlignment.Center;
        icon.VerticalAlignment = VerticalAlignment.Center;
        row.Children.Add(icon);
        var label = new TextBlock
        {
            Text = text,
            TextWrapping = TextWrapping.Wrap,
            VerticalAlignment = VerticalAlignment.Center,
            Foreground = Ui.Theme(brief.Working || brief.State == "none" ? "TextFillColorSecondaryBrush" : "TextFillColorPrimaryBrush"),
        };
        Grid.SetColumn(label, 1);
        row.Children.Add(label);
        if (action is not null)
        {
            action.VerticalAlignment = VerticalAlignment.Center;
            Grid.SetColumn(action, 2);
            row.Children.Add(action);
        }
        briefHost.Child = Ui.Card(row);
    }

    /// <summary>Asks the account to read the files again: after it failed, or for files added before Cue wrote briefs.</summary>
    private Button PrepareButton(string label)
    {
        var button = new Button { Content = label };
        button.Click += async (_, _) =>
        {
            if (state.Projects.Find(projectId) is { } current) await state.Projects.PrepareAgain(current);
        };
        return button;
    }

    // MARK: Materials

    private void RenderMaterials()
    {
        // An edit of the occasion or the names comes through here too: the card is only made again when something it shows changed.
        var uploading = state.Projects.Uploading.Contains(project.Id);
        var shown = string.Join(
            '|',
            reading,
            uploading,
            System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(knowledge),
            string.Join(',', project.Materials.Select(material => $"{material.Id}:{material.Name}:{material.Summary}:{material.Error}")));
        if (shown == materialsShown) return;
        materialsShown = shown;
        var rows = new List<UIElement>();
        dropIcon = null;
        if (project.Materials.Count == 0) rows.Add(DropHint());
        else rows.AddRange(project.Materials.Select(Row));
        var add = new Button { Content = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Children = { Ui.Glyph("", 14, "TextFillColorPrimaryBrush"), new TextBlock { Text = "Add Files…" } } } };
        add.Click += OnAddFiles;
        var footer = new Grid { ColumnSpacing = 12 };
        footer.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        footer.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        footer.Children.Add(add);
        FrameworkElement status = reading || uploading
            ? new ProgressRing { Width = 18, Height = 18, IsActive = true }
            : new TextBlock { Text = knowledge is not null && project.Materials.Count > 0 ? knowledge.Summary : "", Foreground = Ui.Theme("TextFillColorSecondaryBrush") };
        status.HorizontalAlignment = HorizontalAlignment.Right;
        status.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(status, 1);
        footer.Children.Add(status);
        rows.Add(Ui.Padded(footer));

        materialsHost.Child = Ui.Card([.. rows]);
        ShowTarget();
    }

    private UIElement DropHint()
    {
        dropIcon = new FontIcon { Glyph = "", FontSize = 28, HorizontalAlignment = HorizontalAlignment.Center };
        return Ui.Padded(new StackPanel
        {
            Spacing = 8,
            HorizontalAlignment = HorizontalAlignment.Center,
            Margin = new Thickness(0, 10, 0, 10),
            Children =
            {
                dropIcon,
                new TextBlock { Text = "Drop slides, documents and notes here", Foreground = Ui.Theme("TextFillColorSecondaryBrush") },
            },
        });
    }

    private UIElement Row(Material material)
    {
        UIElement second = material.Error is { } error
            ? new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Spacing = 6,
                Children =
                {
                    Ui.Glyph("", 12, "SystemFillColorCautionBrush"),
                    new TextBlock { Text = error, Style = (Style)Application.Current.Resources["CaptionTextBlockStyle"], Foreground = Ui.Theme("SystemFillColorCautionBrush"), TextWrapping = TextWrapping.Wrap },
                },
            }
            : new TextBlock { Text = material.Summary, Style = (Style)Application.Current.Resources["CaptionTextBlockStyle"], Foreground = Ui.Theme("TextFillColorSecondaryBrush") };
        var remove = new Button
        {
            Content = Ui.Glyph("", 14),
            Background = new SolidColorBrush(Colors.Transparent),
            BorderThickness = new Thickness(0),
            VerticalAlignment = VerticalAlignment.Center,
        };
        AutomationProperties.SetName(remove, $"Remove {material.Name}");
        ToolTipService.SetToolTip(remove, "Remove from the project");
        remove.Click += (_, _) => _ = state.Projects.RemoveMaterial(material, state.Projects.Find(projectId) ?? project);

        var row = new Grid { Padding = new Thickness(16, 10, 12, 10), ColumnSpacing = 12 };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var icon = Ui.Glyph("", 20);
        row.Children.Add(icon);
        var text = new StackPanel
        {
            VerticalAlignment = VerticalAlignment.Center,
            Spacing = 2,
            Children = { new TextBlock { Text = material.Name, TextTrimming = TextTrimming.CharacterEllipsis }, second },
        };
        Grid.SetColumn(text, 1);
        row.Children.Add(text);
        Grid.SetColumn(remove, 2);
        row.Children.Add(remove);
        return row;
    }

    private async void OnAddFiles(object sender, RoutedEventArgs e)
    {
        var picker = new FileOpenPicker { ViewMode = PickerViewMode.List, SuggestedStartLocation = PickerLocationId.DocumentsLibrary };
        foreach (var extension in Material.SupportedExtensions.Order()) picker.FileTypeFilter.Add("." + extension);
        WinRT.Interop.InitializeWithWindow.Initialize(picker, state.WindowHandle);
        IReadOnlyList<StorageFile> files;
        try
        {
            files = await picker.PickMultipleFilesAsync();
        }
        catch (System.Runtime.InteropServices.COMException)
        {
            return;
        }
        await AddFiles(files.Select(file => file.Path));
    }

    private async Task AddFiles(IEnumerable<string> paths)
    {
        if (state.Projects.Find(projectId) is { } current) await state.Projects.AddMaterials(paths, current);
    }

    // MARK: Dropping files

    /// <summary>Files are over the page: the materials' card lights up. Only brushes change, so the drag in progress keeps the elements it is over.</summary>
    private void Targeted(bool on)
    {
        dropTargeted = on;
        ShowTarget();
    }

    private void ShowTarget()
    {
        if (materialsHost.Child is Border card) card.BorderBrush = Ui.Theme(dropTargeted ? "AccentFillColorDefaultBrush" : "CardStrokeColorDefaultBrush");
        if (dropIcon is not null) dropIcon.Foreground = Ui.Theme(dropTargeted ? "AccentFillColorDefaultBrush" : "TextFillColorSecondaryBrush");
    }

    private void OnDragOver(object sender, DragEventArgs e)
    {
        if (!e.DataView.Contains(StandardDataFormats.StorageItems)) return;
        e.AcceptedOperation = DataPackageOperation.Copy;
        e.DragUIOverride.Caption = $"Add to {project.Name}";
    }

    private async void OnDrop(object sender, DragEventArgs e)
    {
        Targeted(false);
        if (!e.DataView.Contains(StandardDataFormats.StorageItems)) return;
        var deferral = e.GetDeferral();
        try
        {
            var items = await e.DataView.GetStorageItemsAsync();
            await AddFiles(items.OfType<StorageFile>().Select(file => file.Path));
        }
        finally
        {
            deferral.Complete();
        }
    }
}
