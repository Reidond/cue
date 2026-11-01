import { e2eCase, needWindowSnapshots, sleep } from '../harness/index.ts';

e2eCase('Home shows Sign In first, says plainly when an email is not invited, and returns to it after Sign Out.', async (cue) => {
    needWindowSnapshots();
    const backend = await cue.backend();
    await cue.launch({ CUE_SNAPSHOT: cue.path('cue.png') }, { signIn: false });

    await cue.dashboardPage('home', /Sign in to Cue/);
    await cue.dashboardShows(/Cue is invite-only/);

    backend.idp.approveAs('stranger@cue.test');
    let asked = Date.now();
    cue.control('signin');
    await cue.waitFor('the dashboard to say the email is not invited', 60, () => cue.dashboardShows(/been invited to Cue/, asked));

    await backend.invite(cue.email);
    backend.idp.approveAs(cue.email);
    cue.control('signin');
    await cue.waitLog(/🔑 Signed in to Cue as /, 60);
    await cue.dashboardPage('home', /Create Your First Project/);

    asked = Date.now();
    await sleep(1);
    cue.control('signout');
    await cue.waitFor('the dashboard to go back to the sign-in screen', 30, () => cue.dashboardShows(/Sign in to Cue/, asked));
});
