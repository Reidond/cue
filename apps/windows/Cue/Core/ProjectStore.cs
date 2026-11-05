using System.Globalization;
using System.Text.RegularExpressions;

namespace Cue;

/// <summary>
/// The signed-in person's projects: the account holds them (settings and materials, through the Cue API) and the library folder (`Documents\Cue`)
/// has one subfolder for each, for the notes. The port of the Mac's ProjectStore. Used from the UI thread only; this is where the rest of the app
/// finds the projects: <see cref="Projects"/>, <see cref="Active"/> (the one Cue answers from and records into), <see cref="FindByName"/>.
/// </summary>
public sealed class ProjectStore : Observable
{
    private readonly CueApi api;
    private readonly SessionLog log;
    private readonly Preferences preferences;

    private IReadOnlyList<Project> projects = [];
    private IReadOnlySet<string> uploading = new HashSet<string>();

    /// <summary>Settings changes waiting to be saved to the account, by the account's id for the project.</summary>
    private readonly Dictionary<string, CancellationTokenSource> saves = [];

    private bool syncing;
    private bool syncAgain;

    /// <summary>The projects whose brief is being followed while the account writes it (by the account's id).</summary>
    private readonly HashSet<string> following = [];

    /// <summary>Changes in flight (create, rename, delete, adding files), and how many have finished: a re-read of the account that
    /// overlapped one is out of date and is thrown away.</summary>
    private int changing;

    private int changes;

    public ProjectStore(CueApi api, SessionLog log, Preferences preferences)
    {
        this.api = api;
        this.log = log;
        this.preferences = preferences;
    }

    /// <summary>The projects, in the order Explorer would sort their names.</summary>
    public IReadOnlyList<Project> Projects
    {
        get => projects;
        private set => Set(ref projects, value);
    }

    /// <summary>The projects with a file on its way to the account (by folder name).</summary>
    public IReadOnlySet<string> Uploading
    {
        get => uploading;
        private set => Set(ref uploading, value);
    }

    public static string Library => Storage.Library;

    public Project? Find(string? id) => id is null ? null : projects.FirstOrDefault(project => project.Id == id);

    /// <summary>By name or folder name (CUE_PROJECT, `set`, `add`, …).</summary>
    public Project? FindByName(string name) => projects.FirstOrDefault(project => project.Name == name) ?? projects.FirstOrDefault(project => project.Id == name);

    /// <summary>The project used last (or created last, if none was used yet).</summary>
    public Project? MostRecent => projects.OrderBy(project => project.LastUsed ?? project.Created).LastOrDefault();

    /// <summary>The project Cue answers from and records into: the one chosen at sign-in (CUE_PROJECT, else the last one used) or by the person since.</summary>
    public Project? Active => Find(preferences.ActiveProject);

    /// <summary>Forgets the projects held in memory (signing out); the folders and the account keep theirs.</summary>
    public void Clear()
    {
        Projects = [];
        Uploading = new HashSet<string>();
    }

    // MARK: The account

    /// <summary>
    /// Loads the projects of the account and their files. The first time on this PC, the projects found in the library that the account
    /// doesn't know yet go up with their materials ("📦 Imported …"). Every project has its folder here, made when it is first seen.
    /// </summary>
    public async Task SyncWithAccount()
    {
        if (syncing)
        {
            syncAgain = true;
            return;
        }
        syncing = true;
        try
        {
            do
            {
                syncAgain = false;
                await SyncOnce();
            }
            while (syncAgain);
        }
        finally
        {
            syncing = false;
        }
    }

