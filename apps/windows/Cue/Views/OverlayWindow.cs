using Microsoft.UI;
using Microsoft.UI.Composition;
using Microsoft.UI.Composition.SystemBackdrops;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Text;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.Graphics;
using WinRT.Interop;

namespace Cue;

/// <summary>
/// The floating prompter, designed as a Windows 11 app and not as the Mac's glass panels: its own window, above every other (a PowerPoint slide show too) and
/// never taking the focus; hidden from screen sharing and screenshots (CUE_ALLOW_CAPTURE shows it); Fluent acrylic behind standard WinUI controls: a
/// <see cref="CommandBar"/> with the project's drop-down, the status and the switches, an <see cref="InfoBar"/> for what needs attention (the plan's limit,
/// no materials), cards on the Fluent type ramp for the answer in view and the questions waiting or answered, an <see cref="Expander"/> for the prepared
/// answer, a <see cref="TextBox"/> for Ask. Colours are theme resources (so the system accent, light, dark and high contrast), corners the system's
/// (<c>ControlCornerRadius</c>, <c>OverlayCornerRadius</c>, and Windows 11's rounded window), icons Segoe Fluent Icons. Typing into Ask is the one time it
/// takes the keyboard focus, and it gives it back to the window it took it from.
/// </summary>
public sealed class OverlayWindow : Window
{
    private readonly AppState state;
    private readonly SolidColorBrush clear = new(Colors.Transparent);
    private readonly DispatcherQueueTimer renderTimer;
    private bool dirty = true;

    // The bar.
    private FontIcon micIcon = new();
    private FontIcon callIcon = new();
    private TextBlock projectName = new();
    private ContentControl statusMark = new();
    private TextBlock statusText = new();
    private AppBarToggleButton autoToggle = new();
    private AppBarToggleButton transcriptToggle = new();
    private AppBarElementContainer? recordHost;
    private ProgressRing? workingRing;

    // What needs attention, the lists, the transcript.
    private InfoBar attention = new();
    private readonly StackPanel list = new() { Spacing = 8 };
    private ScrollViewer listScroll = new();
    private Button newQuestions = new();
    private Border transcriptCard = new();
    private Border barCard = new();
    private readonly StackPanel transcriptLines = new() { Spacing = 4 };
    private ScrollViewer transcriptScroll = new();
    private readonly HashSet<Guid> preparedOpen = [];
    private Guid? lastExpanded;

    // Ask.
    private TextBox askBox = new();
    private IntPtr before;
    private bool typing;

    private readonly IntPtr handle;

