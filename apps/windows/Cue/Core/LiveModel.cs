using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using Microsoft.UI.Dispatching;

namespace Cue;

/// <summary>
/// Orchestrates the audio going up to the live call and what comes back: the transcript, the questions and their answers (the Mac's AppState, call half).
/// Between Start Cue and Stop Cue the overlay is up and Cue listens: the microphone and the call audio are opened, a call is made for the project
/// (`POST /v1/calls`), its socket carries the audio up and the events down, and the events drive the same exchange and answer state, and the same reading
/// rules, as on the Mac. State changes on the UI thread only; the capture threads only push audio (thread-safe).
/// </summary>
public sealed partial class LiveModel : Observable
{
    private readonly AppState state;
    private readonly AudioSink sink = new();
    private readonly LevelMeter micMeter = new();
    private readonly LevelMeter callMeter = new();

    private WasapiCapture? micCapture;
    private WasapiCapture? callCapture;
    private LiveCall? liveCall;

    /// <summary>Counts the calls started and ended, so a call that took long to start finds it was ended meanwhile.</summary>
    private int callGeneration;

    private bool callConnected;
    private int callRestarts;
    private string? callProjectId;
    private string? heardLanguage;
    private JudgeState judgeState = JudgeState.Starting;
    private bool speechUnavailable;
    private bool capturing;
    private bool rehearsalStarted;

    /// <summary>Who is talking right now, by the server's word.</summary>
    private readonly Dictionary<Side, bool> speaking = [];

    /// <summary>Commands (Ask…) given while the call was still being made.</summary>
    private readonly List<Dictionary<string, object?>> heldCommands = [];

    /// <summary>Questions being answered whose line in the session log waits for the prepared answer that matches (it comes right after the question).</summary>
    private readonly HashSet<string> unlogged = [];

    private readonly List<Exchange> exchanges = [];
    private readonly List<Utterance> utterances = [];
    private readonly Dictionary<Side, string> partial = [];

    // The reading rules (the Mac's): what the speaker is reading aloud never moves.
    private enum Reading
    {
        NotYet,
        Reading,
        Done,
    }

    private Reading reading = Reading.NotYet;
    private DateTime presenterSpoke = DateTime.MinValue;
    private static readonly TimeSpan ReadingPause = TimeSpan.FromSeconds(5);
    private readonly HashSet<Guid> heldWhileReading = [];
    private Guid? expandedId;
    private int selected;
    private bool holding;
    private bool listScrolled;
    private readonly HashSet<Guid> unseen = [];
    private readonly HashSet<Guid> seen = [];

    private bool cueRunning;
    private ServiceStatus mic = new(false, "Not listening — Start Cue to listen");
    private ServiceStatus call = new(false, "Not listening — Start Cue to listen");
    private ServiceStatus speech = ServiceStatus.Idle;
    private ServiceStatus claude = ServiceStatus.Idle;
    private float micLevel;
    private float callLevel;

    // Timers are kept in fields: one only a local variable holds is collected, and stops.
    private DispatcherQueueTimer? timer;

    public LiveModel(AppState state)
    {
        this.state = state;
        Samples += (side, samples, time) =>
        {
            (side == Side.Me ? micMeter : callMeter).Add(samples);
            sink.Push(samples, side, time);
            audioRecorder.Push(samples, side, time);
        };
        RegisterControl();
    }

    /// <summary>Raised whenever anything the overlay shows changes (the lists, the statuses); on the UI thread.</summary>
    public event Action? Changed;

    /// <summary>
    /// Both sides' audio, 16 kHz mono floats with the host time (<see cref="Audio.HostSeconds"/>) the first sample was captured at, from the capture threads
    /// (the real sources and the rehearsal alike): the recordings slice subscribes to write them to files. Handlers must be thread-safe.
    /// </summary>
    public event Action<Side, float[], double>? Samples;

    /// <summary>Shows the overlay (set by <see cref="OverlayWindow"/>).</summary>
    public Action ShowOverlay { get; set; } = () => { };

    public Action HideOverlay { get; set; } = () => { };

    public Func<bool> OverlayVisible { get; set; } = () => false;

    private CueApi Api => state.Api;
    private SessionLog Log => state.Log;
    private Preferences Prefs => state.Preferences;

    private void Touch() => Changed?.Invoke();

    // MARK: State the overlay shows

    /// <summary>The project Cue answers from (and, with the recordings slice, records into): the projects' store holds it, as the person chose it or sign-in did.</summary>
    public Project? ActiveProject => state.Projects.Active;

    /// <summary>The language the live call is held in, as the server heard it (`language` events); null until it said, and again for a new call.</summary>
    public string? HeardLanguage
    {
        get => heardLanguage;
        private set => Set(ref heardLanguage, value);
    }

