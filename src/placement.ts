// Where a session's Durable Object is asked to live.
//
// An object is created in the data center nearest the request that first reaches it, and
// its Dexcom polls leave from there. Dexcom's US Share host rate-limits the address
// Workers share, per data center, and it is unknown whether polls arriving from outside
// North America are limited the same way. A fixed share of usernames is hinted to Western
// Europe to find out: compare the 429 rate of `account_location: "usa"` polls between
// `location_hint` values.

/** Share of usernames hinted to `hintedLocation`. */
export const hintedShare = 0.2;
export const hintedLocation: DurableObjectLocationHint = "weur";

/**
 * The location hint for a username's session, if it has one. The same username always
 * gets the same answer. A hint only takes effect when the object is first created, and
 * names a region, not a data center.
 */
export function sessionLocationHint(username: string): DurableObjectLocationHint | undefined {
  // FNV-1a.
  let hash = 0x811c9dc5;
  for (let index = 0; index < username.length; index++) {
    hash = Math.imul(hash ^ username.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0) / 2 ** 32 < hintedShare ? hintedLocation : undefined;
}
