using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Cue;

/// <summary>Settings › General: who the speaker is. The rest (answers, notes, the library) comes with the slices that have them.</summary>
public sealed class GeneralView : UserControl
{
    public GeneralView(AppState state)
    {
        var name = new TextBox
        {
            Text = state.Preferences.SpeakerName,
            PlaceholderText = "How notes and answers refer to you",
            MinWidth = 280,
        };
        name.TextChanged += (_, _) => state.Preferences.SpeakerName = name.Text;
        var row = new Grid { ColumnSpacing = 16 };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.Children.Add(new TextBlock { Text = "Your name", VerticalAlignment = VerticalAlignment.Center });
        Grid.SetColumn(name, 1);
        row.Children.Add(name);
        Content = new StackPanel { Spacing = 8, Children = { Ui.Card(Ui.Padded(row)) } };
    }
}