    // Kept in a field: what only a local variable holds is collected, and its events stop.
    private readonly Windows.UI.ViewManagement.UISettings uiSettings = new();
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
        // The theme or high contrast changed under it: its brushes are looked up again.
        if (Content is FrameworkElement root) root.ActualThemeChanged += (_, _) => Rethemed();
        // (Windows tells a change of colours: the theme, the accent, high contrast, on a thread of its own.)
        uiSettings.ColorValuesChanged += (_, _) => state.Queue.TryEnqueue(Rethemed);
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
        // Windows 11's rounded window, as every window of the system has (a borderless one gets none by itself).
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
        var width = (int)Math.Round(540 * scale);
        var height = (int)Math.Round(640 * scale);
        var remembered = Storage.IsSandboxed ? null : state.Preferences.OverlayBounds?.Split(',').Select(text => int.TryParse(text, out var n) ? n : int.MinValue).ToArray();
        if (remembered is { Length: 4 } r && r.All(n => n != int.MinValue) && DisplayArea.GetFromRect(new RectInt32(r[0], r[1], r[2], r[3]), DisplayAreaFallback.None) is not null)
        {
            AppWindow.MoveAndResize(new RectInt32(r[0], r[1], r[2], r[3]));
            return;
        }
        var area = DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Primary).WorkArea;
        var margin = (int)Math.Round(16 * scale);
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

    /// <summary>
    /// The system's theme (light, dark, high contrast) or accent changed: the brushes taken from its resources are taken again. The controls restyle
    /// themselves; what is drawn from the lists is drawn again, and the few plates built once get their brushes here.
    /// </summary>
    private void Rethemed()
    {
        try
        {
            foreach (var card in new[] { barCard, transcriptCard })
            {
                card.Background = Theme("CardBackgroundFillColorDefaultBrush");
                card.BorderBrush = Theme("CardStrokeColorDefaultBrush");
            }
            Calm(autoToggle);
            Calm(transcriptToggle);
            dirty = true;
            UpdateBar();
            Render();
        }
        catch (Exception e)
        {
            // Raised from a dispatcher callback, an exception would end the program: the overlay keeps what it had.
            state.Log.Write($"{SessionLog.Warning} Couldn't redraw the overlay in the new colours: {e.Message}");
        }
    }

    // MARK: Building

    private static Brush Theme(string key) => (Brush)Application.Current.Resources[key];

    private static Style Ramp(string key) => (Style)Application.Current.Resources[key];

    /// <summary>The system's corners: 4 px for a control, 8 px for a card or a flyout.</summary>
    private static CornerRadius ControlRadius => (CornerRadius)Application.Current.Resources["ControlCornerRadius"];

    private static CornerRadius OverlayRadius => (CornerRadius)Application.Current.Resources["OverlayCornerRadius"];

    private static FontIcon Glyph(string glyph, double size = 16, Brush? foreground = null) =>
        new() { Glyph = glyph, FontSize = size, Foreground = foreground ?? Theme("TextFillColorPrimaryBrush") };

    /// <summary>A line of text on the Fluent type ramp (Body, BodyStrong, Subtitle, Title, Caption), at the size the person set.</summary>
    private static TextBlock Text(string text, string style, double size, Brush? foreground = null, int maxLines = 0)
    {
        var block = new TextBlock { Text = text, Style = Ramp(style), FontSize = size, TextWrapping = TextWrapping.Wrap };
        if (foreground is not null) block.Foreground = foreground;
        if (maxLines > 0)
        {
            block.MaxLines = maxLines;
            block.TextTrimming = TextTrimming.CharacterEllipsis;
        }
        return block;
    }

    /// <summary>A card of the system's: its fill and stroke, its corners.</summary>
    private static Border Card(UIElement child, Thickness? padding = null) =>
        new()
        {
            Child = child,
            CornerRadius = OverlayRadius,
            Background = Theme("CardBackgroundFillColorDefaultBrush"),
            BorderBrush = Theme("CardStrokeColorDefaultBrush"),
            BorderThickness = new Thickness(1),
            Padding = padding ?? new Thickness(16),
        };

    /// <summary>A button without a plate of its own (a row of a list): only the hover, the press and the focus show, as in the system's lists.</summary>
    private void Subtle(Button button)
    {
        button.Background = clear;
        button.BorderThickness = new Thickness(0);
        button.CornerRadius = ControlRadius;
        button.Resources["ButtonBackground"] = clear;
        button.Resources["ButtonBackgroundPointerOver"] = Theme("SubtleFillColorSecondaryBrush");
        button.Resources["ButtonBackgroundPressed"] = Theme("SubtleFillColorTertiaryBrush");
        button.Resources["ButtonBorderBrush"] = clear;
        button.Resources["ButtonBorderBrushPointerOver"] = clear;
        button.Resources["ButtonBorderBrushPressed"] = clear;
    }

    /// <summary>A switch of the command bar that, when on, shows in the accent colour (its icon and text) on a subtle plate, not a solid accent one: what the system's own bars do for a view that is on.</summary>
    private void Calm(AppBarToggleButton button)
    {
        button.Resources["AppBarToggleButtonBackgroundChecked"] = Theme("SubtleFillColorSecondaryBrush");
        button.Resources["AppBarToggleButtonBackgroundCheckedPointerOver"] = Theme("SubtleFillColorTertiaryBrush");
        button.Resources["AppBarToggleButtonBackgroundCheckedPressed"] = Theme("SubtleFillColorSecondaryBrush");
        button.Resources["AppBarToggleButtonForegroundChecked"] = Theme("AccentTextFillColorPrimaryBrush");
        button.Resources["AppBarToggleButtonForegroundCheckedPointerOver"] = Theme("AccentTextFillColorSecondaryBrush");
        button.Resources["AppBarToggleButtonForegroundCheckedPressed"] = Theme("AccentTextFillColorTertiaryBrush");
    }

    private static Button Accent(string text, Action click)
    {
        var button = new Button { Content = text, Style = Ramp("AccentButtonStyle") };
        button.Click += (_, _) => click();
        return button;
    }

    private UIElement Build()
    {
        var root = new Grid { Padding = new Thickness(8), RowSpacing = 8 };
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        var bar = BuildBar();
        Grid.SetRow(bar, 0);
        root.Children.Add(bar);

        // What needs attention (the plan's limit, a missing project or material): the system's InfoBar, with its way out.
        var open = new Button { Content = "Open Dashboard" };
        open.Click += (_, _) => state.OpenDashboard();
        attention = new InfoBar { IsOpen = false, IsClosable = false, Severity = InfoBarSeverity.Warning, ActionButton = open, CornerRadius = OverlayRadius };
        Grid.SetRow(attention, 1);
        root.Children.Add(attention);

        listScroll = new ScrollViewer { Content = list, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, VerticalScrollMode = ScrollMode.Auto };
        listScroll.ViewChanged += (_, _) => state.Live.ListScrolled = listScroll.VerticalOffset > 24;
        newQuestions = new Button
        {
            Style = Ramp("AccentButtonStyle"),
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Top,
            Margin = new Thickness(0, 8, 0, 0),
            Visibility = Visibility.Collapsed,
            // Floats over the list: the system's shadow lifts it off the cards.
            Shadow = new ThemeShadow(),
            Translation = new System.Numerics.Vector3(0, 0, 16),
        };
        newQuestions.Click += (_, _) =>
        {
            state.Live.ShowNewest();
            listScroll.ChangeView(null, 0, null, true);
        };
        ToolTipService.SetToolTip(newQuestions, "Show the newest question");
        var listHost = new Grid { Children = { listScroll, newQuestions } };
        Grid.SetRow(listHost, 2);
        root.Children.Add(listHost);

        transcriptScroll = new ScrollViewer { Content = transcriptLines, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        transcriptCard = Card(transcriptScroll, new Thickness(12, 8, 12, 8));
        transcriptCard.Height = 104;
        Grid.SetRow(transcriptCard, 3);
        root.Children.Add(transcriptCard);

        var ask = BuildAsk();
        Grid.SetRow(ask, 4);
        root.Children.Add(ask);
        return root;
    }

    private FrameworkElement BuildBar()
    {
        micIcon = Glyph("");
        callIcon = Glyph("");
        micIcon.VerticalAlignment = callIcon.VerticalAlignment = VerticalAlignment.Center;

        projectName = new TextBlock { Style = Ramp("BodyStrongTextBlockStyle"), VerticalAlignment = VerticalAlignment.Center };
        var project = new DropDownButton { Content = projectName, Flyout = ProjectMenu(), VerticalAlignment = VerticalAlignment.Center };
        project.Resources["ButtonBackground"] = clear;
        project.Resources["ButtonBorderBrush"] = clear;
        ToolTipService.SetToolTip(project, "Project — switch it, or open the dashboard");
        AutomationProperties.SetName(project, "Project");

        statusMark = new ContentControl { VerticalAlignment = VerticalAlignment.Center };
        statusText = new TextBlock { Style = Ramp("BodyTextBlockStyle"), VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis, MaxLines = 1 };
        var status = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, VerticalAlignment = VerticalAlignment.Center, Children = { statusMark, statusText } };

        var left = new Grid { ColumnSpacing = 12, Margin = new Thickness(12, 0, 0, 0), HorizontalAlignment = HorizontalAlignment.Stretch };
        for (var i = 0; i < 4; i++) left.ColumnDefinitions.Add(new ColumnDefinition { Width = i == 3 ? new GridLength(1, GridUnitType.Star) : GridLength.Auto });
        void Put(FrameworkElement element, int column)
        {
            Grid.SetColumn(element, column);
            left.Children.Add(element);
        }
        Put(micIcon, 0);
        Put(callIcon, 1);
        Put(project, 2);
        Put(status, 3);

        var commands = new CommandBar
        {
            Content = left,
            Background = clear,
            DefaultLabelPosition = CommandBarDefaultLabelPosition.Right,
            IsDynamicOverflowEnabled = false,
            OverflowButtonVisibility = CommandBarOverflowButtonVisibility.Collapsed,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
        };
        // The recordings slice's button and timer go here.
        recordHost = new AppBarElementContainer { Content = RecordSlot };
        commands.PrimaryCommands.Add(recordHost);

        autoToggle = new AppBarToggleButton { Label = "Auto", Icon = new FontIcon { Glyph = "" }, LabelPosition = CommandBarLabelPosition.Default, IsChecked = state.Preferences.AutoAnswer };
        Calm(autoToggle);
        autoToggle.Click += (_, _) => state.Preferences.AutoAnswer = autoToggle.IsChecked == true;
        ToolTipService.SetToolTip(autoToggle, "Answer questions as they're asked; off, they're listed for Prepare Answer (Win+Alt+A)");
        commands.PrimaryCommands.Add(autoToggle);

        transcriptToggle = new AppBarToggleButton { Label = "Transcript", Icon = new FontIcon { Glyph = "" }, LabelPosition = CommandBarLabelPosition.Collapsed, IsChecked = state.Preferences.ShowTranscript };
        Calm(transcriptToggle);
        transcriptToggle.Click += (_, _) => state.Preferences.ShowTranscript = transcriptToggle.IsChecked == true;
        ToolTipService.SetToolTip(transcriptToggle, "Show transcript");
        commands.PrimaryCommands.Add(transcriptToggle);

        var settings = new AppBarButton { Label = "Settings", Icon = new FontIcon { Glyph = "" }, LabelPosition = CommandBarLabelPosition.Collapsed };
        settings.Click += (_, _) =>
        {
            state.Dashboard.ShowSettings();
            state.OpenDashboard();
        };
        ToolTipService.SetToolTip(settings, "Settings");
        commands.PrimaryCommands.Add(settings);

        var bar = barCard = Card(commands, new Thickness(0));
        // The bar is the title area: it moves the window (a click on one of its buttons is theirs).
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
            var dashboard = new MenuFlyoutItem { Text = "Open Dashboard…", Icon = new FontIcon { Glyph = "" } };
            dashboard.Click += (_, _) => state.OpenDashboard();
            menu.Items.Add(dashboard);
            var stop = new MenuFlyoutItem { Text = "Stop Cue", Icon = new FontIcon { Glyph = "" } };
            stop.Click += (_, _) => live.StopCue();
            menu.Items.Add(stop);
        };
        return menu;
    }

    private FrameworkElement BuildAsk()
    {
        askBox = new TextBox { PlaceholderText = "Ask anything", VerticalAlignment = VerticalAlignment.Center };
        AutomationProperties.SetName(askBox, "Ask anything");
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

        var answerNow = new Button
        {
            Style = Ramp("AccentButtonStyle"),
            VerticalAlignment = VerticalAlignment.Stretch,
            Content = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Spacing = 8,
                Children = { new FontIcon { Glyph = "", FontSize = 14 }, new TextBlock { Text = "Answer now" } },
            },
        };
        AutomationProperties.SetName(answerNow, "Answer now");
        answerNow.Click += (_, _) => state.Live.AnswerNow();
        ToolTipService.SetToolTip(answerNow, "Answer the last thing said (Win+Alt+Enter)");

        var row = new Grid { ColumnSpacing = 8 };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.Children.Add(askBox);
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
        micIcon.Opacity = live.Mic.Ok ? 0.4 + 0.6 * Math.Min(Math.Sqrt(live.MicLevel) * 3, 1) : 1;
        callIcon.Opacity = live.Call.Ok ? 0.4 + 0.6 * Math.Min(Math.Sqrt(live.CallLevel) * 3, 1) : 1;
        micIcon.Foreground = live.Mic.Ok ? Theme("TextFillColorPrimaryBrush") : Theme("SystemFillColorCriticalBrush");
        callIcon.Foreground = live.Call.Ok ? Theme("TextFillColorPrimaryBrush") : Theme("SystemFillColorCriticalBrush");
        micIcon.Glyph = live.Mic.Ok ? "" : ""; // the microphone, or the microphone crossed out
        callIcon.Glyph = live.Call.Ok ? "" : ""; // the speaker, or the speaker muted
        ToolTipService.SetToolTip(micIcon, live.Mic.Detail);
        ToolTipService.SetToolTip(callIcon, live.Call.Detail);
        AutomationProperties.SetName(micIcon, $"Microphone: {live.Mic.Detail}");
        AutomationProperties.SetName(callIcon, $"Call audio: {live.Call.Detail}");

        var name = live.ActiveProject?.Name ?? "No Project";
        projectName.Text = name.Length > 22 ? name[..21] + "…" : name;

        var (text, kind) = live.Status;
        statusText.Text = text;
        statusText.Foreground = kind == StatusKind.Ready ? Theme("TextFillColorSecondaryBrush") : Theme("TextFillColorPrimaryBrush");
        switch (kind)
        {
            case StatusKind.Ready:
                if (statusMark.Content is not FontIcon { Glyph: "" }) statusMark.Content = Glyph("", 14, Theme("SystemFillColorSuccessBrush"));
                break;
            case StatusKind.Working:
                workingRing ??= new ProgressRing { Width = 16, Height = 16, IsActive = true };
                if (!ReferenceEquals(statusMark.Content, workingRing)) statusMark.Content = workingRing;
                break;
            default:
                if (statusMark.Content is not FontIcon { Glyph: "" }) statusMark.Content = Glyph("", 14, Theme("SystemFillColorCautionBrush"));
                break;
        }

        // What needs attention says why, in the system's words for it, and offers the dashboard.
        var problem = kind == StatusKind.Problem;
        attention.IsOpen = problem;
        if (problem)
        {
            attention.Severity = state.PlanLimit is not null ? InfoBarSeverity.Warning : InfoBarSeverity.Informational;
            attention.Title = text;
            attention.Message = state.PlanLimit ?? (text == "No audio" ? $"{live.Mic.Detail}. {live.Call.Detail}." : "Open the dashboard to fix this.");
        }

        if (autoToggle.IsChecked != state.Preferences.AutoAnswer) autoToggle.IsChecked = state.Preferences.AutoAnswer;
        if (transcriptToggle.IsChecked != state.Preferences.ShowTranscript) transcriptToggle.IsChecked = state.Preferences.ShowTranscript;
        transcriptCard.Visibility = state.Preferences.ShowTranscript ? Visibility.Visible : Visibility.Collapsed;
        newQuestions.Visibility = live.Unseen.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
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
            Group("Answered", live.AnsweredExchanges, size);
        }
        newQuestions.Content = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Spacing = 8,
            Children = { new FontIcon { Glyph = "", FontSize = 12 }, new TextBlock { Text = live.Unseen.Count == 1 ? "1 New Question" : $"{live.Unseen.Count} New Questions" } },
        };
        // The exchange shown in full is always on top; new ones show at the top unless the view is held or scrolled away.
        if (live.ExpandedId != lastExpanded || (!live.Holding && !live.ListScrolled)) listScroll.ChangeView(null, 0, null, true);
        lastExpanded = live.ExpandedId;
        RenderTranscript(size);
        UpdateBar();
    }

    /// <summary>A part of the list under its name (sentence case, as Windows names a group), when it has any.</summary>
    private void Group(string title, IReadOnlyList<Exchange> exchanges, double size)
    {
        if (exchanges.Count == 0) return;
        var group = new StackPanel { Spacing = 0 };
        group.Children.Add(Text(title, "CaptionTextBlockStyle", Math.Max(size - 3, 11), Theme("TextFillColorSecondaryBrush")));
        ((FrameworkElement)group.Children[0]).Margin = new Thickness(12, 8, 12, 4);
        var rows = new StackPanel { Spacing = 0 };
        foreach (var exchange in exchanges) rows.Children.Add(ExchangeRow(exchange, size));
        group.Children.Add(Card(rows, new Thickness(0, 4, 0, 4)));
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
        var panel = new StackPanel { Spacing = 8, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(24, 64, 24, 64) };
        panel.Children.Add(new FontIcon { Glyph = glyph, FontSize = 32, Foreground = Theme("TextFillColorSecondaryBrush"), HorizontalAlignment = HorizontalAlignment.Center });
        panel.Children.Add(Text(title, "SubtitleTextBlockStyle", size + 5));
        ((TextBlock)panel.Children[^1]).HorizontalAlignment = HorizontalAlignment.Center;
        var detail = Text(description, "BodyTextBlockStyle", Math.Max(size - 1, 12), Theme("TextFillColorSecondaryBrush"));
        detail.TextAlignment = TextAlignment.Center;
        panel.Children.Add(detail);
        if (action)
        {
            var open = Accent("Open Dashboard", state.OpenDashboard);
            open.HorizontalAlignment = HorizontalAlignment.Center;
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
        FrameworkElement marker = number is { } n
            ? new TextBlock { Text = n.ToString(), Style = Ramp("BodyStrongTextBlockStyle"), FontSize = size - 1, Foreground = Theme("TextFillColorSecondaryBrush"), HorizontalAlignment = HorizontalAlignment.Center }
            : new FontIcon { Glyph = "", FontSize = size - 1, Foreground = Theme("TextFillColorSecondaryBrush") };
        marker.VerticalAlignment = VerticalAlignment.Top;
        marker.Margin = new Thickness(0, 2, 0, 0);
        grid.Children.Add(marker);
        var text = Text(question, "BodyStrongTextBlockStyle", size, maxLines: lines);
        Grid.SetColumn(text, 1);
        grid.Children.Add(text);
        return grid;
    }

    /// <summary>An exchange in compact form: each question, then what to say, that the answer is coming, or that it isn't a question for the speaker (dimmed).
    /// Questions noticed with Auto off get Prepare Answer.</summary>
    private UIElement ExchangeRow(Exchange exchange, double size)
    {
        var questionSize = Math.Max(size - 1, 12);
        var inner = new StackPanel { Spacing = 8 };
        for (var index = 0; index < exchange.Answers.Count; index++)
        {
            var answer = exchange.Answers[index];
            var part = new StackPanel { Spacing = 2, Opacity = answer.IsNotAQuestion ? 0.6 : 1 };
            part.Children.Add(QuestionLine(answer.Question, exchange.Answers.Count > 1 ? index + 1 : null, questionSize, 2));
            if (RowStatus(answer, size) is { } status)
            {
                status.Margin = new Thickness(questionSize + 12, 0, 0, 0);
                part.Children.Add(status);
            }
            inner.Children.Add(part);
        }
        var open = new Button { Content = inner, HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Left, Padding = new Thickness(12, 8, 12, 8) };
        Subtle(open);
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

    private static FrameworkElement? RowStatus(Answer answer, double size)
    {
        var small = Math.Max(size - 3, 11);
        if (!answer.Requested) return null;
        if (answer.Error is { } error)
            return new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, Children = { Glyph("", small, Theme("SystemFillColorCautionBrush")), Text(error, "CaptionTextBlockStyle", small, Theme("SystemFillColorCautionBrush"), 1) } };
        if (answer.IsNotAQuestion) return Text("Not a question for you", "CaptionTextBlockStyle", small, Theme("TextFillColorTertiaryBrush"));
        if (answer.FirstLine is { } line) return Text(line, "BodyTextBlockStyle", Math.Max(size - 1, 12), Theme("TextFillColorSecondaryBrush"), 2);
        return new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Spacing = 8,
            Children = { new ProgressRing { Width = 14, Height = 14, IsActive = true }, Text(answer.Opener ?? "Thinking…", "CaptionTextBlockStyle", small, Theme("TextFillColorSecondaryBrush"), 1) },
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
        return Card(card);
    }

    private UIElement AnswerContent(Answer answer, int? number, double size, Lexicon lexicon)
    {
        var panel = new StackPanel { Spacing = 12 };
        panel.Children.Add(QuestionLine(answer.Question, number, size, 6));
        if (!answer.Requested)
        {
        }
        else if (answer.IsNotAQuestion)
        {
            var anyway = new Button { Content = "Answer Anyway" };
            anyway.Click += (_, _) => state.Live.Ask(answer.Question);
            panel.Children.Add(new InfoBar { Title = "Doesn't sound like a question for you.", IsOpen = true, IsClosable = false, Severity = InfoBarSeverity.Informational, ActionButton = anyway, CornerRadius = ControlRadius });
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
            if (!answer.Done && answer.FirstLine is not null && rest.Count == 0) panel.Children.Add(new ProgressRing { Width = 20, Height = 20, IsActive = true, HorizontalAlignment = HorizontalAlignment.Left });
            if (answer.Error is { } error)
                panel.Children.Add(new InfoBar { Title = "Couldn't answer", Message = error, IsOpen = true, IsClosable = false, Severity = InfoBarSeverity.Warning, CornerRadius = ControlRadius });
        }
        if (answer.Prepared is { } prepared) panel.Children.Add(PreparedView(answer, prepared, size));
        return panel;
    }

    /// <summary>The line to say first: the instant opener, replaced by Claude's first line when it lands.</summary>
    private static UIElement SayNow(Answer answer, double size)
    {
        var panel = new StackPanel { Spacing = 4 };
        panel.Children.Add(Text("Say", "CaptionTextBlockStyle", Math.Max(size - 3, 11), Theme("AccentTextFillColorPrimaryBrush")));
        if (answer.SayNow is { } line)
        {
            panel.Children.Add(Text(line, "TitleTextBlockStyle", size * 1.5));
        }
        else
        {
            panel.Children.Add(new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Spacing = 8,
                Children = { new ProgressRing { Width = 20, Height = 20, IsActive = true }, Text("Thinking…", "BodyTextBlockStyle", size, Theme("TextFillColorSecondaryBrush")) },
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
        if (Strip(line, lexicon.SourceLabel) is { } source) return DetailRow("", size, source, Math.Max(size - 3, 11), true);
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
            ? new FontIcon { Glyph = symbol, FontSize = 12, Foreground = Theme("TextFillColorTertiaryBrush") }
            : new TextBlock { Text = "•", Style = Ramp("BodyTextBlockStyle"), FontSize = textSize, Foreground = Theme("TextFillColorTertiaryBrush"), HorizontalAlignment = HorizontalAlignment.Center };
        marker.VerticalAlignment = VerticalAlignment.Top;
        marker.Margin = new Thickness(0, symbol is not null ? 4 : 0, 0, 0);
        grid.Children.Add(marker);
        var content = Text(text, "BodyTextBlockStyle", textSize, secondary ? Theme("TextFillColorSecondaryBrush") : null);
        Grid.SetColumn(content, 1);
        grid.Children.Add(content);
        return grid;
    }

    /// <summary>The prepared answer that matched, in the system's Expander.</summary>
    private UIElement PreparedView(Answer answer, PreparedAnswer prepared, double size)
    {
        var header = Text($"Prepared answer{(prepared.Who is { } who ? $" · {who}" : "")}", "BodyTextBlockStyle", Math.Max(size - 1, 12));
        var expander = new Expander
        {
            Header = header,
            Content = Text(prepared.A, "BodyTextBlockStyle", Math.Max(size - 1, 12), Theme("TextFillColorSecondaryBrush")),
            IsExpanded = preparedOpen.Contains(answer.Id),
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            CornerRadius = ControlRadius,
        };
        expander.Expanding += (_, _) => preparedOpen.Add(answer.Id);
        expander.Collapsed += (_, _) => preparedOpen.Remove(answer.Id);
        ToolTipService.SetToolTip(expander, $"{(int)(answer.PreparedScore * 100)}% match · {prepared.Source}");
        return expander;
    }

    // MARK: Transcript

    private void RenderTranscript(double size)
    {
        if (!state.Preferences.ShowTranscript) return;
        var live = state.Live;
        transcriptLines.Children.Clear();
        var small = Math.Max(size - 2, 11);
        foreach (var line in live.Utterances.TakeLast(30)) transcriptLines.Children.Add(TranscriptLine(line.Side, line.Text, small, 1, click: line.Text));
        foreach (var side in new[] { Side.Others, Side.Me })
            if (live.Partial.TryGetValue(side, out var partial) && partial.Length > 0) transcriptLines.Children.Add(TranscriptLine(side, partial, small, 0.6));
        transcriptScroll.UpdateLayout();
        transcriptScroll.ChangeView(null, transcriptScroll.ScrollableHeight, null, true);
    }

    private TextBlock TranscriptLine(Side side, string text, double size, double opacity, string? click = null)
    {
        var block = new TextBlock { Style = Ramp("BodyTextBlockStyle"), FontSize = size, TextWrapping = TextWrapping.Wrap, Opacity = opacity, Foreground = Theme("TextFillColorSecondaryBrush") };
        block.Inlines.Add(new Microsoft.UI.Xaml.Documents.Run
        {
            Text = side.Label(),
            FontWeight = FontWeights.SemiBold,
            Foreground = side == Side.Others ? Theme("AccentTextFillColorPrimaryBrush") : Theme("TextFillColorPrimaryBrush"),
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
/// Desktop acrylic (the Fluent material of Windows 11's flyouts) that stays acrylic though the window is never the active one: the stock backdrop falls back
/// to a flat colour when its window is inactive, and the overlay never is (it must not take the focus). With transparency effects turned off in Windows, or
/// in high contrast, the controller itself paints the system's solid fallback.
/// </summary>
internal sealed class ActiveAcrylicBackdrop : SystemBackdrop
{
    private DesktopAcrylicController? controller;

    protected override void OnTargetConnected(ICompositionSupportsSystemBackdrop connectedTarget, XamlRoot xamlRoot)
    {
        base.OnTargetConnected(connectedTarget, xamlRoot);
        controller = new DesktopAcrylicController { Kind = DesktopAcrylicKind.Default };
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
