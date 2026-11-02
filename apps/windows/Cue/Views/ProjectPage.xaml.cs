using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;

namespace Cue;

/// <summary>
/// A project's page: its name on top, then the talk and its materials, its prepared answers or its notes, picked in the bar under the name. Which
/// project and which page is the dashboard's (<see cref="DashboardModel.ProjectId"/>, <see cref="DashboardModel.Section"/>): the page follows it,
/// and the store, so a project picked in the pane, `page NAME` and an edit from another place all land here.
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
        SubtitleText.Text = string.Join(" · ", SpokenLanguage.Named(project.Language).Name, project.Materials.Count == 1 ? "1 file" : $"{project.Materials.Count} files");

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
        answers!.Update(knowledge, reading);

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
        NotesHost.Child = onNotes ? notes : null;
        TabHost.Child = section switch
        {
            ProjectTab.Answers => answers,
            ProjectTab.Notes => null,
            _ => overview,
        };
        if (onNotes) notes!.Update(project);
    }

    /// <summary>Asks the account what it read from the project's files, when its files or language changed.</summary>
    private async Task ReadMaterials(Project project)
    {
        var key = $"{project.ServerId}|{project.Language}|{string.Join(',', project.Materials.Select(material => $"{material.Id}:{material.Summary}"))}";
        if (key == readKey) return;
        readKey = key;
        var read = ++reads;
        reading = true;
        var documents = await state.Projects.Documents(project.ServerId);
        // A newer read replaced this one, or the page moved to another project.
        if (read != reads || shown != project.Id) return;
        if (documents is not null) knowledge = documents;
        else readKey = "";
        reading = false;
        overview?.Update(state.Projects.Find(project.Id) ?? project, knowledge, reading);
        answers?.Update(knowledge, reading);
    }
}
