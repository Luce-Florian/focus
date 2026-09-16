/**
 * POSIX single-quote escaping for values interpolated into a `sh -c` command
 * line. Shared because both the Electron main process and the smoke test build
 * pane commands this way, and a quoting bug fixed in one copy is a quoting bug
 * left in the other.
 */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
