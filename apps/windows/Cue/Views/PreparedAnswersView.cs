using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;

namespace Cue;

/// <summary>
/// The prepared answers of a project, so the person can check them before the talk: the ones written in their files, then the ones Cue prepared from
/// the materials for the questions people are likely to ask. Searchable; <see cref="Update"/> hands it what the account has read.
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
    private ProjectBrief brief = ProjectBrief.None;
    private bool hasMaterials;

    public PreparedAnswersView()
    {
        AutomationProperties.SetName(search, "Search");
        search.TextChanged += (_, _) => Render();
        root.Children.Add(search);
        root.Children.Add(results);
        Content = root;
        Render();
    }

    /// <summary>What the account has read (null while it is being read), how Cue's own answers are coming along, and whether there are files at all.</summary>
    public void Update(KnowledgeBase? read, bool nowReading, ProjectBrief projectBrief, bool files)
    {
        knowledge = read;
        reading = nowReading;
        brief = projectBrief;
        hasMaterials = files;
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
            if (reading || brief.Working) results.Child = Preparing();
            else if (brief.Failed) results.Child = Empty("", "Couldn't Prepare Answers", brief.Error ?? "Cue couldn't read your materials.");
            else
            {
                results.Child = Empty(
                    "",
                    "No Prepared Answers",
                    hasMaterials
                        ? "Cue found no questions to prepare for in these files."
                        : "Add your slides, documents or notes on the Overview, and Cue prepares answers to the questions people are likely to ask.");
            }
        }
        else if (shown.Count == 0)
        {
            results.Child = Empty("", $"No Results for “{text}”", "Check the spelling or try a new search.");
        }
        else
        {
            // The ones written in the files first, then Cue's (with a ring while it is still writing them).
            var groups = new StackPanel { Spacing = 8 };
            var own = shown.Where(answer => !answer.ByCue).ToList();
            var prepared = shown.Where(answer => answer.ByCue).ToList();
            if (own.Count > 0)
            {
                groups.Children.Add(Ui.Header("From Your Files"));
                groups.Children.Add(Ui.Card([.. own.Select(Row)]));
            }
            if (prepared.Count > 0 || brief.Working)
            {
                var header = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(0, own.Count > 0 ? 16 : 8, 0, 0) };
                header.Children.Add(new TextBlock { Text = "Prepared by Cue", Style = (Style)Application.Current.Resources["BodyStrongTextBlockStyle"] });
                if (brief.Working)
                {
                    var ring = new ProgressRing { Width = 14, Height = 14, IsActive = true, VerticalAlignment = VerticalAlignment.Center };
                    AutomationProperties.SetName(ring, "Preparing answers…");
                    header.Children.Add(ring);
                }
                groups.Children.Add(header);
                if (prepared.Count > 0) groups.Children.Add(Ui.Card([.. prepared.Select(Row)]));
            }
            results.Child = groups;
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

    private static UIElement Preparing() =>
        new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Spacing = 12,
            HorizontalAlignment = HorizontalAlignment.Center,
            Margin = new Thickness(0, 36, 0, 0),
            Children = { new ProgressRing { Width = 20, Height = 20, IsActive = true }, new TextBlock { Text = "Preparing answers…", VerticalAlignment = VerticalAlignment.Center } },
        };

    private static UIElement Empty(string glyph, string title, string description) =>
        new StackPanel
        {
            Spacing = 6,
            HorizontalAlignment = HorizontalAlignment.Center,
            Margin = new Thickness(0, 36, 0, 0),
            MaxWidth = 440,
            Children =
            {
                new FontIcon { Glyph = glyph, FontSize = 36, Foreground = Ui.Theme("TextFillColorSecondaryBrush"), HorizontalAlignment = HorizontalAlignment.Center },
                new TextBlock { Text = title, Style = (Style)Application.Current.Resources["SubtitleTextBlockStyle"], HorizontalAlignment = HorizontalAlignment.Center, TextAlignment = TextAlignment.Center },
                new TextBlock { Text = description, Foreground = Ui.Theme("TextFillColorSecondaryBrush"), TextWrapping = TextWrapping.Wrap, TextAlignment = TextAlignment.Center },
            },
        };
}