    private async Task SyncOnce()
    {
        var changesAtStart = changes;
        var local = LocalProjects();
        try
        {
            var remote = await api.ListProjects();
            var imported = 0;
            var files = 0;
            foreach (var project in local.Where(project => project.ServerId is null))
            {
                if (await ImportProject(project) is not { } result) continue;
                imported++;
                files += result;
            }
            if (imported > 0)
            {
                log.Write($"📦 Imported {imported} project{(imported == 1 ? "" : "s")} from this PC ({files} file{(files == 1 ? "" : "s")})");
                remote = await api.ListProjects();
            }

            // A create or rename in flight has the account's side done and the folder's not yet: look again once it's over, so nothing is made twice.
            if (changing != 0 || changes != changesAtStart)
            {
                syncAgain = true;
                return;
            }
            var folders = new Dictionary<string, Project>();
            foreach (var project in LocalProjects())
            {
                if (project.ServerId is { } id) folders.TryAdd(id, project);
            }
            var synced = new List<Project>();
            foreach (var item in remote)
            {
                var project = folders.TryGetValue(item.Id, out var found) ? found : MakeFolder(item);
                // A change waiting to be saved is newer than the account's; what Cue wrote and heard is the account's alone.
                project = saves.ContainsKey(item.Id) ? project with { Brief = item.Brief ?? ProjectBrief.None, Language = item.Language } : Apply(item, project);
                try
                {
                    project = project with { Materials = await api.Materials(item.Id) };
                }
                catch (CueApiException)
                {
                    // Keep the files it had; the next read tries again.
                }
                TryWrite(project);
                synced.Add(project);
            }
            if (changing != 0 || changes != changesAtStart)
            {
                syncAgain = true;
                return;
            }
            Projects = Sorted(synced);
            foreach (var project in projects.Where(project => project.Brief.Working)) FollowBrief(project);
        }
        catch (Exception e) when (e is CueApiException or IOException or UnauthorizedAccessException)
        {
            log.Write($"{SessionLog.Warning} Couldn't load your projects: {e.Message}");
            if (projects.Count == 0) Projects = Sorted(local);
        }
    }

    /// <summary>What the account says about a project, applied to the one here.</summary>
    private static Project Apply(RemoteProject remote, Project project) =>
        project with
        {
            Name = remote.Name,
            Occasion = remote.Occasion,
            Language = remote.Language,
            Vocabulary = remote.NamesAndTerms,
            Brief = remote.Brief ?? ProjectBrief.None,
            Created = DateTimeOffset.FromUnixTimeMilliseconds((long)remote.CreatedAt),
            LastUsed = remote.LastUsedAt is { } used ? DateTimeOffset.FromUnixTimeMilliseconds((long)used) : null,
        };

    private static ProjectFields Fields(Project project) =>
        new(project.Name, project.Occasion, project.Vocabulary, project.Created.ToUnixTimeMilliseconds(), project.LastUsed?.ToUnixTimeMilliseconds());

    private static ProjectChanges Changes(Project project) =>
        new(project.Name, project.Occasion, project.Vocabulary, project.LastUsed?.ToUnixTimeMilliseconds());

    /// <summary>Sends a project found in the library to the account, with the files it kept in `Materials\`: how many files went up, or null when it couldn't be made.</summary>
    private async Task<int?> ImportProject(Project project)
    {
        string serverId;
        try
        {
            serverId = (await api.CreateProject(Fields(project))).Id;
            Write(project with { ServerId = serverId });
        }
        catch (Exception e) when (e is CueApiException or IOException or UnauthorizedAccessException)
        {
            log.Write($"{SessionLog.Warning} Couldn't import “{project.Name}”: {e.Message}");
            return null;
        }
        var files = 0;
        var staged = Directory.Exists(project.MaterialsFolder)
            ? Directory.EnumerateFiles(project.MaterialsFolder).Where(file => Material.IsSupported(file) && !IsHidden(file)).ToList()
            : [];
        staged.Sort((a, b) => Shell.NaturalCompare(Path.GetFileName(a), Path.GetFileName(b)));
        foreach (var file in staged)
        {
            try
            {
                await api.UploadMaterial(file, serverId);
                files++;
            }
            catch (Exception e) when (e is CueApiException or IOException or UnauthorizedAccessException)
            {
                log.Write($"{SessionLog.Warning} Couldn't import {Path.GetFileName(file)} of “{project.Name}”: {e.Message}");
            }
        }
        return files;
    }

