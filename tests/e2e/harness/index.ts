// Everything a case uses (see AGENTS.md › Testing): import it from '../harness/index.ts'.
export {
    assertBetween,
    assertContains,
    assertDeepEq,
    assertEq,
    assertFile,
    assertNotContains,
    assertTextContains,
    assertTextNotContains,
} from './assert.ts';
export { afinfo, audioLength, audioSync, dialogue, excerpt, silence, speech, type Dialogue, type Said } from './audio.ts';
export { e2eCase } from './case.ts';
export { DEEPGRAM, FIXTURES, fixture, IS_WINDOWS } from './config.ts';
export { makeDocx, makePdf, makePptx, writeFile } from './documents.ts';
export {
    FAKE_KEYS,
    type AnthropicRequest,
    type DeepgramFileRequest,
    type DeepgramRequest,
    type MarkdownRequest,
} from './fake-providers.ts';
export {
    countLines,
    exists,
    findFiles,
    isDirectory,
    isFile,
    lines,
    linesOf,
    listDir,
    literal,
    matches,
    nonEmpty,
    readText,
    sameContents,
    sameFile,
    writeExecutable,
} from './files.ts';
export { accountProject, bursts, LiveClient, pcmOf, startCall, type StartedCall } from './live.ts';
export { assertTurnsAt, heardReport, labelsOf, summaryOf, turnSpeakers } from './notes.ts';
export {
    beginUpload,
    getNote,
    makeNotes,
    MIB,
    noteEvents,
    LIVE_SCRIPT,
    recordCall,
    RECORDED_SCRIPT,
    startNotes,
    uploadRecording,
    waitForNote,
    type RecordedCall,
    type UploadOptions,
} from './recordings.ts';
export { buildInstaller, builtInstaller, INSTALLED, installedVersion, listedPrograms, msiexec, nextVersion } from './installer.ts';
export { exec, shellQuote, type Ran } from './process.ts';
export {
    hasAudioOutput,
    needAudioOutput,
    needElevation,
    needInteractiveDesktop,
    needOverlaySnapshots,
    needReachable,
    needRealDeepgram,
    needVoice,
    needWindowSnapshots,
    needWindowsOcr,
} from './requirements.ts';
export { fail, print, skip } from './results.ts';
export { serverSentEvents, type ServerSentEvent } from './sse.ts';
export { Account, AdminClient, Backend, type AccountMaterial, type AccountProject, type BackendOptions } from './backend.ts';
export { AdminPage, browser, closeBrowser } from './browser.ts';
export { type FakeIdp } from './fake-idp.ts';
export { type FakeRelease, type FakeReleases } from './fake-github.ts';
export { Cue, type CalendarEvent, type ClaudeRequest } from './sandbox.ts';
export {
    appWindows,
    captureScreen,
    click,
    clickToast,
    controlsOf,
    expand,
    ocr,
    press,
    pressKeys,
    typeText,
    windowText,
    windowsOf,
    type Area,
    type AppWindows,
    type Control,
    type WindowsOfApp,
} from './screen.ts';
export { clearOfMidnight, minutesFromNow, sleep, tomorrowAt } from './time.ts';
