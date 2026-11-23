// Stable assignment of usernames to trial groups.

/**
 * A fraction in [0, 1) derived from `key` (FNV-1a), the same every time. Trials that must
 * split usernames independently of each other prefix the username with their own name.
 */
export function cohortFraction(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index++) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0) / 2 ** 32;
}
