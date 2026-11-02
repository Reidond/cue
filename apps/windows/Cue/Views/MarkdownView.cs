using System.Globalization;
using System.Text.RegularExpressions;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Media;

namespace Cue;

/// <summary>
/// Renders the Markdown Cue writes (and what people usually add by hand): front matter, headings, paragraphs, bullet / numbered / task lists, quotes,
/// rules, code blocks and transcript speaker lines, in standard controls on the Fluent type ramp and theme colours. The port of the Mac's MarkdownView.
/// </summary>
internal sealed partial class MarkdownView : UserControl
{
    private readonly StackPanel stack = new();

    public MarkdownView() => Content = stack;

    /// <summary>
    /// Shows the document. `onTimestamp` makes the speaker lines' timestamps clickable (called with the offset in seconds), `onSpeaker` their names
    /// (called with the name).
    /// </summary>
    public void Show(string markdown, Action<double>? onTimestamp, Action<string>? onSpeaker)
    {
        stack.Children.Clear();
        var blocks = Parse(markdown);
        for (var i = 0; i < blocks.Count; i++)
        {
            var element = Build(blocks[i], onTimestamp, onSpeaker);
            if (i > 0) element.Margin = new Thickness(0, SpacingAbove(blocks[i]), 0, 0);
            stack.Children.Add(element);
        }
    }

    /// <summary>A transcript timestamp in seconds: "00:01:05" or "1:05" → 65.</summary>
    public static double? Seconds(string time) => RecordingCommands.Seconds(time);

    // MARK: Parsing

    private abstract record Block;

    private sealed record Metadata(List<(string Key, string Value)> Pairs) : Block;

    private sealed record Heading(int Level, string Text) : Block;

    private sealed record Paragraph(string Text) : Block;

    private sealed record Bullet(string Text, int Depth) : Block;

    private sealed record TaskItem(string Text, bool Done, int Depth) : Block;

    private sealed record Numbered(int Number, string Text, int Depth) : Block;

    private sealed record Quote(string Text) : Block;

    private sealed record Code(string Text) : Block;

    private sealed record Speaker(string Time, string Name) : Block;

    private sealed record Rule : Block;

    [GeneratedRegex(@"^(#{1,6})\s+(.+)$")]
    private static partial Regex HeadingLine();

    [GeneratedRegex(@"^[-*+]\s+\[([ xX])\]\s+(.*)$")]
    private static partial Regex TaskLine();

    [GeneratedRegex(@"^[-*+]\s+(.*)$")]
    private static partial Regex BulletLine();

    [GeneratedRegex(@"^(\d+)[.)]\s+(.*)$")]
    private static partial Regex NumberedLine();

    [GeneratedRegex(@"^>\s?(.*)$")]
    private static partial Regex QuoteLine();

    [GeneratedRegex(@"^\*\*(\d{1,2}:\d{2}(?::\d{2})?)\s+·\s+(.+)\*\*$")]
    private static partial Regex SpeakerLine();

    private static List<Block> Parse(string text)
    {
        var blocks = new List<Block>();
        var lines = text.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n').ToList();

        // YAML front matter shown as a compact metadata row; the title (and the event it is named after) repeats as the H1, the audio has its own player
        // and name suggestions their chips.
        if (lines.Count > 0 && lines[0] == "---" && lines.IndexOf("---", 1) is var end and > 0)
        {
            var pairs = new List<(string Key, string Value)>();
            foreach (var line in lines.Skip(1).Take(end - 1))
            {
                var colon = line.IndexOf(':', StringComparison.Ordinal);
                if (colon < 0) continue;
                var key = line[..colon].Trim();
                var value = line[(colon + 1)..].Trim().Trim('"');
                if (key is "date" or "duration" or "participants" or "attendees" or "project" && value.Length > 0 && value != "[]") pairs.Add((key, value));
            }
            if (pairs.Count > 0) blocks.Add(new Metadata(pairs));
            lines = lines.Skip(end + 1).ToList();
        }

        var paragraph = new List<string>();
        void Flush()
        {
            if (paragraph.Count > 0) blocks.Add(new Paragraph(string.Join(" ", paragraph)));
            paragraph.Clear();
        }

        for (var index = 0; index < lines.Count; index++)
        {
            var raw = lines[index];
            var line = raw.Trim();
            var depth = raw.TakeWhile(c => c == ' ').Count() / 2;

            if (line.StartsWith("```", StringComparison.Ordinal))
            {
                Flush();
                var code = new List<string>();
                while (++index < lines.Count && !lines[index].Trim().StartsWith("```", StringComparison.Ordinal)) code.Add(lines[index]);
                blocks.Add(new Code(string.Join("\n", code)));
            }
            else if (line.Length == 0 || line.StartsWith("<!--", StringComparison.Ordinal))
            {
                Flush();
            }
            else if (HeadingLine().Match(line) is { Success: true } heading)
            {
                Flush();
                blocks.Add(new Heading(heading.Groups[1].Length, heading.Groups[2].Value));
            }
            else if (line is "---" or "***" or "___")
            {
                Flush();
                blocks.Add(new Rule());
            }
            else if (TaskLine().Match(line) is { Success: true } task)
            {
                Flush();
                blocks.Add(new TaskItem(task.Groups[2].Value, task.Groups[1].Value != " ", depth));
            }
            else if (BulletLine().Match(line) is { Success: true } bullet)
            {
                Flush();
                blocks.Add(new Bullet(bullet.Groups[1].Value, depth));
            }
            else if (NumberedLine().Match(line) is { Success: true } numbered)
            {
                Flush();
                blocks.Add(new Numbered(int.Parse(numbered.Groups[1].Value, CultureInfo.InvariantCulture), numbered.Groups[2].Value, depth));
            }
            else if (QuoteLine().Match(line) is { Success: true } quote)
            {
                Flush();
                if (blocks.Count > 0 && blocks[^1] is Quote previous) blocks[^1] = new Quote(previous.Text + " " + quote.Groups[1].Value);
                else blocks.Add(new Quote(quote.Groups[1].Value));
            }
            else if (SpeakerLine().Match(line) is { Success: true } speaker)
            {
                Flush();
                blocks.Add(new Speaker(speaker.Groups[1].Value, speaker.Groups[2].Value));
            }
            else
            {
                paragraph.Add(line);
            }
        }
        Flush();
        return blocks;
    }

