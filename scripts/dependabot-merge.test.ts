// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { decide } from './dependabot-merge.mjs';

/** One updated dependency as Dependabot's metadata names it, a development patch from a group. */
const update = (overrides: Record<string, unknown> = {}) => ({
    dependencyName: 'vitest',
    dependencyType: 'direct:development',
    updateType: 'version-update:semver-patch',
    packageEcosystem: 'npm_and_yarn',
    dependencyGroup: 'npm',
    ...overrides,
});

const script = fileURLToPath(new URL('./dependabot-merge.mjs', import.meta.url));

describe('the Dependabot merge decision', () => {
    it('merges a development patch or minor, and a runtime patch', () => {
        expect(decide([update()]).merge).toBe(true);
        expect(decide([update({ updateType: 'version-update:semver-minor' })]).merge).toBe(true);
        expect(decide([update({ dependencyType: 'direct:production' })]).merge).toBe(true);
    });

    it('leaves a runtime minor and every major to a person', () => {
        const runtimeMinor = update({
            dependencyType: 'direct:production',
            updateType: 'version-update:semver-minor',
        });
        expect(decide([runtimeMinor]).merge).toBe(false);
        expect(decide([update({ updateType: 'version-update:semver-major' })]).merge).toBe(false);
        expect(
            decide([
                update({
                    dependencyType: 'direct:production',
                    updateType: 'version-update:semver-major',
                }),
            ]).merge
        ).toBe(false);
    });

    it('leaves a whole group to a person when one update in it does not qualify', () => {
        const runtimeMinor = update({
            dependencyName: 'react',
            dependencyType: 'direct:production',
            updateType: 'version-update:semver-minor',
        });
        const decision = decide([update(), update({ dependencyName: 'eslint' }), runtimeMinor]);
        expect(decision.merge).toBe(false);
        expect(decision.reason).toContain('react');
    });

    it('leaves an update from no group to a person, since a security update comes that way', () => {
        expect(decide([update({ dependencyGroup: '' })]).merge).toBe(false);
        expect(decide([update({ dependencyGroup: undefined })]).merge).toBe(false);
    });

    it('leaves an indirect dependency, and one of unknown kind, to a person', () => {
        expect(decide([update({ dependencyType: 'indirect' })]).merge).toBe(false);
        expect(decide([update({ dependencyType: undefined })]).merge).toBe(false);
    });

    it('leaves an action, or any ecosystem but npm, to a person', () => {
        expect(decide([update({ packageEcosystem: 'github_actions' })]).merge).toBe(false);
        expect(decide([update({ packageEcosystem: 'docker' })]).merge).toBe(false);
    });

    it('leaves an update of unknown size to a person', () => {
        expect(decide([update({ updateType: '' })]).merge).toBe(false);
        expect(decide([update({ updateType: undefined })]).merge).toBe(false);
    });

    it('merges nothing from metadata that names no update or is not a list', () => {
        expect(decide([]).merge).toBe(false);
        expect(decide({}).merge).toBe(false);
        expect(decide(null).merge).toBe(false);
        expect(decide([null]).merge).toBe(false);
    });

    it('prints its answer as a step output, and says why', () => {
        const run = (json: string) =>
            spawnSync(process.execPath, [script], {
                encoding: 'utf8',
                env: { ...process.env, UPDATED_DEPENDENCIES: json },
            });
        const yes = run(JSON.stringify([update()]));
        expect(yes.status).toBe(0);
        expect(yes.stdout).toBe('merge=true\n');
        expect(yes.stderr).not.toBe('');
        const no = run(JSON.stringify([update({ updateType: 'version-update:semver-major' })]));
        expect(no.status).toBe(0);
        expect(no.stdout).toBe('merge=false\n');
        expect(no.stderr).toContain('vitest');
        expect(run('not json').stdout).toBe('merge=false\n');
        expect(run('').stdout).toBe('merge=false\n');
    });
});
