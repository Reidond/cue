using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;
using Microsoft.UI.Xaml.Shapes;
using Launcher = Windows.System.Launcher;

namespace Cue;

/// <summary>
/// Today's and tomorrow's calls from the calendar, each with the project its notes go to (the Mac's UpcomingView). A call in progress can be recorded from its
/// row; the project of a recurring call is remembered for every time it comes. Behind the sign-in like every page but Home and Settings.
/// </summary>
public sealed partial class UpcomingPage : Page
{
    private AppState state = null!;
    private string shown = "";

    // Kept in a field: a timer only a local variable holds is collected, and stops. "In progress" changes with the clock, not only with the calendar.
    private DispatcherQueueTimer? clock;

    public UpcomingPage() => InitializeComponent();

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        state = (AppState)e.Parameter;
        SignInHost.Child = new SignInView(state);
        state.Api.PropertyChanged += OnChanged;
        state.Calendar.PropertyChanged += OnChanged;
        state.Meetings.PropertyChanged += OnChanged;
        state.Projects.PropertyChanged += OnChanged;
        state.Live.Recorder.PropertyChanged += OnChanged;
        state.Preferences.PropertyChanged += OnChanged;
        clock = state.Queue.CreateTimer();
        clock.Interval = TimeSpan.FromSeconds(20);
        clock.IsRepeating = true;
        clock.Tick += (_, _) => Render();
        clock.Start();
        shown = "";
        Render();
        _ = state.Calendar.Refresh(force: true);
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        state.Api.PropertyChanged -= OnChanged;
        state.Calendar.PropertyChanged -= OnChanged;
        state.Meetings.PropertyChanged -= OnChanged;
        state.Projects.PropertyChanged -= OnChanged;
        state.Live.Recorder.PropertyChanged -= OnChanged;
        state.Preferences.PropertyChanged -= OnChanged;
        clock?.Stop();
    }

    private void OnChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e) => Render();

    private void Render()
    {
        var signedIn = state.Api.IsSignedIn;
        SignInHost.Visibility = signedIn ? Visibility.Collapsed : Visibility.Visible;
        SignedIn.Visibility = signedIn ? Visibility.Visible : Visibility.Collapsed;
        if (!signedIn) return;

        var calendar = state.Calendar;
        var now = DateTimeOffset.Now;
        var recorder = state.Live.Recorder;
        var choices = Choices();
        // What a redraw would draw: nothing is rebuilt (an open project list closed under the person's hand) unless it differs.
        var signature = string.Join(
            '\n',
            calendar.Access,
            state.Preferences.MeetingAction,
            string.Join(',', choices.Select(choice => choice.Id)),
            recorder.StartedAt is null,
            string.Join('\n', calendar.Events.Select(item => $"{item.Id}|{item.Title}|{item.Start:O}|{item.End:O}|{string.Join('/', item.Attendees)}|{state.Meetings.ProjectId(item)}|{item.InProgress(now)}|{state.Meetings.RecordingEvent?.Id == item.Id}")));
        if (signature == shown) return;
        shown = signature;
        Body.Children.Clear();

        switch (calendar.Access)
        {
            case CalendarAccess.Denied:
                Body.Children.Add(EmptyState(
                    "",
                    "No Access to Your Calendar",
                    "Allow desktop apps to use your calendar in Settings › Privacy & security › Calendar, so Cue can list today’s and tomorrow’s calls here and offer to record each one when it starts.",
                    "Open Privacy Settings",
                    () => _ = Launcher.LaunchUriAsync(new Uri("ms-settings:privacy-calendar"))));
                return;
            case CalendarAccess.Unavailable:
                Body.Children.Add(EmptyState(
                    "",
                    "No Calendar to Read",
                    "Windows has no calendar service here, so Cue can’t list your calls. Calls in Zoom, Teams, Webex and Slack are still offered for recording when they start."));
                return;
        }
        if (calendar.Events.Count == 0)
        {
            Body.Children.Add(EmptyState(
                "",
                "No Upcoming Calls",
                "Calls in your calendar today and tomorrow with a Google Meet, Zoom, Teams or Webex link appear here, so Cue can offer to record them."));
            return;
        }
        foreach (var (title, items) in Days(calendar.Events))
        {
            Body.Children.Add(new TextBlock { Text = title, Style = (Style)Application.Current.Resources["SubtitleTextBlockStyle"] });
            Body.Children.Add(Ui.Card([.. items.Select(item => Row(item, choices, now, recorder.StartedAt is null))]));
        }
        var change = new HyperlinkButton { Content = "Change…", Padding = new Thickness(0) };
        change.Click += (_, _) => state.Dashboard.ShowSettings(SettingsTab.Calendar);
        Body.Children.Add(new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, Children = { Ui.Caption(Footer()), change } });
    }

    private static IEnumerable<(string Title, List<CalendarEvent> Items)> Days(IReadOnlyList<CalendarEvent> events)
    {
        var tomorrow = DateTime.Today.AddDays(1);
        var later = events.Where(item => item.Start.ToLocalTime().Date >= tomorrow).ToList();
        var today = events.Where(item => item.Start.ToLocalTime().Date < tomorrow).ToList();
        return new[] { ("Today", today), ("Tomorrow", later) }.Where(day => day.Item2.Count > 0);
    }

    /// <summary>Every project, and "Meetings" even before it exists (it is created for the first recording).</summary>
    private List<(string Id, string Name)> Choices()
    {
        var all = state.Projects.Projects.Select(project => (project.Id, project.Name)).ToList();
        if (state.Projects.FindByName(MeetingCalendar.DefaultProject) is null) all.Insert(0, (MeetingCalendar.DefaultProject, MeetingCalendar.DefaultProject));
        return all;
    }

    private string Footer() =>
        state.Preferences.MeetingAction switch
        {
            MeetingAction.Ask => "When a call starts and a call app uses the microphone, Cue asks whether to record it.",
            MeetingAction.Record => "When a call starts and a call app uses the microphone, Cue records it.",
            _ => "Cue doesn’t record calls when they start.",
        };

    private UIElement Row(CalendarEvent item, List<(string Id, string Name)> choices, DateTimeOffset now, bool idle)
    {
        var grid = new Grid { ColumnSpacing = 16, Padding = new Thickness(16, 10, 16, 10) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(64) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var times = new StackPanel { HorizontalAlignment = HorizontalAlignment.Right };
        times.Children.Add(new TextBlock { Text = Times.Clock(item.Start), TextAlignment = TextAlignment.Right });
        times.Children.Add(new TextBlock { Text = Times.Clock(item.End), TextAlignment = TextAlignment.Right, Foreground = Ui.Theme("TextFillColorSecondaryBrush") });
        grid.Children.Add(times);

        var heading = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        heading.Children.Add(new TextBlock { Text = item.Title, TextTrimming = TextTrimming.CharacterEllipsis, MaxLines = 1 });
        if (item.Recurring)
        {
            var repeats = Ui.Glyph("", 12);
            ToolTipService.SetToolTip(repeats, "Repeats — its project is remembered for every time");
            AutomationProperties.SetName(repeats, "Repeats");
            heading.Children.Add(repeats);
        }
        var details = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        var join = new HyperlinkButton { Content = item.Service.Name(), NavigateUri = item.Link, Padding = new Thickness(0), FontSize = 12 };
        ToolTipService.SetToolTip(join, "Join the call");
        details.Children.Add(join);
        if (item.Attendees.Count > 0)
        {
            details.Children.Add(new TextBlock { Text = "·", Style = (Style)Application.Current.Resources["CaptionTextBlockStyle"], Foreground = Ui.Theme("TextFillColorSecondaryBrush"), VerticalAlignment = VerticalAlignment.Center });
            details.Children.Add(new TextBlock
            {
                Text = string.Join(", ", item.Attendees),
                Style = (Style)Application.Current.Resources["CaptionTextBlockStyle"],
                Foreground = Ui.Theme("TextFillColorSecondaryBrush"),
                TextTrimming = TextTrimming.CharacterEllipsis,
                MaxLines = 1,
                VerticalAlignment = VerticalAlignment.Center,
            });
        }
        var text = new StackPanel { Spacing = 2, VerticalAlignment = VerticalAlignment.Center, Children = { heading, details } };
        Grid.SetColumn(text, 1);
        grid.Children.Add(text);

        UIElement? action = null;
        if (state.Meetings.RecordingEvent?.Id == item.Id)
        {
            action = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Spacing = 6,
                VerticalAlignment = VerticalAlignment.Center,
                Children =
                {
                    new Ellipse { Width = 10, Height = 10, Fill = Ui.Theme("SystemFillColorCriticalBrush"), VerticalAlignment = VerticalAlignment.Center },
                    new TextBlock { Text = "Recording", VerticalAlignment = VerticalAlignment.Center },
                },
            };
        }
        else if (item.InProgress(now) && idle)
        {
            var record = new Button
            {
                Content = new StackPanel
                {
                    Orientation = Orientation.Horizontal,
                    Spacing = 8,
                    Children = { new Ellipse { Width = 10, Height = 10, Fill = Ui.Theme("SystemFillColorCriticalBrush"), VerticalAlignment = VerticalAlignment.Center }, new TextBlock { Text = "Record" } },
                },
                VerticalAlignment = VerticalAlignment.Center,
            };
            AutomationProperties.SetName(record, $"Record {item.Title}");
            ToolTipService.SetToolTip(record, "Record this call now");
            record.Click += (_, _) => state.Meetings.Record(item);
            action = record;
        }
        if (action is not null)
        {
            Grid.SetColumn((FrameworkElement)action, 2);
            grid.Children.Add(action);
        }

        var project = new ComboBox { VerticalAlignment = VerticalAlignment.Center, MinWidth = 140 };
        foreach (var (id, name) in choices) project.Items.Add(new ComboBoxItem { Content = name, Tag = id });
        var current = state.Meetings.ProjectId(item);
        project.SelectedItem = project.Items.OfType<ComboBoxItem>().FirstOrDefault(choice => (string?)choice.Tag == current);
        AutomationProperties.SetName(project, $"Project of {item.Title}");
        ToolTipService.SetToolTip(project, "The project this call’s notes go to");
        project.SelectionChanged += (_, _) =>
        {
            if (project.SelectedItem is ComboBoxItem { Tag: string picked } && picked != state.Meetings.ProjectId(item)) state.Calendar.Assign(item, picked);
        };
        Grid.SetColumn(project, 3);
        grid.Children.Add(project);
        return grid;
    }

    private static StackPanel EmptyState(string glyph, string title, string message, string? action = null, Action? run = null)
    {
        var panel = new StackPanel { Spacing = 8, Margin = new Thickness(0, 36, 0, 0), HorizontalAlignment = HorizontalAlignment.Center, MaxWidth = 440 };
        panel.Children.Add(new FontIcon { Glyph = glyph, FontSize = 40, Foreground = Ui.Theme("TextFillColorSecondaryBrush") });
        panel.Children.Add(new TextBlock { Text = title, Style = (Style)Application.Current.Resources["SubtitleTextBlockStyle"], HorizontalAlignment = HorizontalAlignment.Center, TextAlignment = TextAlignment.Center });
        panel.Children.Add(new TextBlock { Text = message, Foreground = Ui.Theme("TextFillColorSecondaryBrush"), TextWrapping = TextWrapping.Wrap, TextAlignment = TextAlignment.Center });
        if (action is not null && run is not null)
        {
            var button = new Button { Content = action, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 8, 0, 0) };
            button.Click += (_, _) => run();
            panel.Children.Add(button);
        }
        return panel;
    }
}