    private static double SpacingAbove(Block block) =>
        block switch
        {
            Heading { Level: 1 } => 6,
            Heading => 28,
            Bullet or TaskItem or Numbered => 6,
            Speaker => 20,
            _ => 12,
        };

    // MARK: Building

    private static Brush Theme(string key) => Ui.Theme(key);

    private static TextBlock Text(string source, string style = "BodyTextBlockStyle", string brush = "TextFillColorPrimaryBrush")
    {
        var text = new TextBlock
        {
            Style = (Style)Application.Current.Resources[style],
            Foreground = Theme(brush),
            TextWrapping = TextWrapping.Wrap,
            IsTextSelectionEnabled = true,
        };
        AddInlines(text, source);
        return text;
    }

    private static FrameworkElement Build(Block block, Action<double>? onTimestamp, Action<string>? onSpeaker)
    {
        switch (block)
        {
            case Metadata metadata:
                return new TextBlock
                {
                    Text = string.Join("  ·  ", metadata.Pairs.Select(pair => Display(pair.Key, pair.Value))),
                    Foreground = Theme("TextFillColorSecondaryBrush"),
                    TextWrapping = TextWrapping.Wrap,
                    IsTextSelectionEnabled = true,
                };
            case Heading heading:
                return Text(
                    heading.Text,
                    heading.Level == 1 ? "TitleTextBlockStyle" : heading.Level == 2 ? "SubtitleTextBlockStyle" : "BodyStrongTextBlockStyle");
            case Paragraph paragraph:
                return Text(paragraph.Text);
            case Bullet bullet:
                return Row(new TextBlock { Text = "•", Foreground = Theme("TextFillColorSecondaryBrush"), HorizontalAlignment = HorizontalAlignment.Right }, Text(bullet.Text), bullet.Depth);
            case TaskItem task:
            {
                var box = new CheckBox { IsChecked = task.Done, IsHitTestVisible = false, IsTabStop = false, MinWidth = 0, Padding = new Thickness(0), VerticalAlignment = VerticalAlignment.Top };
                AutomationProperties.SetName(box, task.Text);
                return Row(box, Text(task.Text), task.Depth);
            }
            case Numbered numbered:
                return Row(
                    new TextBlock { Text = $"{numbered.Number}.", Foreground = Theme("TextFillColorSecondaryBrush"), HorizontalAlignment = HorizontalAlignment.Right },
                    Text(numbered.Text),
                    numbered.Depth);
            case Quote quote:
            {
                var grid = new Grid { ColumnSpacing = 12 };
                grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                grid.Children.Add(new Border { Width = 3, CornerRadius = new CornerRadius(1.5), Background = Theme("ControlStrongStrokeColorDefaultBrush") });
                var text = Text(quote.Text, brush: "TextFillColorSecondaryBrush");
                Grid.SetColumn(text, 1);
                grid.Children.Add(text);
                return grid;
            }
            case Code code:
                return new Border
                {
                    Padding = new Thickness(12),
                    CornerRadius = new CornerRadius(8),
                    Background = Theme("CardBackgroundFillColorSecondaryBrush"),
                    Child = new TextBlock { Text = code.Text, FontFamily = new FontFamily("Consolas"), IsTextSelectionEnabled = true, TextWrapping = TextWrapping.Wrap },
                };
            case Speaker speaker:
                return BuildSpeaker(speaker, onTimestamp, onSpeaker);
            default:
                return new Border { Height = 1, Background = Theme("DividerStrokeColorDefaultBrush") };
        }
    }

