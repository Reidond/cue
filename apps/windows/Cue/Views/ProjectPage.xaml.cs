using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;

namespace Cue;

/// <summary>
/// A project's page: its name on top, then its materials (and what Cue prepared from them), its prepared answers or its notes, picked in the bar
/// under the name. Which project and which page is the dashboard's (<see cref="DashboardModel.ProjectId"/>, <see cref="DashboardModel.Section"/>):
/// the page follows it, and the store, so a project picked in the pane, `page NAME` and an edit from another place all land here.
/// </summary>
public sealed partial class ProjectPage : Page
{
    private AppState state = null!;
    private string? shown;
    private string? shownScrolled;
    private ProjectTab? shownSection;
    private ProjectOverviewView? overview;
    private PreparedAnswersView? answers;
    private NotesView? notes;
    private KnowledgeBase? knowledge;
    private bool reading;

    /// <summary>What the knowledge was read from, so unrelated edits of the project don't read its files again.</summary>
    private string readKey = "";

    private int reads;

    public ProjectPage() => InitializeComponent();

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        state = (AppState)e.Parameter;
        state.Dashboard.PropertyChanged += OnChanged;
        state.Projects.PropertyChanged += OnChanged;
        state.Live.PropertyChanged += OnChanged;
        shown = null;
        Render();
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        state.Dashboard.PropertyChanged -= OnChanged;
        state.Projects.PropertyChanged -= OnChanged;
        state.Live.PropertyChanged -= OnChanged;
        NotesHost.Child = null;
    }

    private void OnChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e) => Render();

    /// <summary>Start Cue for this project: shows the overlay and listens, answering from its materials; Stop Cue while it does.</summary>
    private void OnStartCue(object sender, RoutedEventArgs e)
    {
        if (state.Projects.Find(state.Dashboard.ProjectId) is { } project) state.Live.ToggleCue(project);
    }

    private void OnTabChanged(SelectorBar sender, SelectorBarSelectionChangedEventArgs args)
    {
        if (state is null) return;
        var picked = sender.SelectedItem == AnswersTab ? ProjectTab.Answers : sender.SelectedItem == NotesTab ? ProjectTab.Notes : ProjectTab.Overview;
        if (picked != state.Dashboard.Section) state.Dashboard.Section = picked;
    }

    private void Render()
    {
        if (state.Projects.Find(state.Dashboard.ProjectId) is not { } project)
        {
            StartCueButton.Visibility = Visibility.Collapsed;
            NameText.Text = "No Project Selected";
            SubtitleText.Text = "";
            Tabs.Visibility = Visibility.Collapsed;
            TabHost.Child = null;
            NotesHost.Child = null;
            shown = null;
            return;
        }
        Tabs.Visibility = Visibility.Visible;
        StartCueButton.Visibility = Visibility.Visible;
        StartCueButton.Content = state.Live.CueRunning && state.Live.ActiveProject?.Id == project.Id ? "Stop Cue" : "Start Cue";
        NameText.Text = project.Name;
        SubtitleText.Text = project.Materials.Count == 1 ? "1 file" : $"{project.Materials.Count} files";

        if (shown != project.Id)
        {
            shown = project.Id;
            overview = new ProjectOverviewView(state, project);
            answers = new PreparedAnswersView();
            notes = new NotesView(state, project);
            knowledge = null;
            readKey = "";
        }
        _ = ReadMaterials(project);
        overview!.Update(project, knowledge, reading);
        answers!.Update(knowledge, reading, project.Brief, project.Materials.Count > 0);

        var section = state.Dashboard.Section;
        // Another page of the project, or another project: from the top.
        if (section != shownSection || shownScrolled != project.Id) Scroller.ChangeView(null, 0, null, disableAnimation: true);
        shownSection = section;
        shownScrolled = project.Id;
        Tabs.SelectedItem = section switch
        {
            ProjectTab.Answers => AnswersTab,
            ProjectTab.Notes => NotesTab,
            _ => OverviewTab,
        };
        var onNotes = section == ProjectTab.Notes;
        Scroller.Visibility = onNotes ? Visibility.Collapsed : Visibility.Visible;
        NotesHost.Visibility = onNotes ? Visibility.Visible : Visibility.Collapsed;
        // The notes page is only there while it is shown: leaving it stops the player.
        Place(NotesHost, onNotes ? notes : null);
        Place(TabHost, section switch
        {
            ProjectTab.Answers => answers,
            ProjectTab.Notes => null,
            _ => overview,
        });
        if (onNotes) notes!.Update(project);
    }

    /// <summary>
    /// Puts a page in its place unless it is there already: set again, a child is taken out and put back, and WinUI may tell it Unloaded after the Loaded
    /// of its return (Stop Cue redraws this page while a note is made: its Notes page then stopped following the note).
    /// </summary>
    private static void Place(Border host, UIElement? child)
    {
        if (!ReferenceEquals(host.Child, child)) host.Child = child;
    }

    /// <summary>Asks the account what it read from the project's files, when its files or Cue's brief of them changed.</summary>
    private async Task ReadMaterials(Project project)
    {
        var brief = $"{project.Brief.State}:{project.Brief.UpdatedAt}";
        var key = $"{project.ServerId}|{brief}|{string.Join(',', project.Materials.Select(material => $"{material.Id}:{material.Summary}"))}";
        if (key == readKey) return;
        readKey = key;
        var read = ++reads;
        reading = true;
        var known = await state.Projects.Knowledge(project.ServerId);
        // A newer read replaced this one, or the page moved to another project.
        if (read != reads || shown != project.Id) return;
        if (known is not null) knowledge = known;
        else readKey = "";
        reading = false;
        var current = state.Projects.Find(project.Id) ?? project;
        overview?.Update(current, knowledge, reading);
        answers?.Update(knowledge, reading, current.Brief, current.Materials.Count > 0);
    }
}
