// Conventional Commits are the input of the release: release-please reads the
// history to compute the next version, so a malformed subject is not a style
// slip, it is a version that never gets bumped. The same rules run twice — as
// a `commit-msg` hook here, and again in CI, where they cannot be bypassed.
export default {
  extends: ['@commitlint/config-conventional']
};