    /// <summary>A bullet, a task or a number hangs in a fixed column so wrapped lines align.</summary>
    private static Grid Row(FrameworkElement marker, FrameworkElement text, int depth)
    {
        var grid = new Grid { ColumnSpacing = 8, Margin = new Thickness(depth * 20, 0, 0, 0) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(20) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.Children.Add(marker);
        Grid.SetColumn(text, 1);
        grid.Children.Add(text);
        return grid;
    }

    private static StackPanel BuildSpeaker(Speaker speaker, Action<double>? onTimestamp, Action<string>? onSpeaker)
    {
        var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        FrameworkElement name;
        if (onSpeaker is not null)
        {
            var button = new HyperlinkButton
            {
                Content = speaker.Name,
                Padding = new Thickness(0),
                FontWeight = FontWeights.SemiBold,
                Foreground = Theme("TextFillColorPrimaryBrush"),
                VerticalAlignment = VerticalAlignment.Center,
            };
            AutomationProperties.SetName(button, speaker.Name);
            ToolTipService.SetToolTip(button, $"Rename {speaker.Name}");
            button.Click += (_, _) => onSpeaker(speaker.Name);
            name = button;
        }
        else
        {
            name = new TextBlock { Text = speaker.Name, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center };
        }
        line.Children.Add(name);
        if (onTimestamp is not null && Seconds(speaker.Time) is { } seconds)
        {
            var button = new HyperlinkButton { Content = speaker.Time, Padding = new Thickness(0), VerticalAlignment = VerticalAlignment.Center, FontSize = 12 };
            AutomationProperties.SetName(button, speaker.Time);
            ToolTipService.SetToolTip(button, $"Play from {speaker.Time}");
            button.Click += (_, _) => onTimestamp(seconds);
            line.Children.Add(button);
        }
        else
        {
            line.Children.Add(new TextBlock { Text = speaker.Time, FontSize = 12, Foreground = Theme("TextFillColorSecondaryBrush"), VerticalAlignment = VerticalAlignment.Center });
        }
        return line;
    }

    /// <summary>The metadata row's words: the date in the person's format, the lists of people shortened ("A, B and 3 more").</summary>
    private static string Display(string key, string value)
    {
        if (key is "attendees" or "participants")
        {
            var names = key == "attendees" ? RecordingFile.ListOf(value) : RecordingFile.Participants(value);
            return names.Count > 3 ? $"{string.Join(", ", names.Take(2))} and {names.Count - 2} more" : string.Join(", ", names);
        }
        if (key == "date" && DateTime.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var date))
            return date.ToLocalTime().ToString("g", CultureInfo.CurrentCulture);
        return value;
    }

    // MARK: Inline

    [GeneratedRegex(@"\*\*(.+?)\*\*|__(.+?)__|`(.+?)`|\[(.+?)\]\((.+?)\)|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])|(?<![\w])_(?!\s)(.+?)(?<!\s)_(?![\w])")]
    private static partial Regex InlineToken();

    /// <summary>Bold, italics, code and links.</summary>
    private static void AddInlines(TextBlock block, string source)
    {
        var at = 0;
        foreach (Match match in InlineToken().Matches(source))
        {
            if (match.Index > at) block.Inlines.Add(new Run { Text = source[at..match.Index] });
            at = match.Index + match.Length;
            if (match.Groups[1].Success || match.Groups[2].Success)
            {
                var bold = new Bold();
                bold.Inlines.Add(new Run { Text = match.Groups[1].Success ? match.Groups[1].Value : match.Groups[2].Value });
                block.Inlines.Add(bold);
            }
            else if (match.Groups[3].Success)
            {
                block.Inlines.Add(new Run { Text = match.Groups[3].Value, FontFamily = new FontFamily("Consolas") });
            }
            else if (match.Groups[4].Success)
            {
                if (Uri.TryCreate(match.Groups[5].Value, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https")
                {
                    var link = new Hyperlink { NavigateUri = uri };
                    link.Inlines.Add(new Run { Text = match.Groups[4].Value });
                    block.Inlines.Add(link);
                }
                else
                {
                    block.Inlines.Add(new Run { Text = match.Groups[4].Value });
                }
            }
            else
            {
                var italic = new Italic();
                italic.Inlines.Add(new Run { Text = match.Groups[6].Success ? match.Groups[6].Value : match.Groups[7].Value });
                block.Inlines.Add(italic);
            }
        }
        if (at < source.Length) block.Inlines.Add(new Run { Text = source[at..] });
    }
}
