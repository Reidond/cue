namespace Cue;

/// <summary>
/// The `CUE_CONTROL` commands of the projects (the Mac's, line for line): `new NAME`, `add PATH`, `set PROJECT | occasion|language|names | VALUE`,
/// `remove PROJECT | FILE`, and `page NAME`, `page NAME/answers`, `page NAME/overview`, `page NAME/notes`. Two more are the Windows app's own, for what
/// the Mac does in a dialog no case drives: `rename-project NAME | NEW` and `delete-project NAME` run what the project's context menu runs.
/// </summary>
internal static class ProjectCommands
{
    private static readonly (string Suffix, ProjectTab Tab)[] Tabs =
    [
        ("overview", ProjectTab.Overview),
        ("answers", ProjectTab.Answers),
        ("notes", ProjectTab.Notes),
    ];

    public static void Register(AppState state)
    {
        var projects = state.Projects;
        var control = state.Control;

        control.Register("new", async name =>
        {
            state.OpenDashboard();
            var project = await projects.Create(name);
            state.Dashboard.OpenProject(project.Id);
        });

        // A file dropped on the open project's materials (the active project's when no project is open).
        control.Register("add", async path =>
        {
            if ((projects.Find(state.Dashboard.CurrentProjectId) ?? projects.Active) is { } project)
                await projects.AddMaterials([path], project);
        });

        control.Register("set", argument =>
        {
            var sides = argument.Split(" | ");
            if (sides.Length == 3 && projects.FindByName(sides[0]) is { } project)
            {
                projects.Update(sides[1] switch
                {
                    "occasion" => project with { Occasion = sides[2] },
                    "language" => project with { Language = sides[2] },
                    "names" => project with { Vocabulary = sides[2] },
                    _ => project,
                });
            }
            return Task.CompletedTask;
        });

        control.Register("remove", async argument =>
        {
            var sides = argument.Split(" | ");
            if (sides.Length == 2 && projects.FindByName(sides[0]) is { } project && project.Materials.FirstOrDefault(material => material.Name == sides[1]) is { } material)
                await projects.RemoveMaterial(material, project);
        });

        control.Register("rename-project", async argument =>
        {
            var sides = argument.Split(" | ");
            if (sides.Length == 2 && projects.FindByName(sides[0]) is { } project) await state.RenameProject(project, sides[1]);
        });

        control.Register("delete-project", async argument =>
        {
            if (projects.FindByName(argument) is { } project) await state.DeleteProject(project);
        });

        state.Dashboard.PageResolvers.Add(argument =>
        {
            var name = argument;
            var tab = ProjectTab.Overview;
            if (argument.LastIndexOf('/') is var slash and >= 0)
            {
                var suffix = argument[(slash + 1)..];
                foreach (var (known, section) in Tabs)
                {
                    if (known != suffix) continue;
                    name = argument[..slash];
                    tab = section;
                }
            }
            if (projects.FindByName(name) is not { } project) return false;
            state.Dashboard.OpenProject(project.Id, tab);
            return true;
        });
    }
}