    // MARK: Changes

    /// <summary>A new project in the account, and its folder here.</summary>
    public async Task<Project> Create(string name)
    {
        changing++;
        try
        {
            var remote = await api.CreateProject(new ProjectFields(name.Trim()));
            var project = Apply(remote, MakeFolder(remote));
            Write(project);
            Projects = Sorted([.. projects, project]);
            return project;
        }
        finally
        {
            changing--;
            changes++;
        }
    }

    /// <summary>Saves the fields (name, occasion, names and terms, dates): at once here, and to the account a moment after the last edit.</summary>
    public void Update(Project project)
    {
        var list = projects.ToList();
        var index = list.FindIndex(item => item.Id == project.Id);
        if (index < 0 || list[index] == project) return;
        list[index] = project;
        Projects = list;
        TryWrite(project);
        if (project.ServerId is not { } serverId) return;
        if (saves.Remove(serverId, out var earlier)) earlier.Cancel();
        var later = new CancellationTokenSource();
        saves[serverId] = later;
        _ = SaveLater(serverId, later);
    }

    private async Task SaveLater(string serverId, CancellationTokenSource later)
    {
        try
        {
            await Task.Delay(TimeSpan.FromMilliseconds(800), later.Token);
        }
        catch (OperationCanceledException)
        {
            return;
        }
        // A newer edit (or a delete) replaced this one while it waited.
        if (!saves.TryGetValue(serverId, out var current) || current != later) return;
        saves.Remove(serverId);
        if (projects.FirstOrDefault(project => project.ServerId == serverId) is not { } project) return;
        try
        {
            await api.UpdateProject(serverId, Changes(project));
            log.Write($"☁️ Saved “{project.Name}” to your account");
        }
        catch (CueApiException e)
        {
            log.Write($"{SessionLog.Warning} Couldn't save “{project.Name}”: {e.Message}");
        }
    }

    /// <summary>Renames the project in the account, and its folder here; returns the renamed project.</summary>
    public async Task<Project> Rename(Project project, string name)
    {
        name = name.Trim();
        if (name.Length == 0 || name == project.Name) return project;
        changing++;
        try
        {
            if (project.ServerId is { } serverId) await api.UpdateProject(serverId, new ProjectChanges(Name: name));
            var renamed = (Find(project.Id) ?? project) with { Name = name };
            if (FolderName(name) != project.Id)
            {
                renamed = renamed with { Folder = Path.Combine(Library, UniqueFolderName(name, except: project.Folder)) };
                MoveFolder(project.Folder, renamed.Folder);
            }
            Write(renamed);
            Projects = Sorted([.. projects.Where(item => item.Id != project.Id), renamed]);
            if (preferences.ActiveProject == project.Id) preferences.ActiveProject = renamed.Id;
            return renamed;
        }
        finally
        {
            changing--;
            changes++;
        }
    }

    /// <summary>Deletes the project and its materials from the account, and moves its folder here, notes included, to the Recycle Bin.</summary>
    public async Task Delete(Project project)
    {
        changing++;
        try
        {
            if (project.ServerId is { } serverId)
            {
                if (saves.Remove(serverId, out var waiting)) waiting.Cancel();
                await api.DeleteProject(serverId);
            }
            Shell.MoveToRecycleBin(project.Folder);
            Projects = Sorted(projects.Where(item => item.Id != project.Id));
            if (preferences.ActiveProject == project.Id)
            {
                preferences.ActiveProject = null;
                if (MostRecent is { } next) Activate(next);
            }
        }
        finally
        {
            changing--;
            changes++;
        }
    }

