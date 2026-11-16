<!-- Copyright 2026 Volt Data Lab. SPDX-License-Identifier: AGPL-3.0-only -->
# File-only MCP candidate verifier

This standalone, Linux-qualified tool compares a **flat, inert source directory**
with one reviewed profile in `candidate-files.json`. It never imports or executes
candidate files, starts services, installs dependencies or runs the MCP test suite.
No npm dependencies or package-manager setup are needed to execute it.

Requires Node 22.23.2 (the runtime exercised here) or a compatible Node with native
TypeScript support. Run from the repository root:

```sh
node spikes/infra-mcp-packaging/check.mts \
  spikes/infra-mcp-packaging/candidate-files.json backend /path/to/inert-source-copy
node --test spikes/infra-mcp-packaging/check.test.mts spikes/infra-mcp-packaging/rejection.test.mts
```

Profiles: `backend` (23 files), `observer` (9), `operator` (12). Their source closures
come from the static inventory; each also includes the unchanged package/lock and
three repository license files. The manifest hashes bind the worktree candidate,
not the older staged versions. Files use flat basenames. Do not point the verifier
at the full development checkout or a live installation.

Exit 0 prints `{"status":"FILES_MATCH","files":N}`. Exit 1 prints only
`FILES_REJECTED` to stderr. Missing files, different hashes, extra entries,
directories, final-component symlinks, malformed manifests, traversal names,
experimental CapRover files, test/fixture names and non-source private-state names
are rejected. Reads are bounded to 1 MiB for the manifest and 16 MiB per file.
The caller selects the candidate directory; the tool does not build or copy it.
Tests create only their own temporary fixtures and invoke only this checker.

## Trust and limits

- The manifest must be reviewed and preserved independently. This is a consistency
  check against that manifest, **not a signature, authorization or secret scanner**.
  Do not automatically regenerate hashes to accept unexpected modifications.
- Use an offline, stable, caller-owned directory. This is not an atomic snapshot,
  proof against concurrent filesystem writers, parent-directory symlink sandbox,
  or solution to IPC ownership/cleanup. It makes no ownership or removal decisions.
- A successful source-layout comparison does not establish an installable runtime:
  dependencies are not installed, lock pruning and production recipes are not
  validated, and the development package scripts still describe the full package.
- It does not check archives, transitive npm contents, frontend bundles, service
  permissions, OAuth flows, live infrastructure, or restoration of private state.
- IPC/runtime source files are treated only as inert bytes. Their known blockers
  remain. The rejected experimental adapter and tests stay in version control;
  excluding them from this layout does not approve another backend or deployment.

The checker has its own narrow Node test suite. Do not run `spikes/infra-mcp`'s
normal tests or demo as a substitute: those can reach paused IPC work.
No commit, remote preservation, CI or deployment is implied by local verification.
