using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;

namespace Cue;

/// <summary>Upcoming calls from the calendar: a placeholder in the nav until the calendar slice; behind the sign-in like every page but Home and Settings.</summary>
public sealed partial class UpcomingPage : Page
{
    private AppState state = null!;

    public UpcomingPage() => InitializeComponent();

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        state = (AppState)e.Parameter;
        SignInHost.Child = new SignInView(state);
        state.Api.PropertyChanged += OnChanged;
        Render();
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e) => state.Api.PropertyChanged -= OnChanged;

    private void OnChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e) => Render();

    private void Render()
    {
        SignInHost.Visibility = state.Api.IsSignedIn ? Visibility.Collapsed : Visibility.Visible;
        SignedIn.Visibility = state.Api.IsSignedIn ? Visibility.Visible : Visibility.Collapsed;
    }
}
