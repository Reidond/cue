using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.Graphics;
using WinRT.Interop;

namespace Cue;

/// <summary>The dashboard: Home, Upcoming and Settings in a navigation pane (the projects join it in a later slice), Mica behind, light or dark by the system.</summary>
public sealed partial class MainWindow : Window
{
    private readonly AppState state;
    private bool syncing;

    public MainWindow(AppState state)
    {
        this.state = state;
        InitializeComponent();
        Title = "Cue";
        ExtendsContentIntoTitleBar = true;
        SetTitleBar(AppTitleBar);
        SystemBackdrop = new MicaBackdrop();
        AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "AppIcon.ico"));
        // Under CUE_BACKGROUND the window never takes the focus or a taskbar button: set before it is shown.
        if (Env.Background) Native.KeepBehind(Handle);
        Resize(1060, 700, centre: true);

        state.OpenDashboard = Present;
        state.ShowAlert = ShowAlert;
        state.Dashboard.PropertyChanged += (_, _) => Sync();
        state.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName == nameof(AppState.PlanLimit)) UpdateLimit();
        };
        state.Control.Register("size", argument =>
        {
            // The window's edge dragged to make it W × H points.
            var numbers = argument.Split(' ', StringSplitOptions.RemoveEmptyEntries).Select(text => double.TryParse(text, out var n) ? n : double.NaN).ToArray();
            if (numbers.Length == 2 && numbers.All(n => n > 0)) Resize(numbers[0], numbers[1]);
            return Task.CompletedTask;
        }, needsSignIn: false);
        Closed += (_, _) => state.Quit();
        Sync();
        UpdateLimit();
    }

    public IntPtr Handle => WindowNative.GetWindowHandle(this);

    /// <summary>Brings the dashboard forward; under CUE_BACKGROUND it is only shown, behind everything else.</summary>
    public void Present()
    {
        if (Env.Background)
        {
            AppWindow.Show(false);
            Native.SendToBottom(Handle);
        }
        else
        {
            Activate();
        }
    }

    /// <summary>The client area W × H in points (device-independent pixels), cut to the screen as a window asked to be larger is; centred when `centre`.</summary>
    private void Resize(double width, double height, bool centre = false)
    {
        var scale = Math.Max(Native.GetDpiForWindow(Handle), 96u) / 96.0;
        var area = DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Nearest).WorkArea;
        // The title bar is on top of the client area's height.
        AppWindow.ResizeClient(new SizeInt32(
            Math.Min((int)Math.Round(width * scale), area.Width),
            Math.Min((int)Math.Round(height * scale), area.Height - (int)Math.Round(48 * scale))));
        if (centre)
            AppWindow.Move(new PointInt32(area.X + (area.Width - AppWindow.Size.Width) / 2, area.Y + (area.Height - AppWindow.Size.Height) / 2));
    }

    private void OnPaneToggleRequested(TitleBar sender, object args) => Navigation.IsPaneOpen = !Navigation.IsPaneOpen;

    /// <summary>A click on a pane item: where the dashboard is now.</summary>
    private void OnSelectionChanged(NavigationView sender, NavigationViewSelectionChangedEventArgs args)
    {
        if (syncing) return;
        if (args.IsSettingsSelected) state.Dashboard.Page = DashboardPage.Settings;
        else if (args.SelectedItem is NavigationViewItem { Tag: string tag } && Enum.TryParse<DashboardPage>(tag, out var page)) state.Dashboard.Page = page;
    }

    /// <summary>The pane and the page follow the model, which a click, `page` and `settings` all set.</summary>
    private void Sync()
    {
        syncing = true;
        try
        {
            var page = state.Dashboard.Page;
            Navigation.SelectedItem = page switch
            {
                DashboardPage.Home => HomeItem,
                DashboardPage.Upcoming => UpcomingItem,
                _ => Navigation.SettingsItem,
            };
            var type = page switch
            {
                DashboardPage.Home => typeof(HomePage),
                DashboardPage.Upcoming => typeof(UpcomingPage),
                _ => typeof(SettingsPage),
            };
            if (PageFrame.CurrentSourcePageType != type) PageFrame.Navigate(type, state);
        }
        finally
        {
            syncing = false;
        }
    }

    private void UpdateLimit()
    {
        LimitBar.Message = state.PlanLimit ?? "";
        LimitBar.IsOpen = state.PlanLimit is not null;
    }

    private async void ShowAlert(string title, string message)
    {
        var dialog = new ContentDialog
        {
            Title = title,
            Content = message,
            CloseButtonText = "OK",
            XamlRoot = Navigation.XamlRoot,
        };
        try
        {
            await dialog.ShowAsync();
        }
        catch (InvalidOperationException)
        {
            // Another dialog is open: the session log has this one.
        }
    }
}
