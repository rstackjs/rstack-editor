---
status: accepted
---

# Recover not-installed stacks by polling only while recovery is needed

Installing an already-locked project can populate `node_modules` without changing any config or lockfile. Detection's config and lockfile watchers then have no event to send, even though every stack deliberately resolves its toolchain from the project and needs another resolution pass. The status names the restart command as a fallback, but a fresh clone should recover without requiring it.

The lint stack previously added a direct watcher for `**/node_modules/@rslint/core/package.json`. A controlled VS Code Extension Host experiment opened a project with no `node_modules`, waited for `disabled`, installed with a frozen lockfile, and observed for 90 seconds without invoking a restart command. Lockfile bytes and nanosecond mtime were verified unchanged in every run:

| Install layout | Watcher event | Automatic recovery |
| -------------- | ------------- | ------------------ |
| npm flat       | 2/2           | 2/2                |
| pnpm isolated  | 0/2           | 0/2                |
| pnpm hoisted   | 0/2           | 0/2                |

The result is not explained by pnpm symlinks: the hoisted core was an ordinary directory and still produced no matching event. Versions were VS Code 1.136.1, pnpm 11.20.0, and npm 11.17.0.

The watcher's original rationale was also factually wrong. At Microsoft VS Code commit [`008427a`](https://github.com/microsoft/vscode/commit/008427a901bf4aa79b47f175ccc8da1731750f78), the default `files.watcherExclude` contains only `.git/objects`, `.git/subtree-cache`, and `.hg/store`, each at the root and one directory below; it does not exclude `node_modules` ([`files.contribution.ts:294-310`](https://github.com/microsoft/vscode/blob/008427a901bf4aa79b47f175ccc8da1731750f78/src/vs/workbench/contrib/files/browser/files.contribution.ts#L294-L310)). The failure is the absent pnpm per-file event observed above, not a VS Code default exclude.

**Decision.** The extension shell owns one recursive 60-second timer. It exists while any live controller's raw folder/project/runtime state is disabled, crashed or version-mismatched, enters the shell's existing serialized queue, and forces the same detection notification as a lockfile event even when the detection signature is unchanged. The three stacks reuse their existing dependency-change paths: lint reconciles open documents and refreshes failed configs, fmt restarts failed folder runtimes in place, and Rstest re-resolves shims and retries failed config evaluation. The timer stops when no failed state remains (running, starting or idle). Lockfile watchers stay as the lower-latency path.

The aggregate status is deliberately not the predicate: every owned raw failure needs recovery. A retry landing mid-install can read half-written `node_modules` and fail with a syntax error instead of a missing dependency. Continuing every minute through that real error makes the transient harmless without a provisional-error heuristic. Real errors still replace not-installed in status and Output; persistent error messages and not-installed warnings are deduplicated so retries do not log every minute. The restart hint remains in the status as an explicit fallback.

fmt has one tool-forced limitation. Restarting `rs fmt --lsp` re-runs package resolution, but the server loads project config lazily on the next formatting request. A poll can therefore move the folder to `running` before config loading has been proved; the next format either succeeds or reports the same config failure and returns the folder to `disabled`, which restarts polling.

## Considered options

- **Direct `node_modules` watchers** — rejected by the experiment: they recovered npm but missed both pnpm layouts.
- **Package-manager marker files** such as `node_modules/.modules.yaml`, `node_modules/.package-lock.json`, or `.yarn-integrity` — rejected because each covers one installer/layout and makes recovery depend on private install artifacts rather than the state being recovered.
- **Retry on window focus** — rejected because an install can finish while focus never leaves VS Code, and unrelated focus changes would cause unbounded retries.
- **Bundled tool fallbacks** — rejected by the resolve-from-project contract: editor and CLI must run the same installed versions.

## Consequences

- Healthy workspaces incur no polling work. An unresolved workspace retries at most once per timer interval, through the existing serialized shell queue.
- Recovery no longer depends on installer-specific file events; lockfile watchers remain the faster path when they do fire.
- A real config error replaces not-installed without stopping recovery. Config events and the explicit restart command remain available alongside the minute poll.
- fmt cannot prove config recovery at initialize time. Only a later format producing edits ends its warning episode; empty edits are ambiguous because the server uses them for both no-op formatting and failures whose showMessage may already have been sent.
