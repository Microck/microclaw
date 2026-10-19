// A Codex-launched shell inherits CODEX_HOME. Older tests change HOME to a
// temporary directory, but the writer correctly prefers CODEX_HOME and would
// otherwise overwrite the operator's real config. Fail before loading tests.
if (process.env.CODEX_HOME) {
  throw new Error('Refusing to run tests with inherited CODEX_HOME. Run: env -u CODEX_HOME bun test --isolate');
}