    /// <summary>The language of what is spoken: the live call's, else the one the project's last call was held in.</summary>
    public string SpokenLanguage => heardLanguage ?? ActiveProject?.Language ?? Project.DefaultLanguage;

    /// <summary>Between Start Cue and Stop Cue: the overlay is up and Cue listens for questions.</summary>
    public bool CueRunning
    {
        get => cueRunning;
        private set => Set(ref cueRunning, value);
    }

    public IReadOnlyList<Exchange> Exchanges => exchanges;

    public IReadOnlyList<Utterance> Utterances => utterances;

    public IReadOnlyDictionary<Side, string> Partial => partial;

    public ServiceStatus Mic
    {
        get => mic;
        private set
        {
            if (Set(ref mic, value)) Touch();
        }
    }

    public ServiceStatus Call
    {
        get => call;
        private set
        {
            if (Set(ref call, value)) Touch();
        }
    }

    /// <summary>Speech recognition, as the live call reports it.</summary>
    public ServiceStatus Speech
    {
        get => speech;
        private set
        {
            if (Set(ref speech, value)) Touch();
        }
    }

    /// <summary>Claude, as the live call reports it.</summary>
    public ServiceStatus Claude
    {
        get => claude;
        private set
        {
            if (Set(ref claude, value)) Touch();
        }
    }

    public float MicLevel
    {
        get => micLevel;
        private set => Set(ref micLevel, value);
    }

    public float CallLevel
    {
        get => callLevel;
        private set => Set(ref callLevel, value);
    }

    /// <summary>The exchange shown in full in the overlay's list (also its index, <see cref="Selected"/>). One Cue noticed by itself takes it only once Claude
    /// starts a real answer, so an organisational remark ("—") never pushes the answer being read out of view, and not while the user reads another.</summary>
    public Guid? ExpandedId => expandedId;

    public int Selected => selected;

    /// <summary>The user opened an older exchange to read it: new ones wait under a "new questions" button.</summary>
    public bool Holding => holding;

    /// <summary>The overlay's list is scrolled away from its newest end, which holds the view in place too.</summary>
    public bool ListScrolled
    {
        get => listScrolled;
        set
        {
            if (listScrolled == value) return;
            listScrolled = value;
            if (!listScrolled && !holding) unseen.Clear();
            Touch();
        }
    }

    /// <summary>Exchanges that came in while the view was held: kept out of the list until the "new questions" button (or the newest end of the list) shows them.</summary>
    public IReadOnlySet<Guid> Unseen => unseen;

    /// <summary>The exchange shown in full, at the top of the list.</summary>
    public Exchange? Current => exchanges.FirstOrDefault(exchange => exchange.Id == expandedId);

    /// <summary>Under it, newest first: the ones not shown in full yet — still coming, ready, or waiting for Prepare Answer.</summary>
    public IReadOnlyList<Exchange> NewExchanges =>
        [.. Enumerable.Reverse(exchanges).Where(e => e.Id != expandedId && !unseen.Contains(e.Id) && !seen.Contains(e.Id) && !e.IsNotAQuestion)];

    /// <summary>At the bottom, newest first: the ones shown and left, and remarks that weren't questions.</summary>
    public IReadOnlyList<Exchange> AnsweredExchanges =>
        [.. Enumerable.Reverse(exchanges).Where(e => e.Id != expandedId && !unseen.Contains(e.Id) && (seen.Contains(e.Id) || e.IsNotAQuestion))];

    /// <summary>One line for the control bar: what Cue is doing, or the first thing that needs attention.</summary>
    public (string Text, StatusKind Kind) Status
    {
        get
        {
            if (state.PlanLimit is not null) return ("Plan limit reached", StatusKind.Problem);
            if (!speech.Ok) return (speech.Detail, speech.Working ? StatusKind.Working : StatusKind.Problem);
            if (!claude.Ok) return (claude.Detail, claude.Working ? StatusKind.Working : StatusKind.Problem);
            if (!call.Ok && !mic.Ok) return ("No audio", StatusKind.Problem);
            if (ActiveProject is not { } project) return ("No project", StatusKind.Problem);
            if (project.Materials.Count == 0) return ("No materials", StatusKind.Problem);
            return ("Listening", StatusKind.Ready);
        }
    }

    // MARK: Lifecycle