    /// <summary>Sends files to the project; the account stores them and reads their text. Files of a kind it doesn't read are skipped.</summary>
    public async Task<int> AddMaterials(IEnumerable<string> paths, Project project)
    {
        if (project.ServerId is not { } serverId) return 0;
        changing++;
        Uploading = new HashSet<string>(uploading) { project.Id };
        var added = 0;
        try
        {
            foreach (var path in paths.Where(Material.IsSupported))
            {
                if (!File.Exists(path)) continue;
                try
                {
                    var material = await api.UploadMaterial(path, serverId);
                    added++;
                    log.Write($"📎 Added {material.Name} to {project.Name}: {material.Error ?? material.Summary}");
                }
                catch (Exception e) when (e is CueApiException or IOException or UnauthorizedAccessException)
                {
                    log.Write($"{SessionLog.Warning} Couldn't add {Path.GetFileName(path)} to {project.Name}: {e.Message}");
                }
            }
            await RefreshMaterials(project.Id);
        }
        finally
        {
            changing--;
            changes++;
            Uploading = new HashSet<string>(uploading.Where(id => id != project.Id));
        }
        // The account reads them again for the brief.
        if (added > 0 && Find(project.Id) is { } current) FollowBrief(current);
        return added;
    }

    public async Task RemoveMaterial(Material material, Project project)
    {
        if (project.ServerId is not { } serverId) return;
        changing++;
        try
        {
            await api.DeleteMaterial(material.Id, serverId);
            log.Write($"🗑 Removed {material.Name} from {project.Name}");
        }
        catch (CueApiException e)
        {
            log.Write($"{SessionLog.Warning} Couldn't remove {material.Name}: {e.Message}");
        }
        finally
        {
            changing--;
            changes++;
        }
        await RefreshMaterials(project.Id);
        if (Find(project.Id) is { } current) FollowBrief(current);
    }

    /// <summary>Asks the account to write the brief again: after it failed, or for files added before Cue wrote briefs.</summary>
    public async Task PrepareAgain(Project project)
    {
        if (project.ServerId is not { } serverId) return;
        try
        {
            var brief = await api.BriefAgain(serverId);
            SetBrief(serverId, brief, null);
            if (Find(project.Id) is { } current) FollowBrief(current);
        }
        catch (CueApiException e)
        {
            log.Write($"{SessionLog.Warning} Couldn't prepare “{project.Name}” from its materials: {e.Message}");
        }
    }

    /// <summary>
    /// Follows the brief while the account writes it: the account's events say each change until it is written (or failed), and the session log says how it
    /// went. Its page then reads the prepared answers again (the brief changed).
    /// </summary>
    private void FollowBrief(Project project)
    {
        if (project.ServerId is not { } serverId || !following.Add(serverId)) return;
        _ = Follow(serverId);
    }

    private async Task Follow(string serverId)
    {
        try
        {
            var started = DateTime.UtcNow;
            var over = false;
            var followed = false;
            // Deleted meanwhile, or signed out.
            while (!over && DateTime.UtcNow - started < TimeSpan.FromMinutes(10) && projects.Any(project => project.ServerId == serverId))
            {
                try
                {
                    var found = await api.FollowBriefEvents(serverId, brief =>
                    {
                        over = !brief.Working;
                        Show(serverId, brief, null);
                    });
                    if (!found)
                    {
                        // An account from before the brief's events; or, once they were followed, the project is gone from it.
                        if (!followed) await Poll(serverId, started);
                        return;
                    }
                    followed = true;
                }
                catch (CueApiException e) when (e.Kind == CueApiError.Ended)
                {
                    return;
                }
                catch (CueApiException)
                {
                    // The stream dropped, or the account is out of reach for a moment.
                }
                // Ended before the brief was written (or failed): it is opened again, and says the brief as it is now.
                if (!over) await Task.Delay(TimeSpan.FromMilliseconds(1500));
            }
        }
        finally
        {
            following.Remove(serverId);
        }
    }

