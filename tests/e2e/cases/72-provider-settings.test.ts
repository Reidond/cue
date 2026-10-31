import {
    ANTHROPIC,
    assertContains,
    assertNotContains,
    e2eCase,
    FAKE_KEYS,
    literal,
    needWindowSnapshots,
    ocr,
    skip,
} from '../harness/index.ts';

e2eCase(
    'Settings › Providers offers Claude Code or the Anthropic API and Whisper or Deepgram, shows a saved key ' +
        'as kept in the keychain without showing it, and asks for a key when a cloud provider has none.',
    async (cue) => {
        needWindowSnapshots();
        if (ANTHROPIC !== 'fake') skip("would show the real key's place; the stand-in's is enough");

        await cue.defaults('claudeProvider', 'anthropicAPI');
        await cue.apiKey('anthropic');
        await cue.launch({ CUE_SNAPSHOT: cue.path('cue.png') });
        cue.control('settings providers');
        const png = cue.path('cue-settings.png');
        const providers = cue.save('providers.txt', await cue.snapshotText(png));
        assertContains(providers, /Claude Code/);
        assertContains(providers, /Anthropic API/);
        assertContains(providers, /Whisper on this Mac/);
        assertContains(providers, /Deepgram/);
        assertContains(providers, /In your keychain/);
        assertNotContains(providers, new RegExp(literal(FAKE_KEYS.anthropic).slice(0, 12)), 'the key itself is never shown');

        // Deepgram has no key yet: its field asks for one.
        cue.control('provider deepgram');
        let deepgram = '';
        await cue.waitFor('the Deepgram key field', 20, async () => /Paste your key/i.test((deepgram = await ocr(png))));
        assertContains(cue.save('deepgram.txt', deepgram), /Get a key/);
    },
);
