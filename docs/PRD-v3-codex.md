# Codex sessions alongside Claude

## Behavior

- `/new name` keeps the current default (Claude unless `TG_AGENT_KIND=codex`). `/new codex name` and `/new claude name` select explicitly.
- Run `bin/tg-bind` in an existing Herdr agent session. Codex callers supply `CODEX_THREAD_ID`; the bridge rejects a mismatched pane/session instead of binding a neighboring agent. From another terminal, pass `--pane ID --kind codex --session SESSION_ID`.
- Topics retain their provider through bridge restart, close/reopen and resume. Old bindings with no provider remain Claude. Resume uses `codex resume SESSION_ID`; Claude keeps `claude --resume SESSION_ID`.
- Attached desktop sessions use the Herdr tab label as their topic name and follow desktop renames within about 10 seconds when the services are reachable. Rename requests run separately from answer delivery, with one in-flight request and retry delay measured after completion. Transcript-generated titles cannot overwrite that name. Telegram-created sessions keep the existing naming behavior.
- Attached desktop sessions stay running when the topic is closed or deleted. Replies, commentary and tool progress are read from the exact session's transcript. Reasoning and system/developer instructions are excluded.
- Codex keeps its existing model, permission and sandbox settings. The bridge does not add bypass flags or replace developer instructions. `TG_CODEX_ARGS` is an optional JSON array of native CLI options, e.g. `["--model","MODEL"]`.

## Prerequisites

Herdr must have a working `codex` executable and the Codex integration: `herdr integration status`. If missing, install with `herdr integration install codex` and start the session again. Session JSONL records must be available under `$CODEX_HOME/sessions` (default `~/.codex/sessions`) or `archived_sessions`. A missing transcript fails binding without creating an empty Telegram topic.

## Scope

This supports Codex sessions managed by a Herdr pane. It does not claim to control an unrelated desktop-app conversation without such a pane. Session id checks enforce that boundary. Native approval/question screens use the existing waiting-screen notice and `/keys`; Claude's AskUserQuestion buttons remain Claude-only. Files produced by Codex scripts or patches are sent with `bin/tg-send PATH`; automatic Write-tool delivery remains Claude-specific.

## Validation

Tests use fake Telegram and Herdr objects and temporary transcripts, covering mixed-provider lifecycle, persistent bindings, last-exchange handoff, commentary/final separation, duplicate mirror records, interruptions, exact-id lookup, mismatched-session rejection, concurrent binds, interrupted and multiple turns in one poll, stalled rename requests, and real shell argument handling with a fake transport. Real Telegram round-trip requires installing into the user's running bridge; unit and offline lifecycle tests do not claim that verification.
