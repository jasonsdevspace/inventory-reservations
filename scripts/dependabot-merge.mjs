/**
 * Decides whether a Dependabot pull request merges by itself once its checks pass.
 *
 * A development dependency moved by a patch or a minor, or a runtime dependency moved by a patch,
 * merges by itself. A runtime minor can change what a visitor gets, and a major or a pinned action
 * can change what the build does, so those wait for a person, as does a security update. Only a
 * pull request from a group qualifies, since the groups in the Dependabot settings apply to version
 * updates alone and nothing else in the metadata tells a security update apart. Every update in
 * the pull request has to qualify, and anything the metadata leaves unsaid counts against it.
 *
 * Run by the Dependabot merge workflow with the metadata as JSON in `UPDATED_DEPENDENCIES`. It
 * prints `merge=true` or `merge=false` for the step's output, and the reason on standard error.
 */
import { isRunDirectly } from './repository.mjs';

/** The update sizes each kind of dependency may merge by itself at. */
const ALLOWED = new Map([
    ['direct:development', new Set(['version-update:semver-patch', 'version-update:semver-minor'])],
    ['direct:production', new Set(['version-update:semver-patch'])],
]);

/**
 * Why one update waits for a person, or nothing when it may merge by itself.
 *
 * @param {unknown} update
 * @returns {string | undefined}
 */
const holdOf = (update) => {
    if (typeof update !== 'object' || update === null)
        return 'an update the metadata does not name';
    const { dependencyName, dependencyType, updateType, packageEcosystem, dependencyGroup } =
        /** @type {Record<string, unknown>} */ (update);
    const name = typeof dependencyName === 'string' ? dependencyName : 'an unnamed dependency';
    if (packageEcosystem !== 'npm_and_yarn') return `${name} is not an npm package`;
    if (typeof dependencyGroup !== 'string' || dependencyGroup === '')
        return `${name} comes from no group, as a security update does`;
    const sizes = typeof dependencyType === 'string' ? ALLOWED.get(dependencyType) : undefined;
    if (!sizes) return `${name} is not a direct development or runtime dependency`;
    if (typeof updateType !== 'string' || !sizes.has(updateType))
        return `${name} is a ${String(dependencyType)} update by ${String(updateType || 'an unknown size')}`;
    return undefined;
};

/**
 * Whether the pull request's updates merge by themselves, and why.
 *
 * @param {unknown} updates
 * @returns {{ merge: boolean, reason: string }}
 */
export const decide = (updates) => {
    if (!Array.isArray(updates) || updates.length === 0)
        return { merge: false, reason: 'The metadata names no update.' };
    const holds = updates.map(holdOf).filter((hold) => hold !== undefined);
    return holds.length === 0
        ? {
              merge: true,
              reason: 'Every update is a development patch or minor, or a runtime patch.',
          }
        : { merge: false, reason: `A person merges this, since ${holds.join(', and ')}.` };
};

/**
 * The metadata read from its JSON, or nothing when it does not parse.
 *
 * @param {string} json
 * @returns {unknown}
 */
const parsed = (json) => {
    try {
        return JSON.parse(json);
    } catch {
        return undefined;
    }
};

const main = () => {
    const { UPDATED_DEPENDENCIES = '' } = process.env;
    const { merge, reason } = decide(parsed(UPDATED_DEPENDENCIES));
    console.error(reason);
    console.log(`merge=${merge}`);
};

if (isRunDirectly(import.meta.url)) main();
