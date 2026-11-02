using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Cue;

/// <summary>Small builders for the settings panes: a card of rows, a caption, as Windows 11's own Settings lays them out.</summary>
internal static class Ui
{
    private static Brush Theme(string key) => (Brush)Application.Current.Resources[key];

    /// <summary>A rounded card holding the rows, divided by lines.</summary>
    public static Border Card(params UIElement[] rows)
    {
        var stack = new StackPanel();
        for (var i = 0; i < rows.Length; i++)
        {
            if (i > 0) stack.Children.Add(new Border { Height = 1, Background = Theme("DividerStrokeColorDefaultBrush") });
            stack.Children.Add(rows[i]);
        }
        return new Border
        {
            Child = stack,
            Background = Theme("CardBackgroundFillColorDefaultBrush"),
            BorderBrush = Theme("CardStrokeColorDefaultBrush"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(8),
        };
    }

    /// <summary>A line of a card: what it is on the left, its value on the right.</summary>
    public static Grid Row(string label, string value)
    {
        var grid = new Grid { Padding = new Thickness(16, 12, 16, 12), ColumnSpacing = 16 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.Children.Add(new TextBlock { Text = label, VerticalAlignment = VerticalAlignment.Center });
        var text = new TextBlock
        {
            Text = value,
            Foreground = Theme("TextFillColorSecondaryBrush"),
            VerticalAlignment = VerticalAlignment.Center,
            IsTextSelectionEnabled = true,
        };
        Grid.SetColumn(text, 1);
        grid.Children.Add(text);
        return grid;
    }

    /// <summary>A card's own row, holding any control.</summary>
    public static Grid Padded(UIElement content) => new() { Padding = new Thickness(16, 12, 16, 12), Children = { content } };

    public static TextBlock Header(string text) =>
        new() { Text = text, Style = (Style)Application.Current.Resources["BodyStrongTextBlockStyle"], Margin = new Thickness(0, 8, 0, 0) };

    public static TextBlock Caption(string text, bool caution = false) =>
        new()
        {
            Text = text,
            Style = (Style)Application.Current.Resources["CaptionTextBlockStyle"],
            Foreground = Theme(caution ? "SystemFillColorCautionBrush" : "TextFillColorSecondaryBrush"),
            TextWrapping = TextWrapping.Wrap,
        };
}
