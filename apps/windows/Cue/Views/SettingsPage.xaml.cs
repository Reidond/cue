using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;

namespace Cue;

/// <summary>Settings: a tab per pane (the Mac's Settings window): General, Calendar and Account.</summary>
public sealed partial class SettingsPage : Page
{
    private AppState state = null!;

    public SettingsPage() => InitializeComponent();

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        state = (AppState)e.Parameter;
        state.Dashboard.PropertyChanged += OnChanged;
        ShowTab();
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e) => state.Dashboard.PropertyChanged -= OnChanged;

    private void OnChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(DashboardModel.Tab)) ShowTab();
    }

    private void OnTabChanged(SelectorBar sender, SelectorBarSelectionChangedEventArgs args)
    {
        if (state is null) return;
        state.Dashboard.Tab = sender.SelectedItem == AccountTab ? SettingsTab.Account : sender.SelectedItem == CalendarTab ? SettingsTab.Calendar : SettingsTab.General;
        ShowTab();
    }

    private void ShowTab()
    {
        var tab = state.Dashboard.Tab;
        Tabs.SelectedItem = tab switch
        {
            SettingsTab.Account => AccountTab,
            SettingsTab.Calendar => CalendarTab,
            _ => GeneralTab,
        };
        TabHost.Child = tab switch
        {
            SettingsTab.Account => new AccountView(state),
            SettingsTab.Calendar => new CalendarView(state),
            _ => new GeneralView(state),
        };
    }
}