    public void Start()
    {
        // Signing out (or losing the session) ends listening: the overlay goes, and so does anything that would answer.
        Api.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName == nameof(CueApi.Phase) && Api.Phase == Phase.SignedOut) StopCue();
        };
        // The projects are the store's: another project (or the same one, once it reached the account) means another call, and what the overlay says of it
        // (no materials yet) changes with the files.
        state.Projects.PropertyChanged += (_, _) => ProjectChanged();
        state.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName == nameof(AppState.PlanLimit)) Touch();
        };
        // What the server does with the questions follows these.
        Prefs.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName is nameof(Preferences.SpeakerName) or nameof(Preferences.AutoAnswer) or nameof(Preferences.MicQuestions)) SendConfig();
            else if (e.PropertyName == nameof(Preferences.ActiveProject)) ProjectChanged();
        };
        WatchRecorder();
        StartRehearsalIfRequested();
        timer = state.Queue.CreateTimer();
        timer.Interval = TimeSpan.FromMilliseconds(100);
        timer.IsRepeating = true;
        timer.Tick += (_, _) =>
        {
            MicLevel = micMeter.Level;
            CallLevel = callMeter.Level;
            CheckReading();
        };
        timer.Start();
    }

    /// <summary>Quit: the call ends (the server closes its speech streams and keeps the transcript) and the audio closes.</summary>
    public void Shutdown()
    {
        audioRecorder.Cancel();
        state.Recordings.CancelAll();
        var id = liveCall?.Id;
        micCapture?.Dispose();
        callCapture?.Dispose();
        micCapture = callCapture = null;
        EndCall(tellServer: false);
        // Off the UI thread, which a request would otherwise wait for to continue on; Quit is going to end the process, so it is waited for briefly.
        if (id is not null) Task.Run(() => Api.EndCall(id)).Wait(TimeSpan.FromSeconds(3));
    }

    // MARK: Projects

    /// <summary>A call listens for one project: when the active one is another (or reached the account since), another call takes over.</summary>
    private void ProjectChanged()
    {
        if (capturing && ActiveProject?.ServerId != callProjectId) StartCall();
        Touch();
    }

    /// <summary>Binds Cue to a project (the store: it is the one used last now, and `📁 Project: NAME` is logged when it changes); the call follows.</summary>
    public void Activate(Project project) => state.Projects.Activate(project);

    /// <summary>The project page's Start Cue: shows the overlay and listens, answering from this project.</summary>
    public void StartCue(Project project)
    {
        Activate(project);
        StartListening();
    }

    /// <summary>
    /// Ctrl+Enter, the project page's button and the tray's menu (the Mac's File › Start Cue): Stop Cue while it runs for the project open in the dashboard
    /// (or with none open); otherwise Start Cue for that project, else the current one; with none at all, the dashboard to make one.
    /// </summary>
    public void ToggleCue(Project? open = null)
    {
        if (CueRunning && (open is null || open.Id == ActiveProject?.Id)) StopCue();
        else if ((open ?? ActiveProject) is { } project) StartCue(project);
        else state.OpenDashboard();
    }

    /// <summary>Hides or shows the overlay while Cue runs (it keeps listening); starts Cue when it doesn't.</summary>
    public void ToggleOverlay()
    {
        if (!CueRunning) StartListening();
        else if (OverlayVisible()) HideOverlay();
        else ShowOverlay();
    }

    // MARK: Listening

    /// <summary>Everything that listens, answers or records needs a signed-in account: without one, the dashboard shows the sign-in.</summary>
    private bool RequireSignIn()
    {
        if (Api.IsSignedIn) return true;
        Log.Write($"{SessionLog.Warning} Sign in to Cue first");
        state.OpenDashboard();
        return false;
    }

    /// <summary>Shows the overlay and listens, with the current project.</summary>
    public void StartListening()
    {
        if (!RequireSignIn()) return;
        ShowOverlay();
        if (CueRunning) return;
        CueRunning = true;
        Log.Write($"▶︎ Cue started{(ActiveProject is { } project ? $": {project.Name}" : "")}");
        UpdateCapture();
        SendConfig();
        Touch();
    }

    /// <summary>Stop Cue: hides the overlay and stops listening. (A call being recorded keeps recording.)</summary>
    public void StopCue()
    {
        if (!CueRunning) return;
        CueRunning = false;
        HideOverlay();
        Log.Write("⏹ Cue stopped");
        UpdateCapture();
        SendConfig();
        Touch();
    }

    /// <summary>Opens the microphone and call audio while Cue runs (or a call is recorded), and closes them after.</summary>
    private void UpdateCapture()
    {
        var needed = CueRunning || Recorder.StartedAt is not null;
        if (needed == capturing) return;
        capturing = needed;
        if (needed)
        {
            StartAudio();
            callRestarts = 0;
            StartCall();
            Log.Write("🎤 Listening");
        }
        else
        {
            StopAudio();
            EndCall();
            partial.Clear();
            Mic = new ServiceStatus(false, "Not listening — Start Cue to listen");
            Call = new ServiceStatus(false, "Not listening — Start Cue to listen");
            Log.Write("🎤 Listening stopped");
        }
    }

    private void StartAudio()
    {
        if (Env.Get("CUE_NO_LIVE_AUDIO") == "1")
        {
            Mic = new ServiceStatus(false, "Live audio off (CUE_NO_LIVE_AUDIO)");
            Call = new ServiceStatus(Env.Get("CUE_REHEARSE_PARTICIPANT") is not null, "Rehearsal");
            return;
        }
        _ = OpenMicrophone();
        _ = OpenCallAudio();
    }

    private void StopAudio()
    {
        micCapture?.Dispose();
        callCapture?.Dispose();
        micCapture = callCapture = null;
        sink.Forget(Side.Me);
        sink.Forget(Side.Others);
    }

    private async Task OpenMicrophone()
    {
        try
        {
            var opened = await Task.Run(() => Open(CaptureSource.Microphone, Side.Me));
            // Stop Cue may have come while the microphone was starting.
            if (!capturing)
            {
                opened.Dispose();
                return;
            }
            micCapture = opened;
            sink.Expect(Side.Me);
            Mic = new ServiceStatus(true, "Microphone");
        }
        catch (Exception e) when (e is CaptureException or COMException or InvalidCastException)
        {
            Mic = new ServiceStatus(false, e.Message);
        }
    }

    /// <summary>The call audio: everything the PC plays except Cue's own sound; where Windows has no process loopback, the default speakers' loopback.</summary>
    private async Task OpenCallAudio()
    {
        var why = "";
        foreach (var source in new[] { CaptureSource.CallExcludingCue, CaptureSource.CallEndpoint })
        {
            try
            {
                var opened = await Task.Run(() => Open(source, Side.Others));
                if (!capturing)
                {
                    opened.Dispose();
                    return;
                }
                callCapture = opened;
                sink.Expect(Side.Others);
                Call = new ServiceStatus(true, "Call audio");
                Log.Write(source == CaptureSource.CallExcludingCue
                    ? "🔊 Call audio: everything the PC plays except Cue's own sound"
                    : $"🔊 Call audio: the default speakers, Cue's own sound included ({why})");
                return;
            }
            catch (Exception e) when (e is CaptureException or COMException or InvalidCastException)
            {
                why = e.Message;
            }
        }
        if (capturing) Call = new ServiceStatus(false, why.StartsWith("No ", StringComparison.Ordinal) ? why : $"No access to call audio — {why}");
    }

    private WasapiCapture Open(CaptureSource source, Side side)
    {
        var capture = new WasapiCapture(source);
        capture.OnSamples = (samples, time) => Samples?.Invoke(side, samples, time);
        capture.OnStopped = why => state.Queue.TryEnqueue(() =>
        {
            if (side == Side.Me) Mic = new ServiceStatus(false, $"Microphone stopped: {why}");
            else Call = new ServiceStatus(false, $"Call audio stopped: {why}");
        });
        capture.Start();
        return capture;
    }

    // MARK: Rehearsal

    /// <summary>Rehearsal mode: CUE_REHEARSE_PARTICIPANT=/path/to/audio plays a recording as the call, CUE_REHEARSE_ME another as your microphone.</summary>
    private void StartRehearsalIfRequested()
    {
        if (Env.Get("CUE_REHEARSE_PARTICIPANT") is not { } path || rehearsalStarted) return;
        rehearsalStarted = true;
        // A rehearsal is a run-through of the talk: it starts Cue as soon as someone is signed in.
        void StartOnceSignedIn(object? sender, PropertyChangedEventArgs e)
        {
            if (e.PropertyName != nameof(CueApi.Phase) || Api.Phase != Phase.SignedIn) return;
            Api.PropertyChanged -= StartOnceSignedIn;
            // The projects were loaded and one chosen before `Phase` was set (CueApi.OnSignedIn): hop to the next turn, when it is.
            state.Queue.TryEnqueue(StartListening);
        }
        Api.PropertyChanged += StartOnceSignedIn;
        _ = Rehearse(path);
    }

    private async Task Rehearse(string participant)
    {
        // Nothing is heard before someone is signed in (and Cue running, which signing in starts for a rehearsal), and the call's socket is up
        // with Claude, the judge and speech recognition warm: the first question is answered as in a real talk.
        while (!callConnected || !claude.Ok || !speech.Ok || judgeState == JudgeState.Starting || !Api.IsSignedIn || !CueRunning)
            await Task.Delay(300);
        try
        {
            // CUE_REHEARSE_RECORD=1 also records the rehearsal and writes its notes.
            var record = Env.Get("CUE_REHEARSE_RECORD") == "1";
            if (record) StartRecording(RecordingTrigger.Rehearsal);
            // Play returns the length in seconds, which a recorded rehearsal waits for.
            var length = Rehearsal.Play(participant, (samples, time) => Samples?.Invoke(Side.Others, samples, time));
            // CUE_REHEARSE_ME plays a second recording as your microphone, in parallel.
            if (Env.Get("CUE_REHEARSE_ME") is { } mine) length = Math.Max(length, Rehearsal.Play(mine, (samples, time) => Samples?.Invoke(Side.Me, samples, time)));
            if (record)
            {
                await Task.Delay(TimeSpan.FromSeconds(length + 1));
                StopRecording(RecordingTrigger.Rehearsal);
            }
        }
        catch (Exception e) when (e is IOException or InvalidDataException or UnauthorizedAccessException)
        {
            Call = new ServiceStatus(false, $"Rehearsal file: {e.Message}");
        }
    }

    // MARK: The live call

    /// <summary>
    /// Makes a call for the active project and connects to it; whatever call there was ends first. The server reads the project's materials, warms
    /// Claude and opens the speech streams, and says how that goes in `status` events.
    /// </summary>
    private void StartCall()
    {
        EndCall();
        var generation = callGeneration;
        if (ActiveProject is not { } project || project.ServerId is not { } serverId)
        {
            var detail = ActiveProject is null ? "No project" : "Waiting for the project to reach your account";
            Claude = new ServiceStatus(false, detail);
            Speech = new ServiceStatus(false, detail);
            return;
        }
        callProjectId = serverId;
        HeardLanguage = null;
        Claude = new ServiceStatus(false, "Warming up Claude…", true);
        Speech = new ServiceStatus(false, "Starting speech recognition…", true);
        _ = MakeCall(serverId, generation);
    }

    private async Task MakeCall(string projectId, int generation)
    {
        try
        {
            var info = await Api.CreateCall(projectId, Prefs.SpeakerName, Prefs.AutoAnswer, Prefs.MicQuestions, CueRunning);
            if (generation != callGeneration)
            {
                await Api.EndCall(info.CallId);
                return;
            }
            var made = new LiveCall(Api, info, sink)
            {
                OnEvent = Handle,
                OnTrouble = trouble => Log.Write($"{SessionLog.Warning} The live call's connection: {trouble}"),
            };
            var id = info.CallId;
            made.OnGone = why => CallEnded(id, why);
            Log.Write("📞 Live call started");
            liveCall = made;
            SendConfig();
            foreach (var command in heldCommands) made.Send(command);
            heldCommands.Clear();
            made.Connect();
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            if (generation != callGeneration) return;
            Claude = new ServiceStatus(false, e.Message);
            Speech = new ServiceStatus(false, e.Message);
            if (e is CueApiException { Kind: CueApiError.LimitReached }) state.ReachedLimit(e.Message);
            else Log.Write($"{SessionLog.Warning} Couldn't start the live call: {e.Message}");
        }
    }

    /// <summary>Ends the call, if there is one: the server closes its speech streams and keeps the transcript.</summary>
    private void EndCall(bool tellServer = true)
    {
        callGeneration++;
        callProjectId = null;
        speaking.Clear();
        callConnected = false;
        heldCommands.Clear();
        unlogged.Clear();
        judgeState = JudgeState.Starting;
        speechUnavailable = false;
        Claude = ServiceStatus.Idle;
        Speech = ServiceStatus.Idle;
        if (liveCall is not { } ending) return;
        liveCall = null;
        ending.Close();
        if (tellServer) _ = Api.EndCall(ending.Id);
    }

    /// <summary>The server has no more to say about the call (it ended, or no longer knows it). While Cue still listens, a new call takes over.</summary>
    private void CallEnded(string id, string why)
    {
        if (liveCall?.Id != id) return;
        EndCall();
        Log.Write($"{SessionLog.Warning} The live call stopped: {why}");
        if (!capturing || callRestarts >= 3) return;
        callRestarts++;
        var generation = callGeneration;
        state.Queue.TryEnqueue(async () =>
        {
            await Task.Delay(TimeSpan.FromSeconds(2));
            if (generation == callGeneration && capturing) StartCall();
        });
    }

    /// <summary>The tray's Restart Live Call.</summary>
    public void RestartCall()
    {
        callRestarts = 0;
        if (capturing) StartCall();
    }

    /// <summary>The settings the server follows while it listens for questions.</summary>
    private void SendConfig() =>
        liveCall?.Send(new Dictionary<string, object?>
        {
            ["type"] = "config",
            ["speaker"] = Prefs.SpeakerName,
            ["auto"] = Prefs.AutoAnswer,
            ["micQuestions"] = Prefs.MicQuestions,
            ["questions"] = CueRunning,
        });

    /// <summary>A command for the call; held when the call is still being made, dropped when there is none to come.</summary>
    private void SendCommand(Dictionary<string, object?> command)
    {
        if (liveCall is not null) liveCall.Send(command);
        else if (capturing) heldCommands.Add(command);
    }

    // MARK: Asking

    /// <summary>The "answer now" hot key: the server takes what the participants are saying right now, else their last line, and answers its questions each
    /// on its own (or all of it when it holds none).</summary>
    public void AnswerNow() => SendCommand(new Dictionary<string, object?> { ["type"] = "answerNow" });

    /// <summary>The Ask field: this question, answered now.</summary>
    public void Ask(string question)
    {
        if (!Api.IsSignedIn || question.Length == 0) return;
        SendCommand(new Dictionary<string, object?> { ["type"] = "ask", ["text"] = question });
    }

    /// <summary>Prepare Answer on questions noticed with Auto off.</summary>
    public void Prepare(Guid id)
    {
        var exchange = exchanges.FirstOrDefault(e => e.Id == id);
        if (exchange is null) return;
        SendCommand(new Dictionary<string, object?> { ["type"] = "prepare", ["exchange"] = exchange.ServerId });
        foreach (var answer in exchange.Answers.Where(answer => !answer.Requested))
        {
            answer.Requested = true;
            answer.AskedAt = DateTime.Now;
            unlogged.Add(answer.QuestionId);
            LogQuestion(answer.QuestionId);
        }
        Expand(id);
    }

    // MARK: What the live call says

    private void Handle(CallEvent e)
    {
        switch (e.Type)
        {
            case "ready":
                callConnected = true;
                callRestarts = 0;
                break;
            case "status":
                StatusChanged(e);
                break;
            case "speaking":
                if (e.Lane is not { } lane) return;
                var active = e.Active ?? false;
                speaking[lane] = active;
                if (active) SpeechStarted(lane);
                else if (partial.GetValueOrDefault(lane) == "") partial.Remove(lane);
                break;
            case "transcript.partial":
                if (e.Lane is { } side && !string.IsNullOrEmpty(e.Text)) partial[side] = e.Text;
                break;
            case "transcript.final":
                UtteranceFinished(e);
                break;
            case "question":
                QuestionAsked(e);
                break;
            case "prepared":
                PreparedFound(e);
                break;
            case "answer.delta":
                state.ClearPlanLimit();
                if (e.QuestionId is { } deltaId && e.Text is { } text) AppendDelta(deltaId, text);
                break;
            case "answer.done":
                if (e.QuestionId is { } doneId) Finish(doneId, e.Error);
                break;
            case "language":
                if (e.Language is { } code && code != heardLanguage)
                {
                    HeardLanguage = code;
                    // The language the call starts out in is said at once, as not heard yet: only a heard one is news.
                    if (e.Heard != false) Log.Write($"🌐 Language heard: {e.Name ?? code}");
                }
                break;
            case "error":
                if (e.Code == "limit_reached") state.ReachedLimit(e.Message ?? "You've reached your Cue plan's limit for this month.");
                else Log.Write($"{SessionLog.Warning} {e.Message ?? "The live call had a problem"}");
                break;
        }
        Touch();
    }

    /// <summary>What the server says about Claude, the question judge and speech recognition, in the words the session log has always used.</summary>
    private void StatusChanged(CallEvent e)
    {
        string phase = e.State ?? "", detail = e.Detail ?? "";
        var status = new ServiceStatus(phase == "ready", detail, phase == "starting");
        switch (e.Part)
        {
            case "claude":
                Claude = status;
                break;
            case "speech":
                Speech = status;
                if (phase == "unavailable")
                {
                    speechUnavailable = true;
                    Log.Write($"{SessionLog.Warning} Speech recognition unavailable: {detail}");
                }
                else if (phase == "ready" && speechUnavailable)
                {
                    speechUnavailable = false;
                    Log.Write("🗣 Speech recognition ready again: Cue plan");
                }
                break;
            case "judge":
                switch (phase)
                {
                    case "ready":
                        if (judgeState != JudgeState.Ready) Log.Write("🧐 Question judge ready: Claude Haiku");
                        judgeState = JudgeState.Ready;
                        break;
                    case "unavailable":
                        if (judgeState != JudgeState.Unavailable) Log.Write($"{SessionLog.Warning} Question judge unavailable ({detail}) — going by question marks");
                        judgeState = JudgeState.Unavailable;
                        break;
                    default:
                        judgeState = JudgeState.Starting;
                        break;
                }
                break;
        }
    }

    private void SpeechStarted(Side side)
    {
        partial[side] = "";
        // With speakers instead of headphones the mic also hears the call; don't mistake that for the user.
        if (side != Side.Me || speaking.GetValueOrDefault(Side.Others)) return;
        presenterSpoke = DateTime.Now;
        if (reading == Reading.NotYet && expandedId is not null) reading = Reading.Reading;
    }

    /// <summary>The server's times count from when the call began; the transcript's lines are stamped with the clock.</summary>
    private void UtteranceFinished(CallEvent e)
    {
        if (e.Lane is not { } side) return;
        partial.Remove(side);
        if (string.IsNullOrEmpty(e.Text)) return;
        var origin = liveCall?.StartedAt ?? DateTime.Now;
        var started = origin.AddSeconds(e.Start ?? 0);
        var ended = origin.AddSeconds(e.End ?? e.Start ?? 0);
        // `e.Speaker` (the live recognizer's guess at the voice) is not used: the notes' Workflow tells the voices apart in the recording.
        var utterance = new Utterance(side, e.Text, started, ended > started ? ended : started);
        utterances.Add(utterance);
        Recorder.Add(utterance);
        if (utterances.Count > 300) utterances.RemoveRange(0, utterances.Count - 300);
        Log.Write($"**[{PromptLabel(side)}]** {e.Text}", utterance.Time);
    }

    private string PromptLabel(Side side) => side == Side.Me ? (Prefs.SpeakerName.Length == 0 ? "Speaker" : Prefs.SpeakerName) : "Participant";

    /// <summary>
    /// A question the server noticed (or was asked): the exchange it belongs to gets it, and once the exchange is whole it takes its place in the list.
    /// Asked for by the user: shown at once. Noticed by Cue: it waits as a row until it's a real answer, or under the button while the view is held or the
    /// speaker reads the answer in view.
    /// </summary>
    private void QuestionAsked(CallEvent e)
    {
        if (e.Id is not { } questionId || e.Exchange is not { } exchangeId || e.Text is not { } text) return;
        var requested = e.Requested ?? true;
        var answer = new Answer
        {
            QuestionId = questionId,
            Question = text,
            Opener = e.Opener,
            Requested = requested,
            Part = e.Index ?? 0,
            Parts = e.Of ?? 1,
        };
        var exchange = exchanges.FirstOrDefault(x => x.ServerId == exchangeId);
        if (exchange is null)
        {
            exchange = new Exchange { ServerId = exchangeId };
            exchanges.Add(exchange);
        }
        exchange.Answers.Add(answer);
        if (requested) unlogged.Add(questionId);
        else Log.Write($"❔ **Question (Auto is off):** {text}");
        if (exchange.Answers.Count < answer.Parts) return;
        if (e.Forced == true) Expand(exchange.Id);
        else if (holding || listScrolled) unseen.Add(exchange.Id);
        else if (reading == Reading.Reading) Hold(exchange.Id);
    }

    /// <summary>The prepared answer that matches a question.</summary>
    private void PreparedFound(CallEvent e)
    {
        if (e.QuestionId is not { } id) return;
        var (_, answer) = Position(id);
        if (answer is null) return;
        answer.Prepared = new PreparedAnswer(e.Question ?? "", e.Answer ?? "", e.Who, e.Source ?? "");
        answer.PreparedScore = e.Score ?? 0;
        LogQuestion(id);
    }

    /// <summary>The line for a question being answered, once (it says which prepared answer matched, which the server sends right after the question).</summary>
    private void LogQuestion(string id)
    {
        if (!unlogged.Remove(id)) return;
        var (_, answer) = Position(id);
        if (answer is null) return;
        var of = answer.Parts > 1 ? $" _({answer.Part + 1} of {answer.Parts})_" : "";
        var match = answer.Prepared is null ? "" : $" _(prepared match {(int)(answer.PreparedScore * 100)}%)_";
        Log.Write($"❓ **Question:** {answer.Question}{of}{match}");
    }

    /// <summary>The user opens an exchange (a click, the arrow hot keys). An older one holds the view: new questions wait under the "new questions" button
    /// until the user goes back to the newest.</summary>
    public void Expand(Guid id)
    {
        var index = exchanges.FindIndex(e => e.Id == id);
        if (index < 0) return;
        selected = index;
        expandedId = id;
        seen.Add(id);
        reading = Reading.NotYet;
        heldWhileReading.Clear();
        holding = index < exchanges.Count - 1;
        unseen.Remove(id);
        if (!holding) unseen.Clear();
        Touch();
    }

    /// <summary>The "new questions" button: the newest, and new questions come into view again.</summary>
    public void ShowNewest()
    {
        if (exchanges.Count > 0) Expand(exchanges[^1].Id);
    }

    /// <summary>The previous or next exchange (the arrow hot keys).</summary>
    public void Step(int delta)
    {
        if (exchanges.Count == 0) return;
        Expand(exchanges[Math.Clamp(selected + delta, 0, exchanges.Count - 1)].Id);
    }

    /// <summary>Cue brings an exchange into view by itself, unless the user holds the view on another one or reads the one in view aloud.</summary>
    private void Reveal(int index)
    {
        var id = exchanges[index].Id;
        if (id == expandedId) return;
        if (holding || listScrolled)
        {
            unseen.Add(id);
            return;
        }
        if (reading == Reading.Reading)
        {
            Hold(id);
            return;
        }
        selected = index;
        expandedId = id;
        seen.Add(id);
        reading = Reading.NotYet;
    }

    /// <summary>Keeps a new exchange in the New group, under the answer the speaker reads aloud.</summary>
    private void Hold(Guid id)
    {
        if (!heldWhileReading.Add(id) || exchanges.FirstOrDefault(e => e.Id == id) is not { } exchange) return;
        Log.Write($"📖 Waits while you read the answer in view: {string.Join(" / ", exchange.Answers.Select(a => a.Question))}");
    }

    /// <summary>
    /// The speaker paused for a few seconds after reading: what came in meanwhile shows, the newest answer under way in full. Checked every tick of the
    /// level meters, which also notes that they're still talking (their utterance isn't transcribed yet when it ends).
    /// </summary>
    private void CheckReading()
    {
        if (reading != Reading.Reading) return;
        if (speaking.GetValueOrDefault(Side.Me) && !speaking.GetValueOrDefault(Side.Others))
        {
            presenterSpoke = DateTime.Now;
            return;
        }
        if (DateTime.Now - presenterSpoke < ReadingPause) return;
        reading = Reading.Done;
        var held = heldWhileReading.ToHashSet();
        heldWhileReading.Clear();
        if (held.Count == 0 || holding || listScrolled) return;
        var index = exchanges.FindLastIndex(e => held.Contains(e.Id) && e.Answers.Any(a => a.IsUnderWay));
        if (index < 0) return;
        Log.Write($"📖 Shown now that you've paused: {string.Join(" / ", exchanges[index].Answers.Select(a => a.Question))}");
        Reveal(index);
        Touch();
    }

    private (int Exchange, Answer? Answer) Position(string questionId)
    {
        for (var index = 0; index < exchanges.Count; index++)
        {
            var found = exchanges[index].Answers.FirstOrDefault(answer => answer.QuestionId == questionId);
            if (found is not null) return (index, found);
        }
        return (-1, null);
    }

    private void AppendDelta(string id, string text)
    {
        LogQuestion(id);
        var (index, answer) = Position(id);
        if (answer is null) return;
        answer.FirstTokenAt ??= DateTime.Now;
        answer.Text += text;
        // The first words of a real answer (not "—") bring it into view, unless a newer one is there.
        var shown = exchanges.FindIndex(e => e.Id == expandedId);
        if (answer.IsUnderWay && (shown < 0 || shown < index)) Reveal(index);
    }

    private void Finish(string id, string? error)
    {
        LogQuestion(id);
        var (index, answer) = Position(id);
        if (answer is null) return;
        answer.Done = true;
        answer.Error = error;
        var first = answer.FirstTokenAt is { } at ? string.Create(CultureInfo.InvariantCulture, $"first word {(at - answer.AskedAt).TotalSeconds:F1} s, ") : "";
        var total = (DateTime.Now - answer.AskedAt).TotalSeconds.ToString("F1", CultureInfo.InvariantCulture);
        Log.Write($"💬 **Answer** ({first}done {total} s):\n\n{(error is null ? answer.Text : $"{SessionLog.Warning} {error}")}\n");
        // Organisational remarks come back as "—": they stay in the list as a dimmed row, and the answer in view stays. A first question that fails
        // still shows why.
        if (exchanges[index].IsNotAQuestion) unseen.Remove(exchanges[index].Id);
        else if (expandedId is null && !answer.IsNotAQuestion) Reveal(index);
    }

    // MARK: Test hooks

    /// <summary>CUE_CONTROL commands of the live call (AGENTS.md › Test hooks in the app).</summary>
    private void RegisterControl()
    {
        var control = state.Control;
        control.Register("start", argument =>
        {
            if (state.Projects.FindByName(argument) is { } project) StartCue(project);
            return Task.CompletedTask;
        });
        control.Register("stop", _ =>
        {
            StopCue();
            return Task.CompletedTask;
        });
        control.Register("project", argument =>
        {
            if (state.Projects.FindByName(argument) is { } project) Activate(project);
            return Task.CompletedTask;
        });
        control.Register("ask", argument =>
        {
            Ask(argument);
            return Task.CompletedTask;
        });
        control.Register("show", argument =>
        {
            if (exchanges.LastOrDefault(e => e.Answers.Any(a => a.Question.Contains(argument, StringComparison.CurrentCultureIgnoreCase))) is { } found)
                Expand(found.Id);
            return Task.CompletedTask;
        });
        control.Register("newest", _ =>
        {
            ShowNewest();
            return Task.CompletedTask;
        });
        control.Register("prepare", _ =>
        {
            if (exchanges.LastOrDefault(e => e.Waiting) is { } waiting) Prepare(waiting.Id);
            return Task.CompletedTask;
        });
    }
}
