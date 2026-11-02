using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;

namespace Cue;

/// <summary>The dashboard's first page: the sign-in screen until someone is signed in, then a way in for someone who has no project yet.</summary>
public sealed partial class HomePage : Page
{
    private AppState state = null!;

    public HomePage() => InitializeComponent();

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        state = (AppState)e.Parameter;
        SignInHost.Child = new SignInView(state);
        state.Api.PropertyChanged += OnChanged;
        state.Projects.PropertyChanged += OnChanged;
        Render();
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        state.Api.PropertyChanged -= OnChanged;
        state.Projects.PropertyChanged -= OnChanged;
    }

    private void OnChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e) => Render();

    private void OnNewProject(object sender, RoutedEventArgs e) => _ = ProjectDialogs.NewProject(state, XamlRoot);

    private void Render()
    {
        var signedIn = state.Api.IsSignedIn;
        SignInHost.Visibility = signedIn ? Visibility.Collapsed : Visibility.Visible;
        SignedIn.Visibility = signedIn ? Visibility.Visible : Visibility.Collapsed;
        WhoText.Text = state.Api.Me is { } me ? $"Signed in as {me.Account.Email}." : "";
        var none = state.Projects.Projects.Count == 0;
        FirstProject.Visibility = none ? Visibility.Visible : Visibility.Collapsed;
        Placeholder.Visibility = none ? Visibility.Collapsed : Visibility.Visible;
    }
}
