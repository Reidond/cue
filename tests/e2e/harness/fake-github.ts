// A stand-in for GitHub's releases, served on 127.0.0.1 from the case's own process: what Cue's updater reads (CUE_UPDATE_URL is the address of
// the latest release) and what it downloads.
//
//   /repos/Reidond/cue/releases/latest    the latest release, as GitHub's REST API has it: its tag, and its files with size, digest and download URL
//   /download/vVERSION/NAME               a file of a release
//
// Nothing is faked past that: Cue checks, unpacks and installs what it downloads for real.
import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename } from 'node:path';

export interface FakeRelease {
    /** "99.0.0": the tag is "v99.0.0". */
    version: string;
    /** The files of the release (the zip, the MSIs), by their paths: each is served by its name. */
    files: string[];
    /** Give each file a digest that isn't its own, as a download that was changed on the way would look. */
    wrongDigest?: boolean;
}

export interface FakeReleases {
    /** CUE_UPDATE_URL: the latest release's address. */
    url: string;
    /** Makes this the latest release (until now there is none: GitHub answers 404). */
    publish(release: FakeRelease): Promise<void>;
    /** Every request, oldest first, as `GET /path`. */
    readonly requests: string[];
    close(): Promise<void>;
}

interface Served {
    name: string;
    path: string;
    size: number;
    digest: string;
}

function sha256(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        createReadStream(path)
            .on('data', (chunk) => hash.update(chunk))
            .on('end', () => resolve(hash.digest('hex')))
            .on('error', reject);
    });
}

export async function startFakeReleases(): Promise<FakeReleases> {
    let latest: { version: string; files: Served[] } | undefined;
    const requests: string[] = [];

    const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        requests.push(`${request.method ?? 'GET'} ${url.pathname}`);
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

        if (url.pathname === '/repos/Reidond/cue/releases/latest') {
            if (!latest) {
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ message: 'Not Found' }));
                return;
            }
            const tag = `v${latest.version}`;
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(
                JSON.stringify({
                    tag_name: tag,
                    name: `Cue ${latest.version}`,
                    draft: false,
                    prerelease: false,
                    html_url: `${base}/releases/tag/${tag}`,
                    assets: latest.files.map((file) => ({
                        name: file.name,
                        size: file.size,
                        digest: `sha256:${file.digest}`,
                        content_type: file.name.endsWith('.msi') ? 'application/x-msi' : 'application/zip',
                        browser_download_url: `${base}/download/${tag}/${file.name}`,
                    })),
                }),
            );
            return;
        }

        const file = latest?.files.find((served) => url.pathname === `/download/v${latest?.version}/${served.name}`);
        if (!file) {
            response.writeHead(404);
            response.end();
            return;
        }
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(file.size) });
        createReadStream(file.path).pipe(response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    return {
        url: `http://127.0.0.1:${port}/repos/Reidond/cue/releases/latest`,
        async publish(release: FakeRelease): Promise<void> {
            const files = await Promise.all(
                release.files.map(async (path) => {
                    const digest = await sha256(path);
                    return {
                        name: basename(path),
                        path,
                        size: statSync(path).size,
                        digest: release.wrongDigest ? createHash('sha256').update(digest).digest('hex') : digest,
                    };
                }),
            );
            latest = { version: release.version, files };
        },
        requests,
        close: () =>
            new Promise<void>((resolve) => {
                // Cue keeps its connection open: without this, closing waits for it.
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}
