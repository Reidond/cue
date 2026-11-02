using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Cue;

/// <summary>The sign-in screen: Cue is for invited people, and nothing else works until they are signed in.</summary>
public sealed partial class SignInView : UserControl
{
    private readonly AppState state;

    public SignInView(AppState state)
    {
        this.state = state;
        InitializeComponent();
        // Drawn at once, so the first look is not the default one.
        state.Api.PropertyChanged += OnChanged;
        Render();
        Unloaded += (_, _) => state.Api.PropertyChanged -= OnChanged;
    }

    private void OnChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e) => Render();

    private void Render()
    {
        var api = state.Api;
        ProblemText.Text = api.Problem ?? "";
        ProblemText.Visibility = api.Problem is null ? Visibility.Collapsed : Visibility.Visible;
        var busy = api.Phase is Phase.Restoring or Phase.SigningIn;
        ProgressRow.Visibility = busy ? Visibility.Visible : Visibility.Collapsed;
        ProgressText.Text = api.Phase == Phase.Restoring ? "Signing in…" : "Continue in your browser…";
        SignInButton.Visibility = busy ? Visibility.Collapsed : Visibility.Visible;
        CancelButton.Visibility = api.Phase == Phase.SigningIn ? Visibility.Visible : Visibility.Collapsed;
    }

    private async void OnSignIn(object sender, RoutedEventArgs e) => await state.Api.SignIn();

    private void OnCancel(object sender, RoutedEventArgs e) => state.Api.CancelSignIn();
}
