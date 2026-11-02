using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Shapes;
using Microsoft.UI.Xaml.Media;

namespace Cue;

/// <summary>
/// The record button: a red dot and "Record" while nothing is recorded; while one is, the time it has been going on, in a drop-down whose menu has Stop
/// Recording (Win+Alt+C does the same from anywhere); "Saving…" while the last phrase is transcribed after Stop. It sits in the overlay's bar
/// (<see cref="OverlayWindow.RecordSlot"/>) and on a project's Notes page. The Mac's record button and timer.
/// </summary>
internal sealed class RecordControl : ContentControl
{
    private enum Mode
    {
        Idle,
        Recording,
        Saving,
    }

    private readonly AppState state;
    private readonly RecordingTrigger trigger;
    private readonly bool subtle;
    private readonly DispatcherQueueTimer ticker;
    private Mode? mode;
    private TextBlock? elapsed;

    /// <param name="subtle">In the overlay's bar the button has no plate of its own.</param>
    public RecordControl(AppState state, RecordingTrigger trigger, bool subtle)
    {
        this.state = state;
        this.trigger = trigger;
        this.subtle = subtle;
        VerticalAlignment = VerticalAlignment.Center;
        // Kept in a field: a timer only a local variable holds is collected, and stops.
        ticker = state.Queue.CreateTimer();
        ticker.Interval = TimeSpan.FromSeconds(1);
        ticker.IsRepeating = true;
        ticker.Tick += (_, _) => Tick();
        Loaded += (_, _) =>
        {
            state.Live.Recorder.PropertyChanged += OnChanged;
            Update();
        };
        Unloaded += (_, _) =>
        {
            state.Live.Recorder.PropertyChanged -= OnChanged;
            ticker.Stop();
            mode = null;
        };
        Update();
    }

    private void OnChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e) => Update();

    private static Ellipse Dot() => new() { Width = 10, Height = 10, Fill = Ui.Theme("SystemFillColorCriticalBrush"), VerticalAlignment = VerticalAlignment.Center };

    private void Update()
    {
        var recorder = state.Live.Recorder;
        var now = recorder.Stopping ? Mode.Saving : recorder.IsRecording ? Mode.Recording : Mode.Idle;
        if (now == Mode.Recording) Tick();
        if (now == mode) return;
        mode = now;
        ticker.Stop();
        Content = now switch
        {
            Mode.Recording => Recording(),
            Mode.Saving => Saving(),
            _ => Idle(),
        };
        if (now == Mode.Recording)
        {
            Tick();
            ticker.Start();
        }
    }

    private void Tick()
    {
        if (elapsed is null || state.Live.Recorder.StartedAt is not { } started) return;
        elapsed.Text = RecordingStore.Clock(Math.Floor((DateTime.Now - started).TotalSeconds));
    }

    private Button Idle()
    {
        // In the overlay's narrow bar the idle button is the red dot alone (the status line needs the room); its name and tooltip say what it is.
        var button = new Button { Content = subtle ? (UIElement)Dot() : Label(new TextBlock { Text = "Record" }) };
        Plain(button);
        AutomationProperties.SetName(button, "Record");
        ToolTipService.SetToolTip(button, "Record a call into this project (Win+Alt+C)");
        button.Click += (_, _) => state.Live.ToggleRecording(trigger);
        return button;
    }

    private DropDownButton Recording()
    {
        elapsed = new TextBlock { VerticalAlignment = VerticalAlignment.Center };
        var stop = new MenuFlyoutItem { Text = "Stop Recording", Icon = new FontIcon { Glyph = "\uE71A" }, KeyboardAcceleratorTextOverride = "Win+Alt+C" };
        stop.Click += (_, _) => state.Live.StopRecording(trigger);
        var menu = new MenuFlyout();
        menu.Items.Add(stop);
        var button = new DropDownButton { Content = Label(elapsed), Flyout = menu };
        Plain(button);
        AutomationProperties.SetName(button, "Recording");
        ToolTipService.SetToolTip(button, "Recording — stop it from here or with Win+Alt+C");
        return button;
    }

    private Button Saving()
    {
        var button = new Button { Content = Label(new TextBlock { Text = "Saving…" }), IsEnabled = false };
        Plain(button);
        AutomationProperties.SetName(button, "Saving");
        return button;
    }

    private static StackPanel Label(TextBlock text)
    {
        text.VerticalAlignment = VerticalAlignment.Center;
        return new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Children = { Dot(), text } };
    }

    private void Plain(Button button)
    {
        // The same height whichever it is (the dot alone, the timer, Saving…), in the middle of the bar.
        button.MinHeight = 32;
        button.VerticalAlignment = VerticalAlignment.Center;
        button.VerticalContentAlignment = VerticalAlignment.Center;
        if (!subtle) return;
        var clear = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
        button.Resources["ButtonBackground"] = clear;
        button.Resources["ButtonBorderBrush"] = clear;
    }
}
