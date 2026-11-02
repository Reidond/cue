using System.Globalization;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Cue;

/// <summary>Settings › Account: who is signed in, the plan, this month's usage and where it went, and Sign Out.</summary>
public sealed class AccountView : UserControl
{
    private readonly AppState state;
    private readonly StackPanel root = new() { Spacing = 8 };

    public AccountView(AppState state)
    {
        this.state = state;
        Content = root;
        // Drawn at once, so the first look is not an empty control.
        state.Api.PropertyChanged += OnChanged;
        Render();
        Loaded += (_, _) =>
        {
            if (state.Api.IsSignedIn) _ = state.Api.RefreshMe();
        };
        Unloaded += (_, _) => state.Api.PropertyChanged -= OnChanged;
    }

    private void OnChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e) => Render();

    private void Render()
    {
        root.Children.Clear();
        var api = state.Api;
        if (api.Me is { } me && api.IsSignedIn)
        {
            var who = new List<UIElement> { Ui.Row("Signed in as", me.Account.Email) };
            if (me.Account.Name != me.Account.Email) who.Add(Ui.Row("Name", me.Account.Name));
            who.Add(Ui.Row("Plan", me.Plan.Name));
            var signOut = new Button { Content = "Sign Out" };
            signOut.Click += async (_, _) => await api.SignOut();
            who.Add(Ui.Padded(signOut));
            root.Children.Add(Ui.Card([.. who]));
            root.Children.Add(Ui.Caption("Signing out ends this PC's session. Your projects and notes stay as they are."));

            root.Children.Add(Ui.Header("Usage"));
            var limit = me.Limits.MonthlyUsd;
            root.Children.Add(Ui.Card(
                Ui.Padded(UsageBar(me.Usage, limit)),
                Ui.Row("Monthly limit", limit is { } usd ? Money.Format(usd) : "None set"),
                Ui.Row("Starts over", $"{me.Usage.RenewsText} (UTC)"),
                Ui.Row("Audio", $"{(int)(me.Usage.AudioSeconds / 60)} min")));
            root.Children.Add(Ui.Caption(me.Usage.LimitReached
                ? "You've used this month's allowance: Cue won't answer questions or write summaries until the month starts over or your limit is raised. Live transcripts and recordings are still kept."
                : "What the Cue plan spent on your calls this month, counted in US dollars from the models and speech recognition it used."));

            if (me.Usage.ByFeature.Count > 0)
            {
                root.Children.Add(Ui.Header("Where it went"));
                root.Children.Add(Ui.Card([.. me.Usage.ByFeature.Select(item => (UIElement)Ui.Row(NameOf(item.Feature), Money.Format(item.Usd)))]));
            }

        }
        else
        {
            var signIn = new Button { Content = "Sign In", IsEnabled = api.Phase is Phase.SignedOut };
            signIn.Click += async (_, _) => await api.SignIn();
            root.Children.Add(Ui.Card(Ui.Row("Account", "Not signed in"), Ui.Padded(signIn)));
            if (api.Problem is { } problem) root.Children.Add(Ui.Caption(problem, caution: true));
        }
    }

    /// <summary>This month's spend against the limit: a bar that turns orange near it and red at it, with the amounts.</summary>
    private static UIElement UsageBar(CueMe.UsageInfo usage, double? limit)
    {
        if (limit is not { } max || max <= 0) return Ui.Row("Used this month", Money.Format(usage.Usd));
        var bar = new ProgressBar { Minimum = 0, Maximum = max, Value = Math.Min(usage.Usd, max), ShowError = usage.LimitReached, ShowPaused = !usage.LimitReached && usage.Usd / max > 0.8 };
        var heading = new Grid();
        heading.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        heading.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        heading.Children.Add(new TextBlock { Text = "Used this month" });
        var amounts = new TextBlock { Text = $"{Money.Format(usage.Usd)} of {Money.Format(max)}" };
        Grid.SetColumn(amounts, 1);
        heading.Children.Add(amounts);
        return new StackPanel { Spacing = 8, Children = { heading, bar } };
    }

    /// <summary>What a usage feature is called for people.</summary>
    private static string NameOf(string feature) =>
        feature switch
        {
            "answer" => "Answers",
            "question_judge" => "Spotting questions",
            "live_transcript" => "Live transcript",
            "note_transcript" => "Transcript clean-up",
            "note_names" => "Suggested names",
            "notes_summary" => "Summaries",
            "material_text" => "Reading files",
            _ => feature,
        };
}
