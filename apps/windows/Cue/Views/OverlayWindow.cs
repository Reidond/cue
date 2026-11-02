using Microsoft.UI;
using Microsoft.UI.Composition;
using Microsoft.UI.Composition.SystemBackdrops;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Input;
using Microsoft.UI.Text;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.Graphics;
using WinRT.Interop;

namespace Cue;

/// <summary>
/// The floating prompter: its own window, above every other (a PowerPoint slide show too) and never taking the focus; hidden from screen sharing and
/// screenshots (CUE_ALLOW_CAPTURE shows it); a translucent Fluent material (acrylic that stays acrylic though the window is never active). A bar with
/// the project, the status and a few switches, the question list with the answer in view, the live transcript and the Ask field.
/// Typing into Ask is the one time it takes the keyboard focus, and it gives it back to the window it took it from.
/// </summary>
public sealed class OverlayWindow : Window
{
    private readonly AppState state;
    private readonly SolidColorBrush clear = new(Colors.Transparent);
    private readonly DispatcherQueueTimer renderTimer;
    private bool dirty = true;

    // The bar.
    private readonly FontIcon micIcon = new() { Glyph = "", FontSize = 16 };
    private readonly FontIcon callIcon = new() { Glyph = "", FontSize = 16 };
    private readonly Button projectButton = new();
    private readonly TextBlock projectName = new() { FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center };
    private readonly Button statusButton = new();
    private readonly ContentControl statusMark = new() { VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBlock statusText = new() { VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis, MaxLines = 1 };
    private readonly ToggleButton autoToggle = new() { Content = "Auto" };
    private readonly ToggleButton transcriptToggle = new();
    private ProgressRing? workingRing;

    // The lists.
    private readonly StackPanel list = new() { Spacing = 2, Padding = new Thickness(8) };
    private readonly ScrollViewer listScroll = new() { VerticalScrollBarVisibility = ScrollBarVisibility.Hidden, VerticalScrollMode = ScrollMode.Auto };
    private readonly Button newQuestions = new() { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 10, 0, 0), Visibility = Visibility.Collapsed };
    private readonly Border transcriptCard = new();
    private readonly StackPanel transcriptLines = new() { Spacing = 4, Padding = new Thickness(16, 12, 16, 12) };
    private readonly ScrollViewer transcriptScroll = new() { VerticalScrollBarVisibility = ScrollBarVisibility.Hidden };
    private readonly HashSet<Guid> preparedOpen = [];
    private Guid? lastExpanded;

    // Ask.
    private readonly TextBox askBox = new() { PlaceholderText = "Ask anything", BorderThickness = new Thickness(0), VerticalAlignment = VerticalAlignment.Center };
    private IntPtr before;
    private bool typing;

    private IntPtr handle;
    private DispatcherQueueTimer? saveTimer;
    private bool shown;

    public OverlayWindow(AppState state)
    {
        this.state = state;
        Title = "Cue overlay";
        SystemBackdrop = new ActiveAcrylicBackdrop();
        handle = WindowNative.GetWindowHandle(this);
        Content = Build();
        ConfigureWindow();
        Place();

        var live = state.Live;
        live.ShowOverlay = Present;
        live.HideOverlay = Dismiss;
        live.OverlayVisible = () => shown;
        live.Changed += () => dirty = true;
        live.PropertyChanged += (_, _) => UpdateBar();
        state.Preferences.PropertyChanged += (_, _) => dirty = true;
        state.PropertyChanged += (_, _) => UpdateBar();
        Closed += (_, _) => shown = false;
        // Kept in a field: a timer only a local variable holds is collected, and stops.
        renderTimer = state.Queue.CreateTimer();
        renderTimer.Interval = TimeSpan.FromMilliseconds(100);
        renderTimer.IsRepeating = true;
        renderTimer.Tick += (_, _) =>
        {
            UpdateBar();
            if (!dirty || !shown) return;
            dirty = false;
            Render();
        };
        renderTimer.Start();
        UpdateBar();
        Render();
    }

    public IntPtr Handle => handle;

    /// <summary>The place the recordings slice puts its record button (and, while recording, the timer that stops it): the bar leaves it empty.</summary>
    public ContentControl RecordSlot { get; } = new() { VerticalAlignment = VerticalAlignment.Center };

    public bool IsShown => shown;

    // MARK: The window

    private void ConfigureWindow()
    {
        var presenter = OverlappedPresenter.Create();
        presenter.SetBorderAndTitleBar(true, false);
        presenter.IsResizable = true;
        presenter.IsMaximizable = false;
        presenter.IsMinimizable = false;
        // Over everything, a full-screen slide show too. Under CUE_BACKGROUND (a test run) it stays among the other windows unless the case is about it.
        presenter.IsAlwaysOnTop = !Env.Background || Env.Surfaces;
        presenter.PreferredMinimumWidth = 400;
        presenter.PreferredMinimumHeight = 360;
        AppWindow.SetPresenter(presenter);
        AppWindow.SetIcon(System.IO.Path.Combine(AppContext.BaseDirectory, "Assets", "AppIcon.ico"));
        // No taskbar button or Alt+Tab entry, and a click never makes it the active window.
        NativeShell.SetExStyle(handle, NativeShell.WsExToolWindow | NativeShell.WsExNoActivate, true);
        NativeShell.RoundCorners(handle);
        if (!Env.AllowCapture) NativeShell.ExcludeFromCapture(handle);
        AppWindow.Changed += (_, change) =>
        {
            if (!change.DidPositionChange && !change.DidSizeChange) return;
            // Saved a moment after the last move or resize.
            saveTimer ??= state.Queue.CreateTimer();
            saveTimer.Interval = TimeSpan.FromSeconds(1);
            saveTimer.IsRepeating = false;
            saveTimer.Tick -= SaveBounds;
            saveTimer.Tick += SaveBounds;
            saveTimer.Stop();
            saveTimer.Start();
        };
    }

