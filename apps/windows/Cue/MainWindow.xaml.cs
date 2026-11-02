using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.Graphics;
using WinRT.Interop;

namespace Cue;

/// <summary>The dashboard: Home, Upcoming, the projects and Settings in a navigation pane, Mica behind, light or dark by the system.</summary>
public sealed partial class MainWindow : Window
{
    private readonly AppState state;
    private bool syncing;

    /// <summary>The pane's "Projects" header and an item for each project (in the order of the store).</summary>
    private readonly List<NavigationViewItemBase> projectItems = [];

    private string projectsShown = "";

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

        state.WindowHandle = Handle;
        state.OpenDashboard = Present;
        state.ShowAlert = ShowAlert;
        state.Dashboard.PropertyChanged += (_, _) => Sync();
        state.Projects.PropertyChanged += (_, _) => RefreshProjects();
        state.Api.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName == nameof(CueApi.Phase)) RefreshProjects();
        };
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
        // With Cue's icon in the notification area, closing the dashboard only hides it; Quit is in the icon's menu.
        AppWindow.Closing += (sender, args) =>
        {
            if (!LiveSurfaces.HasTray) return;
            args.Cancel = true;
            sender.Hide();
        };
        // Ctrl+Enter: Start Cue, or Stop Cue while it runs.
        if (Content is UIElement content)
        {
            var startCue = new Microsoft.UI.Xaml.Input.KeyboardAccelerator { Key = Windows.System.VirtualKey.Enter, Modifiers = Windows.System.VirtualKeyModifiers.Control };
            startCue.Invoked += (_, e) =>
            {
                state.Live.ToggleCue(state.Projects.Find(state.Dashboard.CurrentProjectId));
                e.Handled = true;
            };
            content.KeyboardAccelerators.Add(startCue);
        }
        Closed += (_, _) => state.Quit();
        RefreshProjects();
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
            AppWindow.Show();
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
        // New Project is an action, not a page: the pane goes back to the page the dashboard is on.
        if (ReferenceEquals(args.SelectedItem, NewProjectItem)) DispatcherQueue.TryEnqueue(Sync);
        else if (args.IsSettingsSelected) state.Dashboard.Page = DashboardPage.Settings;
        else if (args.SelectedItem is NavigationViewItem { Tag: string tag })
        {
            if (tag.StartsWith(ProjectTag, StringComparison.Ordinal)) state.Dashboard.OpenProject(tag[ProjectTag.Length..]);
            else if (Enum.TryParse<DashboardPage>(tag, out var page)) state.Dashboard.Page = page;
        }
    }

    private const string ProjectTag = "project:";

    private void OnItemInvoked(NavigationView sender, NavigationViewItemInvokedEventArgs args)
    {
        if (args.InvokedItemContainer == NewProjectItem) NewProject();
    }

    private void OnNewProjectAccelerator(Microsoft.UI.Xaml.Input.KeyboardAccelerator sender, Microsoft.UI.Xaml.Input.KeyboardAcceleratorInvokedEventArgs args)
    {
        args.Handled = true;
        if (state.Api.IsSignedIn) NewProject();
    }

    private void NewProject() => _ = ProjectDialogs.NewProject(state, Navigation.XamlRoot);

    /// <summary>The pane lists the projects of the person who is signed in: a header, an item for each (with a menu to rename it, find it in Explorer, or throw it out), and New Project below.</summary>
    private void RefreshProjects()
    {
        var signedIn = state.Api.IsSignedIn;
        IReadOnlyList<Project> projects = signedIn ? state.Projects.Projects : [];
        var shown = $"{signedIn}\n{string.Join('\n', projects.Select(project => $"{project.Id}\t{project.Name}"))}";
        if (shown == projectsShown) return;
        projectsShown = shown;
        syncing = true;
        try
        {
            foreach (var item in projectItems) Navigation.MenuItems.Remove(item);
            projectItems.Clear();
            NewProjectItem.Visibility = signedIn ? Visibility.Visible : Visibility.Collapsed;
            if (signedIn)
            {
                projectItems.Add(new NavigationViewItemHeader { Content = "Projects" });
                projectItems.AddRange(projects.Select(ProjectItem));
            }
            foreach (var item in projectItems) Navigation.MenuItems.Add(item);
        }
        finally
        {
            syncing = false;
        }
        Sync();
    }

    private NavigationViewItem ProjectItem(Project project)
    {
        var item = new NavigationViewItem { Content = project.Name, Tag = ProjectTag + project.Id, Icon = new FontIcon { Glyph = "" } };
        // The pane cuts a long name short: the whole of it is in the tooltip.
        ToolTipService.SetToolTip(item, project.Name);
        Project Latest() => state.Projects.Find(project.Id) ?? project;
        var rename = new MenuFlyoutItem { Text = "Rename…", Icon = new FontIcon { Glyph = "" } };
        rename.Click += (_, _) => _ = ProjectDialogs.Rename(state, Latest(), Navigation.XamlRoot);
        var explorer = new MenuFlyoutItem { Text = "Show in Explorer", Icon = new FontIcon { Glyph = "" } };
        explorer.Click += (_, _) => Shell.ShowInExplorer(Latest().Folder);
        var delete = new MenuFlyoutItem { Text = "Move to Recycle Bin…", Icon = new FontIcon { Glyph = "" } };
        delete.Click += (_, _) => _ = ProjectDialogs.Delete(state, Latest(), Navigation.XamlRoot);
        var menu = new MenuFlyout();
        menu.Items.Add(rename);
        menu.Items.Add(explorer);
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(delete);
        item.ContextFlyout = menu;
        return item;
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
                DashboardPage.Project => projectItems.OfType<NavigationViewItem>().FirstOrDefault(item => (string?)item.Tag == ProjectTag + state.Dashboard.ProjectId),
                _ => Navigation.SettingsItem,
            };
            var type = page switch
            {
                DashboardPage.Home => typeof(HomePage),
                DashboardPage.Upcoming => typeof(UpcomingPage),
                DashboardPage.Project => typeof(ProjectPage),
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
