// Client account names: the factory creates <name>.<factory> (INTERFACES.md 3), so <name> must be one
// part of a NEAR account id, and the whole id must fit NEAR's 64 characters.

const NAME = /^([a-z\d]+[-_])*[a-z\d]+$/;
const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** Any NEAR account id: a receiver for a withdrawal, say. */
export function isAccountId(id: string): boolean {
  return ACCOUNT_ID.test(id);
}

export function accountIdFor(name: string, factory: string): string {
  return `${name}.${factory}`;
}

/** What is wrong with a name, in words, or null if the factory can use it. */
export function nameProblem(name: string, factory: string): string | null {
  if (!name) return 'Pick a name';
  if (name.includes('.')) return 'No dots: the name is one part, before .' + factory;
  if (!NAME.test(name)) return 'Use lowercase letters and digits, with - or _ only between them';
  if (accountIdFor(name, factory).length > 64) return `Too long: ${name}.${factory} must be at most 64 characters`;
  return null;
}

/** The 32 characters a random name is drawn from: base32's, so 5 bits each. */
const NAME_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const RANDOM_NAME_LENGTH = 10;

/**
 * INTERFACES.md 48.6: a new account's name says nothing about its owner. 10 characters from a to z and 2 to 7, out of
 * the browser's `crypto.getRandomValues`: about 50 bits, so a clash isn't a practical worry, and the factory refuses
 * a taken name anyway. It always passes `nameProblem`. `fill` is for tests.
 */
export function randomName(fill: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)): string {
  let name = '';
  for (const byte of fill(new Uint8Array(RANDOM_NAME_LENGTH))) name += NAME_ALPHABET[byte & 31];
  return name;
}

/**
 * Which account a wallet works on, in this order (INTERFACES.md 48.6): the name remembered in this browser; else the
 * newest of the wallet's own accounts, as GET /api/accounts/mine lists them, newest first; else none yet, and the
 * caller makes a random name once and remembers it. `mine` is null while it isn't known.
 */
export function chooseName(input: { remembered: string | null | undefined; mine: { account_id: string }[] | null | undefined; factory: string }): { name: string; from: 'remembered' | 'mine' | 'none' } {
  // A name the client cleared to type another is still theirs: an empty field stays empty.
  if (typeof input.remembered === 'string') return { name: input.remembered, from: 'remembered' };
  const [newest] = ownNames(input.mine, input.factory);
  return newest ? { name: newest, from: 'mine' } : { name: '', from: 'none' };
}

/** The names of a wallet's own accounts under this factory, in the order they came (newest first). */
export function ownNames(mine: { account_id: string }[] | null | undefined, factory: string): string[] {
  const suffix = `.${factory}`;
  return (mine ?? [])
    .map((a) => a.account_id)
    .filter((id) => typeof id === 'string' && id.endsWith(suffix))
    .map((id) => id.slice(0, -suffix.length))
    .filter((name) => nameProblem(name, factory) === null);
}