    /// <summary>The same with an account from before the brief's events (during a deploy): the project is read again every 1.5 s.</summary>
    private async Task Poll(string serverId, DateTime started)
    {
        while (DateTime.UtcNow - started < TimeSpan.FromMinutes(10))
        {
            await Task.Delay(TimeSpan.FromMilliseconds(1500));
            if (!projects.Any(project => project.ServerId == serverId)) return;
            RemoteProject remote;
            try
            {
                remote = await api.Project(serverId);
            }
            catch (CueApiException)
            {
                continue;
            }
            var brief = remote.Brief ?? ProjectBrief.None;
            if (!Show(serverId, brief, remote.Language) || !brief.Working) return;
        }
    }

    /// <summary>The account's brief on the project here, and in the session log once it is written (or failed); false when the project is gone.</summary>
    private bool Show(string serverId, ProjectBrief brief, string? language)
    {
        if (SetBrief(serverId, brief, language) is not { } name) return false;
        if (brief.Ready) log.Write($"✨ Prepared “{name}” from its materials: {brief.AnswersText}, {brief.TermsText}");
        else if (brief.Failed) log.Write($"{SessionLog.Warning} Couldn't prepare “{name}” from its materials: {brief.Error ?? "something went wrong"}");
        return true;
    }

    /// <summary>The account's brief (and the language it heard) on the project here: its name, or null when it is gone.</summary>
    private string? SetBrief(string serverId, ProjectBrief brief, string? language)
    {
        if (projects.FirstOrDefault(project => project.ServerId == serverId) is not { } found) return null;
        var updated = found with { Brief = brief, Language = language ?? found.Language };
        if (updated != found) Projects = projects.Select(project => project.ServerId == serverId ? updated : project).ToList();
        return found.Name;
    }

    private async Task RefreshMaterials(string id)
    {
        if (Find(id)?.ServerId is not { } serverId) return;
        List<Material> materials;
        try
        {
            materials = await api.Materials(serverId);
        }
        catch (CueApiException)
        {
            return;
        }
        // Looked up again: the project may have been edited, renamed or deleted while the account was asked.
        if (Find(id) is not { } project) return;
        Projects = projects.Select(item => item.Id == id ? project with { Materials = materials } : item).ToList();
    }

    /// <summary>
    /// What the account read from the project's files, for the project's page: the files, the prepared answers (the files' own first, then the ones
    /// Cue wrote from them) and how much Claude reads for each question. Null when it couldn't be asked.
    /// </summary>
    public async Task<KnowledgeBase?> Knowledge(string? serverId)
    {
        if (serverId is null) return new KnowledgeBase([], []);
        try
        {
            var project = api.Project(serverId);
            var materials = api.Materials(serverId);
            var answers = api.PreparedAnswers(serverId);
            await Task.WhenAll(project, materials, answers);
            return new KnowledgeBase(
                [.. materials.Result.Select(material => new MaterialDocument(material.Name, material.Summary, material.Error))],
                [.. answers.Result.Select(answer => new PreparedAnswer(answer.Question, answer.Answer, answer.Who, answer.Source, answer.From == "cue"))],
                project.Result.Reading);
        }
        catch (CueApiException e)
        {
            log.Write($"{SessionLog.Warning} Couldn't read your materials: {e.Message}");
            return null;
        }
    }

    // MARK: The active project

    /// <summary>
    /// The project Cue is bound to after signing in. CUE_PROJECT=name picks it (creating it when missing); otherwise the last one used, else
    /// the one used most recently.
    /// </summary>
    public async Task ChooseActive()
    {
        if (Env.Get("CUE_PROJECT") is { } name)
        {
            if (FindByName(name) is null)
            {
                try
                {
                    await Create(name);
                }
                catch (CueApiException e)
                {
                    log.Write($"{SessionLog.Warning} Couldn't create “{name}”: {e.Message}");
                }
            }
            preferences.ActiveProject = FindByName(name)?.Id;
        }
        else
        {
            preferences.ActiveProject = (Find(preferences.ActiveProject) ?? MostRecent)?.Id;
        }
        if (Active is { } active) log.Write($"📁 Project: {active.Name}");
    }

