using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;

namespace Cue;

/// <summary>The dashboard's first page: the sign-in screen until someone is signed in, then where the person's projects and notes will show.</summary>
public sealed partial class HomePage : Page
{
    private AppState state = null!;

    public HomePage() => InitializeComponent();

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        state = (AppState)e.Parameter;
        SignInHost.Child = new SignInView(state);
        LiveHost.Child = new LiveView(state);
        state.Api.PropertyChanged += OnChanged;
        Render();
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e) => state.Api.PropertyChanged -= OnChanged;

    private void OnChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e) => Render();

    private void Render()
    {
        var signedIn = state.Api.IsSignedIn;
        SignInHost.Visibility = signedIn ? Visibility.Collapsed : Visibility.Visible;
        SignedIn.Visibility = signedIn ? Visibility.Visible : Visibility.Collapsed;
        WhoText.Text = state.Api.Me is { } me ? $"Signed in as {me.Account.Email}." : "";
    }
}
