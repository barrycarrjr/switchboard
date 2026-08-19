/**
 * Strings that must never appear in the shipped source tree: credential prefixes, key
 * headers, real user-profile paths, literal email addresses.
 *
 * Kept here, in `scripts/`, for two reasons. It is the one place the patterns live, so the
 * build ratchet in `test/generic.test.js` and any generator that writes third-party text
 * into the tree check exactly the same list. And `scripts/` is not in `build.files`, so
 * this never ships to anyone.
 *
 * The file necessarily contains the patterns it forbids, so the ratchet skips itself and
 * skips this. Add private patterns (a name, a company, internal hostnames) to an untracked
 * `.forbidden-local.json` beside package.json instead of putting them here.
 */
export const FORBIDDEN = [
  { rx: /sk-ant-/, why: 'Anthropic credential prefix' },
  { rx: /ghp_[A-Za-z0-9]{20,}/, why: 'GitHub token' },
  { rx: /github_pat_/, why: 'GitHub fine-grained token' },
  { rx: /xox[baprs]-/, why: 'Slack token' },
  { rx: /AKIA[0-9A-Z]{16}/, why: 'AWS access key' },
  { rx: /BEGIN [A-Z ]*PRIVATE KEY/, why: 'private key material' },
  { rx: /C:\\+Users\\+[a-z]/i, why: 'a real user-profile path' },
  { rx: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.(com|net|org|io)/, why: 'a literal email address' },
];

/** Why the given text would fail the ratchet, or an empty list if it would pass. */
export function offendingPatterns(text, extra = []) {
  return [...FORBIDDEN, ...extra].filter(({ rx }) => rx.test(text)).map(({ why }) => why);
}