    /// <summary>Binds Cue to a project: its materials and what Cue wrote from them. It was used just now.</summary>
    public void Activate(Project project)
    {
        var current = Find(project.Id) ?? project;
        Update(current with { LastUsed = DateTimeOffset.FromUnixTimeSeconds(DateTimeOffset.UtcNow.ToUnixTimeSeconds()) });
        if (preferences.ActiveProject == project.Id) return;
        preferences.ActiveProject = project.Id;
        log.Write($"📁 Project: {current.Name}");
    }

    // MARK: Files

    private static IReadOnlyList<Project> Sorted(IEnumerable<Project> list)
    {
        var sorted = list.ToList();
        sorted.Sort((a, b) => Shell.NaturalCompare(a.Name, b.Name));
        return sorted;
    }

    private static bool IsHidden(string path) => (File.GetAttributes(path) & FileAttributes.Hidden) != 0;

    private static void Write(Project project)
    {
        Directory.CreateDirectory(project.Folder);
        Storage.WriteAtomically(ProjectFile.Path(project.Folder), ProjectFile.Of(project).ToJson() + "\n");
    }

    private void TryWrite(Project project)
    {
        try
        {
            Write(project);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            log.Write($"{SessionLog.Warning} Couldn't write {Path.GetFileName(project.Folder)}\\project.json: {e.Message}");
        }
    }

    /// <summary>Every folder in the library is a project; one without `project.json` is named after its folder.</summary>
    private static List<Project> LocalProjects()
    {
        if (!Directory.Exists(Library)) return [];
        return Directory.EnumerateDirectories(Library)
            .Where(folder => (new DirectoryInfo(folder).Attributes & FileAttributes.Hidden) == 0)
            .Select(ProjectFile.Load)
            .ToList();
    }

    /// <summary>The project's folder here, made when the account's project is first seen on this PC.</summary>
    private static Project MakeFolder(RemoteProject remote)
    {
        var project = new Project { Name = remote.Name, Language = remote.Language, ServerId = remote.Id, Folder = Path.Combine(Library, UniqueFolderName(remote.Name)) };
        try
        {
            Directory.CreateDirectory(project.NotesFolder);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Writing project.json tells why, if it is the folder that can't be made.
        }
        return project;
    }

    private static readonly Regex ReservedName = new(@"^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\..*)?$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>A name as a folder in the library: what Windows doesn't allow in one becomes "-", and it is at most 80 characters.</summary>
    public static string FolderName(string name)
    {
        var safe = string.Concat(name.Select(c => Path.GetInvalidFileNameChars().Contains(c) ? '-' : c)).Trim().Trim('.').Trim();
        if (safe.Length > 80) safe = safe[..80].TrimEnd(' ', '.');
        if (safe.Length == 0) return "Project";
        return ReservedName.IsMatch(safe) ? safe + "-" : safe;
    }

    /// <summary>The folder name for a project, numbered when another one has it. `except` is the folder the project already has (its own name is free).</summary>
    private static string UniqueFolderName(string name, string? except = null)
    {
        var baseName = FolderName(name);
        var candidate = baseName;
        for (var number = 2; Directory.Exists(Path.Combine(Library, candidate)) && !SameFolder(Path.Combine(Library, candidate), except); number++)
            candidate = string.Create(CultureInfo.InvariantCulture, $"{baseName} {number}");
        return candidate;
    }

    /// <summary>Renames a folder; one that differs only in case goes by way of another name, as Windows' own rename does.</summary>
    private static void MoveFolder(string from, string to)
    {
        if (SameFolder(from, to))
        {
            var aside = from + ".renaming";
            Directory.Move(from, aside);
            Directory.Move(aside, to);
        }
        else
        {
            Directory.Move(from, to);
        }
    }

    private static bool SameFolder(string a, string? b) => b is not null && string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase);
}
