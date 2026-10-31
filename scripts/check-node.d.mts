// Types for check-node.mjs, which stays plain JavaScript so it runs before
// any install, on whatever Node the machine has.
export const nodeMismatches: (files: Map<string, string>) => string[];