    private void SaveBounds(DispatcherQueueTimer sender, object args)
    {
        if (Storage.IsSandboxed || !shown) return;
        var at = AppWindow.Position;
        var size = AppWindow.Size;
        state.Preferences.OverlayBounds = $"{at.X},{at.Y},{size.Width},{size.Height}";
    }

    /// <summary>Where it was left, else the top right corner of the screen.</summary>
    private void Place()
    {
        var scale = Math.Max(Native.GetDpiForWindow(handle), 96u) / 96.0;
        var width = (int)Math.Round(520 * scale);
        var height = (int)Math.Round(640 * scale);
        var remembered = Storage.IsSandboxed ? null : state.Preferences.OverlayBounds?.Split(',').Select(text => int.TryParse(text, out var n) ? n : int.MinValue).ToArray();
        if (remembered is { Length: 4 } r && r.All(n => n != int.MinValue) && DisplayArea.GetFromRect(new RectInt32(r[0], r[1], r[2], r[3]), DisplayAreaFallback.None) is not null)
        {
            AppWindow.MoveAndResize(new RectInt32(r[0], r[1], r[2], r[3]));
            return;
        }
        var area = DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Primary).WorkArea;
        var margin = (int)Math.Round(20 * scale);
        width = Math.Min(width, area.Width - 2 * margin);
        height = Math.Min(height, area.Height - 2 * margin);
        AppWindow.MoveAndResize(new RectInt32(area.X + area.Width - width - margin, area.Y + margin, width, height));
    }

    /// <summary>Shows the overlay without taking the focus.</summary>
    private void Present()
    {
        shown = true;
        AppWindow.Show(false);
        if (Env.Background && !Env.Surfaces) NativeShell.SetBottom(handle);
        else NativeShell.SetTopmost(handle, true);
        dirty = true;
        Render();
    }

    private void Dismiss()
    {
        EndTyping(giveBack: true);
        shown = false;
        AppWindow.Hide();
    }

    // MARK: Building

    private static Brush Theme(string key) => (Brush)Application.Current.Resources[key];

    private static FontIcon Glyph(string glyph, double size = 14, Brush? foreground = null) =>
        new() { Glyph = glyph, FontSize = size, Foreground = foreground ?? Theme("TextFillColorPrimaryBrush") };

    /// <summary>A button without a plate of its own: only the hover and press show.</summary>
    private void Subtle(Button button)
    {
        button.Background = clear;
        button.BorderThickness = new Thickness(0);
        button.Padding = new Thickness(6, 4, 6, 4);
        button.Resources["ButtonBackground"] = clear;
        button.Resources["ButtonBackgroundPointerOver"] = Theme("SubtleFillColorSecondaryBrush");
        button.Resources["ButtonBackgroundPressed"] = Theme("SubtleFillColorTertiaryBrush");
        button.Resources["ButtonBorderBrush"] = clear;
        button.Resources["ButtonBorderBrushPointerOver"] = clear;
        button.Resources["ButtonBorderBrushPressed"] = clear;
    }

    private void Subtle(ToggleButton button)
    {
        button.Background = clear;
        button.BorderThickness = new Thickness(0);
        button.Padding = new Thickness(6, 4, 6, 4);
        foreach (var name in new[] { "ToggleButtonBackground", "ToggleButtonBorderBrush", "ToggleButtonBorderBrushPointerOver", "ToggleButtonBorderBrushPressed" })
            button.Resources[name] = clear;
        button.Resources["ToggleButtonBackgroundPointerOver"] = Theme("SubtleFillColorSecondaryBrush");
        button.Resources["ToggleButtonBackgroundPressed"] = Theme("SubtleFillColorTertiaryBrush");
        button.Resources["ToggleButtonBackgroundChecked"] = clear;
        button.Resources["ToggleButtonBackgroundCheckedPointerOver"] = Theme("SubtleFillColorSecondaryBrush");
        button.Resources["ToggleButtonBackgroundCheckedPressed"] = Theme("SubtleFillColorTertiaryBrush");
        button.Resources["ToggleButtonBorderBrushChecked"] = clear;
        button.Resources["ToggleButtonBorderBrushCheckedPointerOver"] = clear;
        button.Resources["ToggleButtonBorderBrushCheckedPressed"] = clear;
        button.Resources["ToggleButtonForegroundChecked"] = Theme("AccentTextFillColorPrimaryBrush");
        button.Resources["ToggleButtonForegroundCheckedPointerOver"] = Theme("AccentTextFillColorPrimaryBrush");
        button.Resources["ToggleButtonForegroundCheckedPressed"] = Theme("AccentTextFillColorSecondaryBrush");
    }

    private static Border Plate(UIElement child, double radius, Thickness? padding = null) =>
        new()
        {
            Child = child,
            CornerRadius = new CornerRadius(radius),
            Background = Theme("LayerFillColorDefaultBrush"),
            BorderBrush = Theme("CardStrokeColorDefaultBrush"),
            BorderThickness = new Thickness(1),
            Padding = padding ?? new Thickness(0),
        };

    private UIElement Build()
    {
        var root = new Grid { Padding = new Thickness(10), RowSpacing = 10 };
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        var bar = BuildBar();
        Grid.SetRow(bar, 0);
        root.Children.Add(bar);

        listScroll.Content = list;
        listScroll.ViewChanged += (_, _) => state.Live.ListScrolled = listScroll.VerticalOffset > 24;
        newQuestions.Style = (Style)Application.Current.Resources["AccentButtonStyle"];
        newQuestions.CornerRadius = new CornerRadius(16);
        newQuestions.Click += (_, _) =>
        {
            state.Live.ShowNewest();
            listScroll.ChangeView(null, 0, null, true);
        };
        ToolTipService.SetToolTip(newQuestions, "Show the newest question");
        var listHost = new Grid { Children = { listScroll, newQuestions } };
        var listPlate = Plate(listHost, 20);
        Grid.SetRow(listPlate, 1);
        root.Children.Add(listPlate);

        transcriptScroll.Content = transcriptLines;
        transcriptCard.Child = transcriptScroll;
        transcriptCard.Height = 104;
        transcriptCard.CornerRadius = new CornerRadius(16);
        transcriptCard.Background = Theme("LayerFillColorDefaultBrush");
        transcriptCard.BorderBrush = Theme("CardStrokeColorDefaultBrush");
        transcriptCard.BorderThickness = new Thickness(1);
        Grid.SetRow(transcriptCard, 2);
        root.Children.Add(transcriptCard);

        var ask = BuildAsk();
        Grid.SetRow(ask, 3);
        root.Children.Add(ask);
        return root;
    }

    private FrameworkElement BuildBar()
    {
        var grid = new Grid { ColumnSpacing = 6, Padding = new Thickness(14, 0, 8, 0), Height = 40 };
        for (var i = 0; i < 8; i++)
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = i == 3 ? new GridLength(1, GridUnitType.Star) : GridLength.Auto });

        void Put(UIElement element, int column)
        {
            Grid.SetColumn((FrameworkElement)element, column);
            grid.Children.Add(element);
        }

        micIcon.VerticalAlignment = VerticalAlignment.Center;
        callIcon.VerticalAlignment = VerticalAlignment.Center;
        micIcon.Margin = new Thickness(0, 0, 6, 0);
        callIcon.Margin = new Thickness(0, 0, 6, 0);
        Put(micIcon, 0);
        Put(callIcon, 1);

        projectButton.Content = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4, Children = { projectName, Glyph("", 9, Theme("TextFillColorSecondaryBrush")) } };
        Subtle(projectButton);
        projectButton.Flyout = ProjectMenu();
        ToolTipService.SetToolTip(projectButton, "Project — switch it, or open the dashboard");
        AutomationProperties.SetName(projectButton, "Project");
        Put(projectButton, 2);

        statusButton.Content = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, Children = { statusMark, statusText } };
        Subtle(statusButton);
        statusButton.HorizontalAlignment = HorizontalAlignment.Left;
        statusButton.Click += (_, _) => state.OpenDashboard();
        Put(statusButton, 3);

        Put(RecordSlot, 4);

        autoToggle.IsChecked = state.Preferences.AutoAnswer;
        Subtle(autoToggle);
        autoToggle.Click += (_, _) => state.Preferences.AutoAnswer = autoToggle.IsChecked == true;
        ToolTipService.SetToolTip(autoToggle, "Answer questions as they're asked; off, they're listed for Prepare Answer (Win+Alt+A)");
        Put(autoToggle, 5);

        transcriptToggle.Content = Glyph("", 14);
        Subtle(transcriptToggle);
        transcriptToggle.Click += (_, _) => state.Preferences.ShowTranscript = transcriptToggle.IsChecked == true;
        ToolTipService.SetToolTip(transcriptToggle, "Show transcript");
        AutomationProperties.SetName(transcriptToggle, "Show transcript");
        Put(transcriptToggle, 6);

        var settings = new Button { Content = Glyph("", 14) };
        Subtle(settings);
        settings.Click += (_, _) =>
        {
            state.Dashboard.ShowSettings();
            state.OpenDashboard();
        };
        ToolTipService.SetToolTip(settings, "Settings");
        AutomationProperties.SetName(settings, "Settings");
        Put(settings, 7);

        var bar = new Border
        {
            Child = grid,
            CornerRadius = new CornerRadius(20),
            Background = Theme("LayerFillColorDefaultBrush"),
            BorderBrush = Theme("CardStrokeColorDefaultBrush"),
            BorderThickness = new Thickness(1),
        };
        // The bar is the handle for moving the overlay (a click on one of its buttons is theirs).
        bar.PointerPressed += (_, e) =>
        {
            if (!e.GetCurrentPoint(bar).Properties.IsLeftButtonPressed) return;
            NativeShell.ReleaseCapture();
            NativeShell.SendMessage(handle, NativeShell.WmNclButtonDown, NativeShell.HtCaption, 0);
        };
        return bar;
    }

    private MenuFlyout ProjectMenu()
    {
        var menu = new MenuFlyout();
        menu.Opening += (_, _) =>
        {
            menu.Items.Clear();
            var live = state.Live;
            foreach (var project in live.Projects)
            {
                var item = new ToggleMenuFlyoutItem { Text = project.Name, IsChecked = project.Id == live.ActiveProject?.Id };
                var chosen = project;
                item.Click += (_, _) => live.Activate(chosen);
                menu.Items.Add(item);
            }
            if (live.Projects.Count > 0) menu.Items.Add(new MenuFlyoutSeparator());
            var dashboard = new MenuFlyoutItem { Text = "Open Dashboard…" };
            dashboard.Click += (_, _) => state.OpenDashboard();
            menu.Items.Add(dashboard);
            var stop = new MenuFlyoutItem { Text = "Stop Cue" };
            stop.Click += (_, _) => live.StopCue();
            menu.Items.Add(stop);
        };
        return menu;
    }

    private FrameworkElement BuildAsk()
    {
        AutomationProperties.SetName(askBox, "Ask anything");
        // The field is the pill's own: no plate of its own inside it.
        askBox.Background = clear;
        foreach (var name in new[] { "TextControlBackground", "TextControlBackgroundPointerOver", "TextControlBackgroundFocused", "TextControlBorderBrush", "TextControlBorderBrushPointerOver", "TextControlBorderBrushFocused" })
            askBox.Resources[name] = clear;
        askBox.AddHandler(UIElement.PointerPressedEvent, new PointerEventHandler((_, _) => BeginTyping()), true);
        askBox.GotFocus += (_, _) => BeginTyping();
        askBox.LostFocus += (_, _) => EndTyping(giveBack: false);
        askBox.KeyDown += (_, e) =>
        {
            if (e.Key == Windows.System.VirtualKey.Enter)
            {
                e.Handled = true;
                var question = askBox.Text.Trim();
                if (question.Length > 0) state.Live.Ask(question);
                askBox.Text = "";
                EndTyping(giveBack: true);
            }
            else if (e.Key == Windows.System.VirtualKey.Escape)
            {
                e.Handled = true;
                askBox.Text = "";
                EndTyping(giveBack: true);
            }
        };
        var field = new Grid { ColumnSpacing = 8, Padding = new Thickness(14, 0, 6, 0), Height = 40 };
        field.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        field.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var icon = Glyph("", 14, Theme("TextFillColorSecondaryBrush"));
        icon.VerticalAlignment = VerticalAlignment.Center;
        field.Children.Add(icon);
        Grid.SetColumn(askBox, 1);
        field.Children.Add(askBox);
        var pill = Plate(field, 20);

        var answerNow = new Button
        {
            Content = Glyph("", 16, Theme("TextOnAccentFillColorPrimaryBrush")),
            Width = 40,
            Height = 40,
            Padding = new Thickness(0),
            CornerRadius = new CornerRadius(20),
            Style = (Style)Application.Current.Resources["AccentButtonStyle"],
        };
        answerNow.Click += (_, _) => state.Live.AnswerNow();
        ToolTipService.SetToolTip(answerNow, "Answer the last thing said (Win+Alt+Enter)");
        AutomationProperties.SetName(answerNow, "Answer now");

        var row = new Grid { ColumnSpacing = 8 };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.Children.Add(pill);
        Grid.SetColumn(answerNow, 1);
        row.Children.Add(answerNow);
        return row;
    }

    // MARK: Typing into Ask

    /// <summary>The one time the overlay takes the keyboard focus: the window may be activated, and remembers the window it took the focus from.</summary>
    private void BeginTyping()
    {
        if (typing) return;
        typing = true;
        before = NativeShell.GetForegroundWindow();
        NativeShell.SetExStyle(handle, NativeShell.WsExNoActivate, false);
        NativeShell.SetForegroundWindow(handle);
        state.Queue.TryEnqueue(() =>
        {
            if (typing) askBox.Focus(FocusState.Programmatic);
        });
    }

    /// <summary>Done typing: it can no longer be activated, and the focus goes back to where it was.</summary>
    private void EndTyping(bool giveBack)
    {
        if (!typing) return;
        typing = false;
        NativeShell.SetExStyle(handle, NativeShell.WsExNoActivate, true);
        var back = before;
        before = IntPtr.Zero;
        if (giveBack && back != IntPtr.Zero && back != handle && NativeShell.IsWindow(back)) NativeShell.SetForegroundWindow(back);
    }

    // MARK: Showing the state

    /// <summary>The bar: the meters, the project and the status, as they are now (cheap: runs on every tick).</summary>
    private void UpdateBar()
    {
        var live = state.Live;
        micIcon.Opacity = live.Mic.Ok ? 0.35 + 0.65 * Math.Min(Math.Sqrt(live.MicLevel) * 3, 1) : 1;
        callIcon.Opacity = live.Call.Ok ? 0.35 + 0.65 * Math.Min(Math.Sqrt(live.CallLevel) * 3, 1) : 1;
        micIcon.Foreground = live.Mic.Ok ? Theme("TextFillColorPrimaryBrush") : Theme("SystemFillColorCriticalBrush");
        callIcon.Foreground = live.Call.Ok ? Theme("TextFillColorPrimaryBrush") : Theme("SystemFillColorCriticalBrush");
        micIcon.Glyph = live.Mic.Ok ? "" : ""; // the microphone, or the microphone crossed out
        callIcon.Glyph = live.Call.Ok ? "" : ""; // the speaker, or the speaker muted
        ToolTipService.SetToolTip(micIcon, live.Mic.Detail);
        ToolTipService.SetToolTip(callIcon, live.Call.Detail);
        AutomationProperties.SetName(micIcon, $"Microphone: {live.Mic.Detail}");
        AutomationProperties.SetName(callIcon, $"Call audio: {live.Call.Detail}");

        var name = live.ActiveProject?.Name ?? "No Project";
        projectName.Text = name.Length > 22 ? name[..21] + "…" : name;

        var (text, kind) = live.Status;
        statusText.Text = text;
        statusText.Foreground = kind == StatusKind.Problem ? Theme("TextFillColorPrimaryBrush") : Theme("TextFillColorSecondaryBrush");
        ToolTipService.SetToolTip(statusButton, state.PlanLimit ?? (kind == StatusKind.Problem ? "Open the dashboard to fix this" : text));
        switch (kind)
        {
            case StatusKind.Ready:
                if (statusMark.Content is not Ellipse) statusMark.Content = new Ellipse { Width = 7, Height = 7, Fill = Theme("SystemFillColorSuccessBrush") };
                break;
            case StatusKind.Working:
                workingRing ??= new ProgressRing { Width = 14, Height = 14, IsActive = true };
                if (!ReferenceEquals(statusMark.Content, workingRing)) statusMark.Content = workingRing;
                break;
            default:
                if (statusMark.Content is not FontIcon) statusMark.Content = Glyph("", 13, Theme("SystemFillColorCautionBrush"));
                break;
        }

        if (autoToggle.IsChecked != state.Preferences.AutoAnswer) autoToggle.IsChecked = state.Preferences.AutoAnswer;
        if (transcriptToggle.IsChecked != state.Preferences.ShowTranscript) transcriptToggle.IsChecked = state.Preferences.ShowTranscript;
        transcriptCard.Visibility = state.Preferences.ShowTranscript ? Visibility.Visible : Visibility.Collapsed;
        newQuestions.Visibility = state.Live.Unseen.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    private void Render()
    {
        var live = state.Live;
        var size = state.Preferences.TextSize;
        list.Children.Clear();
        if (live.Exchanges.Count == 0)
        {
            list.Children.Add(EmptyState(size));
        }
        else
        {
            if (live.Current is { } current) list.Children.Add(ExchangeCard(current, size));
            Group("New", live.NewExchanges, size);
            Group("Answered", live.AnsweredExchanges, size, 0.75);
        }
        newQuestions.Content = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Spacing = 6,
            Children = { Glyph("", 12, Theme("TextOnAccentFillColorPrimaryBrush")), new TextBlock { Text = live.Unseen.Count == 1 ? "1 New Question" : $"{live.Unseen.Count} New Questions", FontWeight = FontWeights.SemiBold } },
        };
        // The exchange shown in full is always on top; new ones show at the top unless the view is held or scrolled away.
        if (live.ExpandedId != lastExpanded || (!live.Holding && !live.ListScrolled)) listScroll.ChangeView(null, 0, null, true);
        lastExpanded = live.ExpandedId;
        RenderTranscript(size);
        UpdateBar();
    }

    private void Group(string title, IReadOnlyList<Exchange> exchanges, double size, double opacity = 1)
    {
        if (exchanges.Count == 0) return;
        var group = new StackPanel { Opacity = opacity };
        group.Children.Add(new TextBlock
        {
            Text = title.ToUpperInvariant(),
            FontSize = 12,
            FontWeight = FontWeights.SemiBold,
            Foreground = Theme("TextFillColorSecondaryBrush"),
            Margin = new Thickness(12, 12, 12, 2),
        });
        foreach (var exchange in exchanges) group.Children.Add(ExchangeRow(exchange, size));
        list.Children.Add(group);
    }

    private UIElement EmptyState(double size)
    {
        var live = state.Live;
        string title, description, glyph;
        var action = false;
        if (live.ActiveProject is null)
        {
            (glyph, title, description) = ("", "Create a project", "A project holds your slides, documents and prepared answers for a talk. Cue answers from them.");
            action = true;
        }
        else if (live.ActiveProject.MaterialCount == 0)
        {
            (glyph, title, description) = ("", "Add your materials", "Drop your slides, documents and prepared answers onto the project in the dashboard. Cue reads them and answers from them.");
            action = true;
        }
        else
        {
            (glyph, title, description) = ("", "Listening",
                state.Preferences.AutoAnswer
                    ? "When someone asks a question, what to say appears here.\nWin+Alt+Enter answers the last thing said."
                    : "When someone asks a question, it appears here for Prepare Answer.\nWin+Alt+Enter answers the last thing said.");
        }
        var panel = new StackPanel { Spacing = 8, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(24, 60, 24, 60) };
        panel.Children.Add(new FontIcon { Glyph = glyph, FontSize = 32, Foreground = Theme("TextFillColorSecondaryBrush"), HorizontalAlignment = HorizontalAlignment.Center });
        panel.Children.Add(new TextBlock { Text = title, FontSize = size + 3, FontWeight = FontWeights.SemiBold, HorizontalAlignment = HorizontalAlignment.Center });
        panel.Children.Add(new TextBlock { Text = description, FontSize = Math.Max(size - 2, 11), Foreground = Theme("TextFillColorSecondaryBrush"), TextWrapping = TextWrapping.Wrap, TextAlignment = TextAlignment.Center });
        if (action)
        {
            var open = new Button { Content = "Open Dashboard", HorizontalAlignment = HorizontalAlignment.Center, Style = (Style)Application.Current.Resources["AccentButtonStyle"] };
            open.Click += (_, _) => state.OpenDashboard();
            panel.Children.Add(open);
        }
        return panel;
    }

    /// <summary>A question and its marker: its number when several were asked in one go, else who's asking.</summary>
    private static UIElement QuestionLine(string question, int? number, double size, int lines)
    {
        var grid = new Grid { ColumnSpacing = 8 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(size + 4) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        UIElement marker = number is { } n
            ? new TextBlock { Text = n.ToString(), FontSize = size - 1, FontWeight = FontWeights.SemiBold, Foreground = Theme("TextFillColorSecondaryBrush"), HorizontalAlignment = HorizontalAlignment.Center }
            : new FontIcon { Glyph = "", FontSize = size - 1, Foreground = Theme("TextFillColorSecondaryBrush") };
        ((FrameworkElement)marker).VerticalAlignment = VerticalAlignment.Top;
        ((FrameworkElement)marker).Margin = new Thickness(0, 2, 0, 0);
        grid.Children.Add(marker);
        var text = new TextBlock
        {
            Text = question,
            FontSize = size,
            FontWeight = FontWeights.SemiBold,
            TextWrapping = TextWrapping.Wrap,
            MaxLines = lines,
            TextTrimming = TextTrimming.CharacterEllipsis,
        };
        Grid.SetColumn(text, 1);
        grid.Children.Add(text);
        return grid;
    }

    private static Button Accent(string text, Action click)
    {
        var button = new Button { Content = text, CornerRadius = new CornerRadius(16), Style = (Style)Application.Current.Resources["AccentButtonStyle"] };
        button.Click += (_, _) => click();
        return button;
    }

    /// <summary>An exchange in compact form: each question, then what to say, that the answer is coming, or that it isn't a question for the speaker (dimmed).
    /// Questions noticed with Auto off get Prepare Answer.</summary>
    private UIElement ExchangeRow(Exchange exchange, double size)
    {
        var questionSize = Math.Max(size - 2, 12);
        var inner = new StackPanel { Spacing = 6 };
        for (var index = 0; index < exchange.Answers.Count; index++)
        {
            var answer = exchange.Answers[index];
            var part = new StackPanel { Spacing = 2, Opacity = answer.IsNotAQuestion ? 0.5 : 1 };
            part.Children.Add(QuestionLine(answer.Question, exchange.Answers.Count > 1 ? index + 1 : null, questionSize, 2));
            var status = RowStatus(answer, size, questionSize);
            if (status is not null)
            {
                ((FrameworkElement)status).Margin = new Thickness(questionSize + 12, 0, 0, 0);
                part.Children.Add(status);
            }
            inner.Children.Add(part);
        }
        var open = new Button { Content = inner, HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Left };
        Subtle(open);
        open.Padding = new Thickness(12, 8, 12, 8);
        open.Click += (_, _) => state.Live.Expand(exchange.Id);
        ToolTipService.SetToolTip(open, "Show in full");
        var row = new StackPanel { Spacing = 0 };
        row.Children.Add(open);
        if (exchange.Waiting)
        {
            var prepare = Accent("Prepare Answer", () => state.Live.Prepare(exchange.Id));
            prepare.Margin = new Thickness(questionSize + 24, 0, 12, 8);
            ToolTipService.SetToolTip(prepare, "Ask Claude what to say");
            row.Children.Add(prepare);
        }
        return row;
    }

    private static UIElement? RowStatus(Answer answer, double size, double questionSize)
    {
        var small = Math.Max(size - 3, 11);
        if (!answer.Requested) return null;
        if (answer.Error is { } error)
            return new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, Children = { Glyph("", small, Theme("SystemFillColorCautionBrush")), new TextBlock { Text = error, FontSize = small, Foreground = Theme("SystemFillColorCautionBrush"), MaxLines = 1, TextTrimming = TextTrimming.CharacterEllipsis } } };
        if (answer.IsNotAQuestion) return new TextBlock { Text = "Not a question for you", FontSize = small, Foreground = Theme("TextFillColorTertiaryBrush") };
        if (answer.FirstLine is { } line)
            return new TextBlock { Text = line, FontSize = questionSize, Foreground = Theme("TextFillColorSecondaryBrush"), TextWrapping = TextWrapping.Wrap, MaxLines = 2, TextTrimming = TextTrimming.CharacterEllipsis };
        return new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Spacing = 6,
            Children =
            {
                new ProgressRing { Width = 12, Height = 12, IsActive = true },
                new TextBlock { Text = answer.Opener ?? "Thinking…", FontSize = small, Foreground = Theme("TextFillColorSecondaryBrush"), MaxLines = 1, TextTrimming = TextTrimming.CharacterEllipsis },
            },
        };
    }

    /// <summary>An exchange in full: each question with its answer, numbered when several were asked in one go.</summary>
    private UIElement ExchangeCard(Exchange exchange, double size)
    {
        var card = new StackPanel { Spacing = 16 };
        var lexicon = Lexicon.Load(state.Live.ActiveProject?.Language);
        for (var index = 0; index < exchange.Answers.Count; index++)
        {
            if (index > 0) card.Children.Add(new Border { Height = 1, Background = Theme("DividerStrokeColorDefaultBrush") });
            card.Children.Add(AnswerContent(exchange.Answers[index], exchange.Answers.Count > 1 ? index + 1 : null, size, lexicon));
        }
        if (exchange.Waiting)
        {
            var prepare = Accent("Prepare Answer", () => state.Live.Prepare(exchange.Id));
            prepare.HorizontalAlignment = HorizontalAlignment.Left;
            ToolTipService.SetToolTip(prepare, "Ask Claude what to say");
            card.Children.Add(prepare);
        }
        return new Border
        {
            Child = card,
            Padding = new Thickness(16),
            CornerRadius = new CornerRadius(16),
            Background = Theme("CardBackgroundFillColorSecondaryBrush"),
        };
    }

    private UIElement AnswerContent(Answer answer, int? number, double size, Lexicon lexicon)
    {
        var panel = new StackPanel { Spacing = 14 };
        panel.Children.Add(QuestionLine(answer.Question, number, size, 6));
        if (!answer.Requested)
        {
        }
        else if (answer.IsNotAQuestion)
        {
            panel.Children.Add(new TextBlock { Text = "Doesn't sound like a question for you.", FontSize = size, Foreground = Theme("TextFillColorSecondaryBrush"), TextWrapping = TextWrapping.Wrap });
            var anyway = new Button { Content = "Answer Anyway" };
            anyway.Click += (_, _) => state.Live.Ask(answer.Question);
            panel.Children.Add(anyway);
        }
        else
        {
            panel.Children.Add(SayNow(answer, size));
            var rest = answer.Rest;
            if (rest.Count > 0)
            {
                var lines = new StackPanel { Spacing = 8 };
                foreach (var line in rest) lines.Children.Add(AnswerLine(line, size, lexicon));
                panel.Children.Add(lines);
            }
            if (!answer.Done && answer.FirstLine is not null && rest.Count == 0) panel.Children.Add(new ProgressRing { Width = 16, Height = 16, IsActive = true, HorizontalAlignment = HorizontalAlignment.Left });
            if (answer.Error is { } error)
                panel.Children.Add(new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, Children = { Glyph("", size - 2, Theme("SystemFillColorCautionBrush")), new TextBlock { Text = error, FontSize = size - 2, Foreground = Theme("SystemFillColorCautionBrush"), TextWrapping = TextWrapping.Wrap } } });
        }
        if (answer.Prepared is { } prepared) panel.Children.Add(PreparedView(answer, prepared, size));
        return panel;
    }

    /// <summary>The line to say first: the instant opener, replaced by Claude's first line when it lands.</summary>
    private static UIElement SayNow(Answer answer, double size)
    {
        var panel = new StackPanel { Spacing = 6 };
        panel.Children.Add(new TextBlock { Text = "SAY", FontSize = Math.Max(size - 4, 10), FontWeight = FontWeights.SemiBold, Foreground = Theme("AccentTextFillColorPrimaryBrush") });
        if (answer.SayNow is { } line)
        {
            panel.Children.Add(new TextBlock { Text = line, FontSize = size * 1.4, FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap });
        }
        else
        {
            panel.Children.Add(new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Spacing = 8,
                Children = { new ProgressRing { Width = 16, Height = 16, IsActive = true }, new TextBlock { Text = "Thinking…", FontSize = size, Foreground = Theme("TextFillColorSecondaryBrush") } },
            });
        }
        return panel;
    }

    /// <summary>Points with hanging bullets; the numbers and source lines set as secondary detail.</summary>
    private static UIElement AnswerLine(string line, double size, Lexicon lexicon)
    {
        if (line.StartsWith('•') || line.StartsWith("- ", StringComparison.Ordinal))
            return DetailRow(null, size, line.TrimStart('•', '-', ' '), size, false);
        if (Strip(line, lexicon.NumbersLabel) is { } numbers) return DetailRow("", size, numbers, size - 1, true);
        if (Strip(line, lexicon.SourceLabel) is { } source) return DetailRow("", size, source, size - 3, true);
        return DetailRow(null, size, line, size, false);
    }

    private static string? Strip(string line, string label) =>
        line.StartsWith(label + ":", StringComparison.CurrentCultureIgnoreCase) ? line[(label.Length + 1)..].Trim() : null;

    /// <summary>A row whose marker (bullet or symbol) sits in a fixed leading column, so wrapped lines hang and every row's text starts at the same x.</summary>
    private static UIElement DetailRow(string? symbol, double markerWidth, string text, double textSize, bool secondary)
    {
        var grid = new Grid { ColumnSpacing = 8 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(markerWidth) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        FrameworkElement marker = symbol is not null
            ? new FontIcon { Glyph = symbol, FontSize = 11, Foreground = Theme("TextFillColorTertiaryBrush") }
            : new TextBlock { Text = "•", FontSize = textSize, Foreground = Theme("TextFillColorTertiaryBrush"), HorizontalAlignment = HorizontalAlignment.Center };
        marker.VerticalAlignment = VerticalAlignment.Top;
        marker.Margin = new Thickness(0, symbol is not null ? 4 : 0, 0, 0);
        grid.Children.Add(marker);
        var content = new TextBlock { Text = text, FontSize = textSize, TextWrapping = TextWrapping.Wrap, Foreground = secondary ? Theme("TextFillColorSecondaryBrush") : Theme("TextFillColorPrimaryBrush") };
        Grid.SetColumn(content, 1);
        grid.Children.Add(content);
        return grid;
    }

    private UIElement PreparedView(Answer answer, PreparedAnswer prepared, double size)
    {
        var open = preparedOpen.Contains(answer.Id);
        var panel = new StackPanel { Spacing = 4 };
        var header = new Button
        {
            Content = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Spacing = 6,
                Children =
                {
                    Glyph(open ? "" : "", 10, Theme("TextFillColorSecondaryBrush")),
                    Glyph("", size - 3, Theme("TextFillColorSecondaryBrush")),
                    new TextBlock { Text = $"Prepared answer{(prepared.Who is { } who ? $" · {who}" : "")}", FontSize = size - 3, FontWeight = FontWeights.Medium, Foreground = Theme("TextFillColorSecondaryBrush") },
                },
            },
        };
        Subtle(header);
        header.Padding = new Thickness(0, 2, 6, 2);
        header.Click += (_, _) =>
        {
            if (!preparedOpen.Remove(answer.Id)) preparedOpen.Add(answer.Id);
            dirty = true;
        };
        ToolTipService.SetToolTip(header, $"{(int)(answer.PreparedScore * 100)}% match · {prepared.Source}");
        panel.Children.Add(header);
        if (open) panel.Children.Add(new TextBlock { Text = prepared.A, FontSize = size - 2, Foreground = Theme("TextFillColorSecondaryBrush"), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 4, 0, 0) });
        return panel;
    }

    // MARK: Transcript

    private void RenderTranscript(double size)
    {
        if (!state.Preferences.ShowTranscript) return;
        var live = state.Live;
        transcriptLines.Children.Clear();
        var small = Math.Max(size - 3, 11);
        foreach (var line in live.Utterances.TakeLast(30)) transcriptLines.Children.Add(TranscriptLine(line.Side, line.Text, small, 1, click: line.Text));
        foreach (var side in new[] { Side.Others, Side.Me })
            if (live.Partial.TryGetValue(side, out var partial) && partial.Length > 0) transcriptLines.Children.Add(TranscriptLine(side, partial, small, 0.5));
        transcriptScroll.UpdateLayout();
        transcriptScroll.ChangeView(null, transcriptScroll.ScrollableHeight, null, true);
    }

    private TextBlock TranscriptLine(Side side, string text, double size, double opacity, string? click = null)
    {
        var block = new TextBlock { FontSize = size, TextWrapping = TextWrapping.Wrap, Opacity = opacity, Foreground = Theme("TextFillColorSecondaryBrush") };
        block.Inlines.Add(new Microsoft.UI.Xaml.Documents.Run
        {
            Text = side.Label(),
            FontWeight = FontWeights.SemiBold,
            Foreground = side == Side.Others ? Theme("AccentTextFillColorPrimaryBrush") : Theme("TextFillColorSecondaryBrush"),
        });
        block.Inlines.Add(new Microsoft.UI.Xaml.Documents.Run { Text = "  " + text });
        if (click is not null)
        {
            block.Tapped += (_, _) => state.Live.Ask(click);
            ToolTipService.SetToolTip(block, "Click to get an answer for this");
        }
        return block;
    }
}

