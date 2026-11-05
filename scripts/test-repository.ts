import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The folder the repository's checks are in. */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The test's environment with every `GIT_` variable dropped and git's global and system config
 * shut off, so a check run in a repository of its own is not pointed at the real one by a hook's
 * variables or changed by the user's settings.
 */
export const isolated = (): NodeJS.ProcessEnv => ({
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
});

/** What a check printed and how it ended. */
export interface Ran {
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

/**
 * Runs a check from the `scripts` folder of a throwaway repository, with the tracked files added
 * to git's index and the untracked ones left for git to find. The check and `repository.mjs` are
 * copied into that folder, since a check reads the repository its own file sits in, and so they
 * are also untracked files there that it reads like any other.
 */
export const runCheckIn = (
    script: string,
    tracked: Record<string, string>,
    untracked: Record<string, string> = {}
): Ran => {
    const root = mkdtempSync(join(tmpdir(), 'repository-check-'));
    const options = { cwd: root, env: isolated(), timeout: 10_000 };
    const write = (files: Record<string, string>): void => {
        for (const [path, text] of Object.entries(files)) {
            mkdirSync(dirname(join(root, path)), { recursive: true });
            writeFileSync(join(root, path), text);
        }
    };
    try {
        execFileSync('git', ['init', '--quiet'], options);
        write(tracked);
        execFileSync('git', ['add', '--all'], options);
        write(untracked);
        mkdirSync(join(root, 'scripts'), { recursive: true });
        for (const copied of [script, 'repository.mjs']) {
            copyFileSync(join(HERE, copied), join(root, 'scripts', copied));
        }
        const result = spawnSync(process.execPath, [script], {
            ...options,
            cwd: join(root, 'scripts'),
            encoding: 'utf8',
        });
        return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
};
