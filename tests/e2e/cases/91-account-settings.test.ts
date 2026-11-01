import { assertContains, e2eCase, needWindowSnapshots } from '../harness/index.ts';

e2eCase('Settings › Account shows who is signed in, the plan and the usage this month, with Sign Out.', async (cue) => {
    needWindowSnapshots();
    await cue.launch({ CUE_SNAPSHOT: cue.path('cue.png') });
    cue.control('settings account');
    let shown = '';
    await cue.waitFor('the Account tab to show the email', 30, async () => {
        shown = await cue.snapshotText(cue.path('cue-settings.png'));
        return shown.includes(cue.email);
    });
    const account = cue.save('account.txt', shown);
    assertContains(account, /Signed in as/);
    assertContains(account, new RegExp(cue.email.replace(/[.]/g, '\\.')));
    assertContains(account, /Plan/);
    assertContains(account, /Used this month/);
    assertContains(account, /\$0\.00/);
    assertContains(account, /Monthly limit/);
    assertContains(account, /Sign Out/);
});
