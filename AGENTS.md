# AGENTS.md

Notes for AI coding assistants working in this repo.

## Dev environment & testing workflow

The user develops on this machine (`/Users/marknutter/Code/rendre`) and runs/tests the app on a separate MacBook Pro. The code is kept in sync with **mutagen** — file changes here propagate to the MBP automatically.

Implications:

- After committing or pushing a branch, the user does **not** need to `git pull` on the MBP — mutagen has already synced the working tree.
- To test a branch, the user checks it out on their MBP and runs `npm run dev` there. If the user reports an error from testing, they are running code from this working tree — including uncommitted changes.
- Don't suggest the user "pull the latest" as a fix. The sync is real-time.
- When the user reports a runtime error, the relevant code is whatever is currently on disk in this checkout — not necessarily what's on `origin/main`.

## Branch testing

When the user is testing a feature, confirm which branch is checked out on the MBP if it's unclear. A feature only works if the MBP is on a branch that contains the feature commits. Mutagen syncs the worktree as-is — including the currently checked-out branch state.