/// <summary>
/// Desktop acrylic that stays acrylic though the window is never the active one: the stock backdrop falls back to a flat colour when its window is inactive,
/// and the overlay never is (it must not take the focus).
/// </summary>
internal sealed class ActiveAcrylicBackdrop : SystemBackdrop
{
    private DesktopAcrylicController? controller;

    protected override void OnTargetConnected(ICompositionSupportsSystemBackdrop connectedTarget, XamlRoot xamlRoot)
    {
        base.OnTargetConnected(connectedTarget, xamlRoot);
        controller = new DesktopAcrylicController { Kind = DesktopAcrylicKind.Thin };
        controller.AddSystemBackdropTarget(connectedTarget);
        Apply(connectedTarget, xamlRoot);
    }

    protected override void OnDefaultSystemBackdropConfigurationChanged(ICompositionSupportsSystemBackdrop target, XamlRoot xamlRoot) => Apply(target, xamlRoot);

    private void Apply(ICompositionSupportsSystemBackdrop target, XamlRoot xamlRoot)
    {
        var configuration = GetDefaultSystemBackdropConfiguration(target, xamlRoot);
        configuration.IsInputActive = true;
        controller?.SetSystemBackdropConfiguration(configuration);
    }

    protected override void OnTargetDisconnected(ICompositionSupportsSystemBackdrop disconnectedTarget)
    {
        base.OnTargetDisconnected(disconnectedTarget);
        controller?.RemoveSystemBackdropTarget(disconnectedTarget);
        controller?.Dispose();
        controller = null;
    }
}
