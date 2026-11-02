using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Launcher = Windows.System.Launcher;

namespace Cue;

/// <summary>Settings › Calendar: what Cue does when a call starts, and which calendars it looks in for calls (the Mac's CalendarSettings).</summary>
public sealed class CalendarView : UserControl
{
    private readonly AppState state;
    private readonly StackPanel root = new() { Spacing = 8 };
    private string shown = "";

    public CalendarView(AppState state)
    {
        this.state = state;
        Content = root;
        Render();
        Loaded += (_, _) =>
        {
            state.Calendar.PropertyChanged += OnChanged;
            _ = state.Calendar.Refresh(force: true);
            Render();
        };
        Unloaded += (_, _) => state.Calendar.PropertyChanged -= OnChanged;
    }

    private void OnChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e) => Render();

    private void Render()
    {
        var calendar = state.Calendar;
        var signature = $"{calendar.Access}|{string.Join(',', calendar.Calendars.Select(source => $"{source.Id}:{source.Title}:{!state.Preferences.UnwatchedCalendars.Contains(source.Id)}"))}";
        if (signature == shown) return;
        shown = signature;
        root.Children.Clear();

        var action = new ComboBox { MinWidth = 220 };
        foreach (var option in Enum.GetValues<MeetingAction>()) action.Items.Add(new ComboBoxItem { Content = option.Title(), Tag = option });
        action.SelectedItem = action.Items.OfType<ComboBoxItem>().First(item => (MeetingAction)item.Tag == state.Preferences.MeetingAction);
        AutomationProperties.SetName(action, "When a meeting starts");
        action.SelectionChanged += (_, _) =>
        {
            if (action.SelectedItem is ComboBoxItem { Tag: MeetingAction picked }) state.Preferences.MeetingAction = picked;
        };
        var row = new Grid { ColumnSpacing = 16 };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.Children.Add(new TextBlock { Text = "When a meeting starts", VerticalAlignment = VerticalAlignment.Center });
        Grid.SetColumn(action, 1);
        row.Children.Add(action);
        root.Children.Add(Ui.Card(Ui.Padded(row)));

        root.Children.Add(Ui.Header("Calendars"));
        switch (calendar.Access)
        {
            case CalendarAccess.Granted when calendar.Calendars.Count > 0:
                root.Children.Add(Ui.Card([.. calendar.Calendars.Select(source => (UIElement)Ui.Padded(Watching(source)))]));
                break;
            case CalendarAccess.Granted:
                root.Children.Add(Ui.Card(Ui.Padded(new TextBlock { Text = "Windows has no calendar for Cue to look in.", Foreground = Ui.Theme("TextFillColorSecondaryBrush") })));
                break;
            case CalendarAccess.Denied:
                var open = new Button { Content = "Open Privacy Settings" };
                open.Click += (_, _) => _ = Launcher.LaunchUriAsync(new Uri("ms-settings:privacy-calendar"));
                root.Children.Add(Ui.Card(Ui.Padded(Labelled("Calendars", open, "Desktop apps aren’t allowed to use your calendar."))));
                break;
            default:
                root.Children.Add(Ui.Card(Ui.Padded(new TextBlock { Text = "Windows has no calendar service here.", Foreground = Ui.Theme("TextFillColorSecondaryBrush") })));
                break;
        }
        root.Children.Add(Ui.Caption(
            "Calls with a Meet, Zoom, Teams or Webex link in these calendars show in Upcoming. When one starts and a call app uses the microphone, Cue offers to record it — "
            + "calls in Zoom, Teams, Webex or Slack too — and stops a minute after the app lets go of the microphone. Cue reads the calendars Windows keeps for the accounts "
            + "added in Settings › Accounts and for the apps that write to them."));
    }

    private static Grid Labelled(string label, UIElement control, string description)
    {
        var grid = new Grid { ColumnSpacing = 16 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var text = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        text.Children.Add(new TextBlock { Text = label });
        text.Children.Add(Ui.Caption(description));
        grid.Children.Add(text);
        Grid.SetColumn((FrameworkElement)control, 1);
        grid.Children.Add(control);
        return grid;
    }

    /// <summary>A calendar with its switch: on, Cue looks in it for calls.</summary>
    private Grid Watching(CalendarSource source)
    {
        var toggle = new ToggleSwitch { IsOn = !state.Preferences.UnwatchedCalendars.Contains(source.Id), MinWidth = 0 };
        AutomationProperties.SetName(toggle, $"Watch {source.Title}");
        toggle.Toggled += (_, _) =>
        {
            state.Preferences.SetWatched(source.Id, toggle.IsOn);
            _ = state.Calendar.Refresh(force: true);
        };
        var grid = new Grid { ColumnSpacing = 16 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var text = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        text.Children.Add(new TextBlock { Text = source.Title });
        if (source.Account.Length > 0) text.Children.Add(Ui.Caption(source.Account));
        grid.Children.Add(text);
        Grid.SetColumn(toggle, 1);
        grid.Children.Add(toggle);
        return grid;
    }
}
