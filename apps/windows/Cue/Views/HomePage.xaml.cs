using System.Globalization;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;

namespace Cue;

/// <summary>The dashboard's first page: the sign-in screen until someone is signed in, then a way in for someone who has no project yet, and the newest notes across the projects.</summary>
public sealed partial class HomePage : Page
{
    private AppState state = null!;
    private string recentShown = "";
    private string upcomingShown = "";

    public HomePage() => InitializeComponent();

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        state = (AppState)e.Parameter;
        SignInHost.Child = new SignInView(state);
        state.Api.PropertyChanged += OnChanged;
        state.Projects.PropertyChanged += OnChanged;
        state.Recordings.Changed += OnRecordings;
        state.Calendar.PropertyChanged += OnChanged;
        state.Meetings.PropertyChanged += OnChanged;
        recentShown = "";
        upcomingShown = "";
        Render();
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        state.Api.PropertyChanged -= OnChanged;
        state.Projects.PropertyChanged -= OnChanged;
        state.Recordings.Changed -= OnRecordings;
        state.Calendar.PropertyChanged -= OnChanged;
        state.Meetings.PropertyChanged -= OnChanged;
    }

    private void OnChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e) => Render();

    private void OnRecordings() => Render();

    private void OnNewProject(object sender, RoutedEventArgs e) => _ = ProjectDialogs.NewProject(state, XamlRoot);

    private void Render()
    {
        var signedIn = state.Api.IsSignedIn;
        SignInHost.Visibility = signedIn ? Visibility.Collapsed : Visibility.Visible;
        SignedIn.Visibility = signedIn ? Visibility.Visible : Visibility.Collapsed;
        WhoText.Text = state.Api.Me is { } me ? $"Signed in as {me.Account.Email}." : "";
        var none = state.Projects.Projects.Count == 0;
        FirstProject.Visibility = none ? Visibility.Visible : Visibility.Collapsed;
        Recent.Visibility = none ? Visibility.Collapsed : Visibility.Visible;
        Upcoming.Visibility = none ? Visibility.Collapsed : Visibility.Visible;
        if (!none) ShowRecent();
        if (!none) ShowUpcoming();
    }

    /// <summary>The next calls from the calendar (three at most), each a way into Upcoming.</summary>
    private void ShowUpcoming()
    {
        var now = DateTimeOffset.Now;
        var next = state.Calendar.Events.Where(item => item.End > now).Take(3).ToList();
        var signature = string.Join('\n', next.Select(item => $"{item.Id}\t{item.Title}\t{item.Start:O}\t{state.Meetings.RecordingEvent?.Id == item.Id}"));
        if (signature == upcomingShown) return;
        upcomingShown = signature;
        Upcoming.Children.Clear();
        if (next.Count == 0) return;
        var header = new Grid();
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        header.Children.Add(new TextBlock { Text = "Upcoming Calls", Style = (Style)Application.Current.Resources["SubtitleTextBlockStyle"] });
        var all = new HyperlinkButton { Content = "See all", VerticalAlignment = VerticalAlignment.Center };
        all.Click += (_, _) => state.Dashboard.Page = DashboardPage.Upcoming;
        Grid.SetColumn(all, 1);
        header.Children.Add(all);
        Upcoming.Children.Add(header);
        Upcoming.Children.Add(Ui.Card([.. next.Select(CallRow)]));
    }

    private Button CallRow(CalendarEvent item)
    {
        var recording = state.Meetings.RecordingEvent?.Id == item.Id;
        var text = new StackPanel { Spacing = 2 };
        text.Children.Add(new TextBlock { Text = item.Title, TextTrimming = TextTrimming.CharacterEllipsis, MaxLines = 1 });
        text.Children.Add(new TextBlock
        {
            Text = $"{Times.Clock(item.Start)}–{Times.Clock(item.End)} · {item.Service.Name()}" + (recording ? " · Recording" : ""),
            Style = (Style)Application.Current.Resources["CaptionTextBlockStyle"],
            Foreground = Ui.Theme("TextFillColorSecondaryBrush"),
        });
        var grid = new Grid { ColumnSpacing = 12, Padding = new Thickness(0, 4, 0, 4) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.Children.Add(new FontIcon { Glyph = "\uE787", FontSize = 20, Foreground = Ui.Theme("TextFillColorSecondaryBrush"), VerticalAlignment = VerticalAlignment.Center });
        Grid.SetColumn(text, 1);
        grid.Children.Add(text);
        var clear = new Microsoft.UI.Xaml.Media.SolidColorBrush(Microsoft.UI.Colors.Transparent);
        var button = new Button { Content = grid, HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch, Background = clear, BorderThickness = new Thickness(0) };
        button.Resources["ButtonBackground"] = clear;
        button.Resources["ButtonBackgroundPointerOver"] = Ui.Theme("SubtleFillColorSecondaryBrush");
        button.Resources["ButtonBackgroundPressed"] = Ui.Theme("SubtleFillColorTertiaryBrush");
        button.Resources["ButtonBorderBrush"] = clear;
        button.Resources["ButtonBorderBrushPointerOver"] = clear;
        button.Resources["ButtonBorderBrushPressed"] = clear;
        AutomationProperties.SetName(button, $"Upcoming call: {item.Title}");
        button.Click += (_, _) => state.Dashboard.Page = DashboardPage.Upcoming;
        return button;
    }

    /// <summary>The newest notes across the projects, each a way into its page.</summary>
    private void ShowRecent()
    {
        var files = state.Recordings.Files.Take(8).ToList();
        var signature = string.Join('\n', files.Select(file => $"{file.Id}\t{file.Title}\t{file.Duration}\t{state.Recordings.IsProcessing(file.Id)}"));
        if (signature == recentShown) return;
        recentShown = signature;
        Recent.Children.Clear();
        Recent.Children.Add(new TextBlock { Text = "Recent Notes", Style = (Style)Application.Current.Resources["SubtitleTextBlockStyle"] });
        if (files.Count == 0)
        {
            Recent.Children.Add(Ui.Caption("Notes from recorded calls appear here. Press Win+Alt+C, or the record button in Cue, to record a call."));
            return;
        }
        Recent.Children.Add(Ui.Card([.. files.Select(Row)]));
    }

    private Button Row(RecordingFile file)
    {
        var project = state.Projects.Find(file.ProjectId)?.Name ?? file.ProjectId;
        var when = file.Date.ToLocalTime().ToString("g", CultureInfo.CurrentCulture);
        var text = new StackPanel { Spacing = 2 };
        text.Children.Add(new TextBlock { Text = file.Title, TextTrimming = TextTrimming.CharacterEllipsis, MaxLines = 1 });
        text.Children.Add(new TextBlock
        {
            Text = string.Join(" · ", new[] { project, when, file.Duration }.Where(part => part.Length > 0)),
            Style = (Style)Application.Current.Resources["CaptionTextBlockStyle"],
            Foreground = Ui.Theme("TextFillColorSecondaryBrush"),
        });
        var grid = new Grid { ColumnSpacing = 12, Padding = new Thickness(0, 4, 0, 4) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.Children.Add(new FontIcon { Glyph = "", FontSize = 20, Foreground = Ui.Theme("TextFillColorSecondaryBrush"), VerticalAlignment = VerticalAlignment.Center });
        Grid.SetColumn(text, 1);
        grid.Children.Add(text);
        var chevron = new FontIcon { Glyph = "", FontSize = 12, Foreground = Ui.Theme("TextFillColorTertiaryBrush"), VerticalAlignment = VerticalAlignment.Center };
        Grid.SetColumn(chevron, 2);
        grid.Children.Add(chevron);
        var clear = new Microsoft.UI.Xaml.Media.SolidColorBrush(Microsoft.UI.Colors.Transparent);
        var button = new Button
        {
            Content = grid,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            Background = clear,
            BorderThickness = new Thickness(0),
        };
        button.Resources["ButtonBackground"] = clear;
        button.Resources["ButtonBackgroundPointerOver"] = Ui.Theme("SubtleFillColorSecondaryBrush");
        button.Resources["ButtonBackgroundPressed"] = Ui.Theme("SubtleFillColorTertiaryBrush");
        button.Resources["ButtonBorderBrush"] = clear;
        button.Resources["ButtonBorderBrushPointerOver"] = clear;
        button.Resources["ButtonBorderBrushPressed"] = clear;
        AutomationProperties.SetName(button, file.Title);
        button.Click += (_, _) => state.Dashboard.OpenNote(file.Id);
        return button;
    }
}
