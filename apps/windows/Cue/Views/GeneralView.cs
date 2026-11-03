using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;

namespace Cue;

/// <summary>Settings › General: who the speaker is, what the notes of a recorded call get, and updates. The rest (answers, the library) comes with the slices that have them.</summary>
public sealed class GeneralView : UserControl
{
    private readonly AppState state;
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
