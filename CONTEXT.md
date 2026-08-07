# Ubiquitous language

Glossary of terms used across rstack-editor. Code, docs, commit messages and reviews use these words with exactly these meanings.

## Core

- **Stack** — one tool integration (lint, test, fmt) hosted by the extension shell. A stack registers against the shell and reports status through it; stacks never own UI chrome.
- **Shell** — the always-activating extension core: detection, status bar, output channels, settings migration, stack lifecycle.
- **Detection** — the per-workspace-folder scan deciding which stacks a folder lights up. Detection signals are config files and installed tool binaries, never user settings.
- **Gate** — the per-stack activation condition: detected, workspace trusted, and the enable settings on.

## fmt

- **Cold format** — a format request served by spawning a fresh `rs fmt` process at request time; the request pays the full process start-up cost.
- **Standby** — the single pre-spawned `rs fmt` process held ready for one specific file, so the next format of that file skips the start-up cost. There is at most one standby, and it is only ever armed for the active editor's file ("the standby tracks the active editor"). An editor change that cannot be armed kills it; an editor holding nothing this stack formats leaves it to expire.
- **Arm** — create the standby for a file. Arming happens when the active editor lands on an eligible file and again right after a format consumed the previous standby.
- **Consume** — serve a format request with the armed standby. A standby serves exactly one request; a request the standby cannot serve falls back to a cold format.
- **Hot format** — a format request served by consuming the standby.
- **Expire** — kill an idle standby to reclaim its memory. An expired standby is not an error; the next eligible event simply arms a new one.
