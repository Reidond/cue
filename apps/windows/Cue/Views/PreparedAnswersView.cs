using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;

namespace Cue;

/// <summary>
/// The question-and-answer pairs Cue found in a project's materials, so the person can check what it picked up before the talk. Searchable;
/// <see cref="Update"/> hands it what the account has read.
/// </summary>
public sealed class PreparedAnswersView : UserControl
{
    private readonly AutoSuggestBox search = new()
    {
        PlaceholderText = "Search questions and answers",
        QueryIcon = new SymbolIcon(Symbol.Find),
    };

    private readonly StackPanel root = new() { Spacing = 12 };
    private readonly Border results = new();
    private KnowledgeBase? knowledge;
    private bool reading;

    public PreparedAnswersView()
    {
        AutomationProperties.SetName(search, "Search");
        search.TextChanged += (_, _) => Render();
        root.Children.Add(search);
        root.Children.Add(results);
        Content = root;
        Render();
    }

    public void Update(KnowledgeBase? read, bool nowReading)
    {
        knowledge = read;
        reading = nowReading;
        Render();
    }

    private void Render()
    {
        var answers = knowledge?.Prepared ?? [];
        var text = search.Text.Trim();
        IReadOnlyList<PreparedAnswer> shown = text.Length == 0
            ? answers
            : [.. answers.Where(answer => Contains(answer.Q, text) || Contains(answer.A, text) || (answer.Who is { } who && Contains(who, text)))];
        if (answers.Count == 0)
        {
            results.Child = reading ? Reading() : Empty("No Prepared Answers", "Add a document with lines like “Q: …” followed by “A: …”, or questions followed by an “Answer:” line, and they show up here.");
        }
        else if (shown.Count == 0)
        {
            results.Child = Empty($"No Results for “{text}”", "Check the spelling or try a new search.");
        }
        else
        {
            results.Child = Ui.Card([.. shown.Select(Row)]);
        }
    }

    private static bool Contains(string haystack, string needle) => haystack.Contains(needle, StringComparison.CurrentCultureIgnoreCase);

    private static UIElement Row(PreparedAnswer item)
    {
        var caption = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, Margin = new Thickness(0, 2, 0, 0) };
        if (item.Who is not null) caption.Children.Add(Ui.Glyph("", 12, "TextFillColorTertiaryBrush"));
        var source = new TextBlock
        {
            Text = item.Who is { } who ? $"{who} · {item.Source}" : item.Source,
            Style = (Style)Application.Current.Resources["CaptionTextBlockStyle"],
            Foreground = Ui.Theme("TextFillColorTertiaryBrush"),
        };
        caption.Children.Add(source);
        return Ui.Padded(new StackPanel
        {
            Spacing = 4,
            Children =
            {
                new TextBlock { Text = item.Q, FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true },
                new TextBlock { Text = item.A, Foreground = Ui.Theme("TextFillColorSecondaryBrush"), TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true },
                caption,
            },
        });
    }

    private static UIElement Reading() =>
        new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Spacing = 12,
            HorizontalAlignment = HorizontalAlignment.Center,
            Margin = new Thickness(0, 36, 0, 0),
            Children = { new ProgressRing { Width = 20, Height = 20, IsActive = true }, new TextBlock { Text = "Reading materials…", VerticalAlignment = VerticalAlignment.Center } },
        };

    private static UIElement Empty(string title, string description) =>
        new StackPanel
        {
            Spacing = 6,
            HorizontalAlignment = HorizontalAlignment.Center,
            Margin = new Thickness(0, 36, 0, 0),
            MaxWidth = 440,
            Children =
            {
                new FontIcon { Glyph = "", FontSize = 36, Foreground = Ui.Theme("TextFillColorSecondaryBrush"), HorizontalAlignment = HorizontalAlignment.Center },
                new TextBlock { Text = title, Style = (Style)Application.Current.Resources["SubtitleTextBlockStyle"], HorizontalAlignment = HorizontalAlignment.Center, TextAlignment = TextAlignment.Center },
                new TextBlock { Text = description, Foreground = Ui.Theme("TextFillColorSecondaryBrush"), TextWrapping = TextWrapping.Wrap, TextAlignment = TextAlignment.Center },
            },
        };
}
