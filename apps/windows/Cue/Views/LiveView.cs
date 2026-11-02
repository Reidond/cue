using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Cue;

/// <summary>
/// Home's Start Cue: the project to answer from and the button that starts (and stops) listening. When the projects slice's pages arrive the button moves
/// onto a project's page, as the Mac has it; the project is found in <see cref="ProjectLookup"/>'s one small place until then.
/// </summary>
public sealed class LiveView : UserControl
{
    private readonly AppState state;
    private readonly StackPanel root = new() { Spacing = 8 };
    private readonly ComboBox projects = new() { MinWidth = 260, PlaceholderText = "No project" };
    private readonly Button toggle = new() { MinWidth = 110 };
    private readonly TextBlock status = new() { VerticalAlignment = VerticalAlignment.Center, TextWrapping = TextWrapping.Wrap };
    private bool rendering;

    public LiveView(AppState state)
    {
        this.state = state;
        Content = root;
        root.Children.Add(Ui.Header("Live call"));
        var picker = new Grid { ColumnSpacing = 16 };
        picker.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        picker.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        picker.Children.Add(new TextBlock { Text = "Project", VerticalAlignment = VerticalAlignment.Center });
        Grid.SetColumn(projects, 1);
        picker.Children.Add(projects);
        var controls = new Grid { ColumnSpacing = 16 };
        controls.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        controls.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        controls.Children.Add(status);
        toggle.Style = (Style)Application.Current.Resources["AccentButtonStyle"];
        Grid.SetColumn(toggle, 1);
        controls.Children.Add(toggle);
        root.Children.Add(Ui.Card(Ui.Padded(picker), Ui.Padded(controls)));
        root.Children.Add(Ui.Caption("Ctrl+Enter starts and stops Cue from this window. Win+Alt+H shows or hides the overlay, Win+Alt+Enter answers the last thing said."));

        projects.SelectionChanged += (_, _) =>
        {
            if (!rendering && projects.SelectedItem is ProjectInfo project) state.Live.Activate(project);
        };
        toggle.Click += (_, _) => state.Live.ToggleCue();
        state.Live.Changed += Render;
        state.Live.PropertyChanged += OnChanged;
        Unloaded += (_, _) =>
        {
            state.Live.Changed -= Render;
            state.Live.PropertyChanged -= OnChanged;
        };
        Render();
    }

    private void OnChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(LiveModel.CueRunning)) Render();
    }

    private void Render()
    {
        var live = state.Live;
        rendering = true;
        try
        {
            projects.DisplayMemberPath = nameof(ProjectInfo.Name);
            projects.ItemsSource = live.Projects;
            projects.SelectedItem = live.Projects.FirstOrDefault(project => project.Id == live.ActiveProject?.Id);
            projects.IsEnabled = live.Projects.Count > 0;
        }
        finally
        {
            rendering = false;
        }
        toggle.Content = live.CueRunning ? "Stop Cue" : "Start Cue";
        toggle.IsEnabled = live.CueRunning || live.ActiveProject is not null;
        status.Text = live.Projects.Count == 0 && !live.CueRunning ? "No projects in your account yet." : live.CueRunning ? live.Status.Text : "Not listening";
    }
}
