# Contributing

Issues and pull requests are welcome. Small, focused changes are the easiest to merge; for anything larger
(a new mode, a new harness, a schema change) open an issue first.

## Ground rules

- **No dependencies, no build step.** Plain Node ≥ 22.5 (built-in `node:sqlite`) and one HTML file. Please keep it that way.
- **Run the tests** (a real server with a fake harness, no paid calls):

  ```bash
  node --test app/members.test.mjs app/modes.test.mjs app/speech.test.mjs app/stance.test.mjs app/env.test.mjs app/flows.test.mjs
  ```

  A change in behaviour comes with a test that fails without it.
- **Read first**: [CLAUDE.md](CLAUDE.md) is the architecture overview, [PLAN.md](PLAN.md) the design decisions and the
  CLI quirks learned the hard way. Adapter changes (`app/agents.mjs`) must follow its "CLI adapter rules".
- **UI text** is written in Chinese inside `tx(...)`, with its English added to `EN` in `app/i18n.mjs` (a test checks
  that every key's placeholders match).
- **Match the code around you**: comment density, naming, terse idiom. Comments say why, not what.
- **Never commit** `data/`, `workspace/` or anything with keys or personal discussions in it.
- Scheduler changes: log new decision types to the `decisions` table, so modes can be compared later.

## License

By contributing you agree that your contribution is licensed under the project's [AGPL-3.0](LICENSE).
