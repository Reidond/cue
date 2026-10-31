import { OAUTH } from '@cue/contract';
import type { Provider } from './auth.ts';

// The two pages of the sign-in, server-rendered: no script, no assets, light and dark by the system.

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, status = 200): Response {
    return new Response(
        `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
main { width: min(24rem, 100vw - 3rem); text-align: center; }
h1 { font-size: 1.5rem; margin: 0 0 .5rem; }
p { color: GrayText; margin: 0 0 1.5rem; }
a.button { display: block; margin: .5rem 0; padding: .7rem 1rem; border-radius: .6rem; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
  color: CanvasText; text-decoration: none; font-weight: 500; }
a.button:hover, a.button:focus-visible { background: color-mix(in srgb, CanvasText 8%, transparent); }
a.button.primary { background: AccentColor; border-color: AccentColor; color: AccentColorText; }
</style>
</head>
<body><main>
${body}
</main></body>
</html>`,
        { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
    );
}

const PROVIDER_TITLES: Record<Provider, string> = { google: 'Google', github: 'GitHub' };

/** `/login`: where the authorization endpoint sends someone who isn't signed in. `resume` is its query, which each button carries on. */
export function signInPage(resume: URLSearchParams, providers: readonly Provider[]): Response {
    const buttons = providers
        .map(
            (provider) =>
                `<a class="button" data-provider="${provider}" href="/login/${provider}?${escapeHtml(resume.toString())}">Continue with ${PROVIDER_TITLES[provider]}</a>`,
        )
        .join('\n');
    return page(
        'Sign in to Cue',
        `<h1>Sign in to Cue</h1>
<p>Cue is invite-only. Use the Google or GitHub account your invitation went to.</p>
${buttons}`,
    );
}

/** `/invite-only`: the person signed in with the identity provider but isn't on the list (or the provider didn't verify their email). */
export function inviteOnlyPage(error: string | null, email: string | null): Response {
    if (error !== 'not_invited') {
        return page(
            'Cue sign-in failed',
            `<h1>Sign-in failed</h1><p>Something went wrong signing you in. Close this window and try again.</p>`,
            400,
        );
    }
    const back = new URL(OAUTH.macRedirectUri);
    back.searchParams.set('error', 'access_denied');
    back.searchParams.set('error_description', 'not_invited');
    if (email) back.searchParams.set('email', email);
    return page(
        'Cue is invite-only',
        `<h1>Cue is invite-only</h1>
<p>${email ? `${escapeHtml(email)} isn't` : `This account isn't`} on the list. Ask whoever runs Cue to invite the email address of your Google or GitHub account.</p>
<a class="button primary" href="${escapeHtml(back.toString())}">Return to Cue</a>`,
        403,
    );
}
