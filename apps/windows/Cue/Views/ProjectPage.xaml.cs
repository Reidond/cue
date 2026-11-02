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
        shown = null;
        Render();
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        state.Dashboard.PropertyChanged -= OnChanged;
        state.Projects.PropertyChanged -= OnChanged;
    }

    private void OnChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e) => Render();

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
            NameText.Text = "No Project Selected";
            SubtitleText.Text = "";
            Tabs.Visibility = Visibility.Collapsed;
            TabHost.Child = null;
            shown = null;
            return;
        }
        Tabs.Visibility = Visibility.Visible;
        NameText.Text = project.Name;
        SubtitleText.Text = string.Join(" · ", SpokenLanguage.Named(project.Language).Name, project.Materials.Count == 1 ? "1 file" : $"{project.Materials.Count} files");

        if (shown != project.Id)
        {
            shown = project.Id;
            overview = new ProjectOverviewView(state, project);
            answers = new PreparedAnswersView();
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
        TabHost.Child = section switch
        {
            ProjectTab.Answers => answers,
            ProjectTab.Notes => NotesPlaceholder(),
            _ => overview,
        };
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

    /// <summary>The notes are the notes slice's; the page has its place.</summary>
    private static UIElement NotesPlaceholder() =>
        new TextBlock
        {
            Text = "Notes of this project's calls will be here as Cue for Windows gets them.",
            Foreground = Ui.Theme("TextFillColorSecondaryBrush"),
            TextWrapping = TextWrapping.Wrap,
        };
}
