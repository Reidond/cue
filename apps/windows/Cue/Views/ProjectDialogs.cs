using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;

namespace Cue;

/// <summary>The dialogs of the projects: New Project, Rename, and the Recycle Bin question. Each does its work through <see cref="AppState"/> and says what went wrong.</summary>
internal static class ProjectDialogs
{
    public static async Task NewProject(AppState state, XamlRoot root)
    {
        var name = new TextBox { PlaceholderText = "e.g. PhD defense" };
        AutomationProperties.SetName(name, "Name");
        var dialog = Dialog(
            root,
            "New Project",
            "Create",
            "A project holds what Cue needs for one talk — the occasion, your slides and documents — and the notes of its calls.",
            name);
        if (await Show(dialog) != ContentDialogResult.Primary) return;
        try
        {
            var project = await state.Projects.Create(name.Text);
            state.Dashboard.OpenProject(project.Id);
        }
        catch (Exception e) when (e is CueApiException or IOException or UnauthorizedAccessException)
        {
            state.Alert("Couldn't create the project", e.Message);
        }
    }

    public static async Task Rename(AppState state, Project project, XamlRoot root)
    {
        var name = new TextBox { Text = project.Name };
        AutomationProperties.SetName(name, "Name");
        var dialog = Dialog(root, "Rename Project", "Rename", null, name);
        if (await Show(dialog) != ContentDialogResult.Primary) return;
        try
        {
            await state.RenameProject(project, name.Text);
        }
        catch (Exception e) when (e is CueApiException or IOException or UnauthorizedAccessException)
        {
            state.Alert("Couldn't rename the project", e.Message);
        }
    }

    public static async Task Delete(AppState state, Project project, XamlRoot root)
    {
        var dialog = new ContentDialog
        {
            Title = $"Move “{project.Name}” to the Recycle Bin?",
            Content = new TextBlock
            {
                Text = "Its materials are deleted from your account, and its notes go to the Recycle Bin. You can restore the folder from the Recycle Bin in Explorer.",
                TextWrapping = TextWrapping.Wrap,
            },
            PrimaryButtonText = "Move to Recycle Bin",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Close,
            XamlRoot = root,
        };
        if (await Show(dialog) != ContentDialogResult.Primary) return;
        try
        {
            await state.DeleteProject(project);
        }
        catch (Exception e) when (e is CueApiException or IOException or UnauthorizedAccessException)
        {
            state.Alert("Couldn't delete the project", e.Message);
        }
    }

    /// <summary>A dialog with a name to type: the button is there once something is.</summary>
    private static ContentDialog Dialog(XamlRoot root, string title, string button, string? message, TextBox name)
    {
        var content = new StackPanel { Spacing = 12, MinWidth = 320 };
        if (message is not null) content.Children.Add(new TextBlock { Text = message, TextWrapping = TextWrapping.Wrap });
        content.Children.Add(name);
        var dialog = new ContentDialog
        {
            Title = title,
            Content = content,
            PrimaryButtonText = button,
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Primary,
            IsPrimaryButtonEnabled = name.Text.Trim().Length > 0,
            XamlRoot = root,
        };
        name.TextChanged += (_, _) => dialog.IsPrimaryButtonEnabled = name.Text.Trim().Length > 0;
        dialog.Opened += (_, _) =>
        {
            name.Focus(FocusState.Programmatic);
            name.SelectAll();
        };
        return dialog;
    }

    private static async Task<ContentDialogResult> Show(ContentDialog dialog)
    {
        try
        {
            return await dialog.ShowAsync();
        }
        catch (InvalidOperationException)
        {
            // Another dialog is open already.
            return ContentDialogResult.None;
        }
    }
}
