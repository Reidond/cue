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
export { afinfo, audioLength, audioSync, dialogue, excerpt, silence, speech, type Dialogue } from './audio.ts';
export { e2eCase } from './case.ts';
export { DEEPGRAM, FIXTURES, fixture } from './config.ts';
export { makeDocx, makePdf, makePptx, writeFile } from './documents.ts';
export { FAKE_KEYS, type AnthropicRequest, type DeepgramRequest, type MarkdownRequest } from './fake-providers.ts';
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
export { bursts, LiveClient, pcmOf, startCall, type StartedCall } from './live.ts';
export { labelsOf, summaryOf, turnSpeakers } from './notes.ts';
export { exec, shellQuote, type Ran } from './process.ts';
export {
    needOverlaySnapshots,
    needReachable,
    needRealDeepgram,
    needVoice,
    needWhisper,
    needWhisperCli,
    needWindowSnapshots,
} from './requirements.ts';
export { fail, print, skip } from './results.ts';
export { Account, AdminClient, Backend, type AccountMaterial, type AccountProject, type BackendOptions } from './backend.ts';
export { AdminPage, browser, closeBrowser } from './browser.ts';
export { type FakeIdp } from './fake-idp.ts';
export { Cue, SPEAKER_FILES, type CalendarEvent, type ClaudeRequest } from './sandbox.ts';
export { appWindows, ocr, type AppWindows } from './screen.ts';
export { minutesFromNow, sleep, tomorrowAt } from './time.ts';
