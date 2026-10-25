import { basename } from 'node:path';
import {
    assertContains, assertEq, assertNotContains, CLAUDE, countLines, dialogue, e2eCase, fail, fixture, needWhisper, skip,
    summaryOf,
} from '../harness/index.ts';

e2eCase('A summary that comments on the transcript anyway loses those parenthetical remarks (the words that give them '
    + 'away are in the lexicons); the rest of it, other parentheses included, stays as written.', async (cue) => {
    needWhisper();
    if (CLAUDE !== 'fake') skip("needs the fake claude's summary");

    await cue.defaults('speakerName', 'Андрій Тест');
    await cue.defaults('autoAnswer', false);
    await cue.project('Звіт', { language: 'uk' });
    const call = await dialogue(fixture('dialogues', 'deadline-uk.txt'), cue.path('call'));
    await cue.launch({
        CUE_PROJECT: 'Звіт', CUE_REHEARSE_RECORD: '1', FAKE_CLAUDE_SUMMARY: fixture('summaries', 'transcript-remarks.md'),
        CUE_REHEARSE_PARTICIPANT: call.wav('call'), CUE_REHEARSE_ME: call.wav('me'),
    });
    await cue.waitLog(/Notes ready/, 180);

    const notes = cue.readyNotes();
    if (!basename(notes).endsWith(" – Звіт до п'ятниці.md")) fail(`the note should be named after the summary: ${basename(notes)}`);
    const summary = cue.save('summary.md', summaryOf(notes));
    assertNotContains(summary, /транскрипт|розпізнано|transcript/, "the summary shouldn't comment on the transcript");
    assertContains(summary, /^Учасниця запитала про звіт щодо узгодженості даних\. Звіт майже готовий, його надішлють до п'ятниці\.$/);
    assertContains(summary, /^- Залишилося перевірити таблиці\.$/);
    assertContains(summary, /^- Рівень узгодженості обговорять на наступній зустрічі\.$/);
    assertNotContains(summary, /^- *$|Примітка/, 'a list item that was only a remark should go');
    assertEq(countLines(summary, /^- [^[]/), 2, 'the two real key points should stay');
    // Parentheses that say something about the call stay, and so does a link.
    assertContains(summary, /^- \[ \] Андрій Тест: надіслати звіт \(до п'ятниці\)$/);
    assertContains(summary, /^- \[ \] Олена: оновити \[таблиці\]\(https:\/\/example\.com\/tables\) \(за потреби\)$/);

    // Each dropped remark is in the session log.
    assertEq(cue.logCount(/🧽 Dropped a remark about the transcript from the summary: /), 4, 'four remarks should be dropped');
    assertContains(cue.sessionLog(), /🧽 Dropped .*: \(у транскрипті — «у згодженості», ймовірно, йдеться про узгодженість\)$/);
});
