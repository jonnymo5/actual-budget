---
name: committing-actual-changes
description: Use whenever creating, drafting, finalizing, or amending a git commit or a pull request in the Actual Budget repo (actualbudget/actual) — including phrases like "commit this", "make a commit", "stage and commit", "open a PR", "create a pull request", "send this for review", "push these changes", "ship it", "submit a PR", "raise a PR", or any time finishing implementation work in this repo where committing or opening a PR is the natural next step. Also trigger when the user mentions the PR template, git hooks, or `--no-verify` in this repo. The repo enforces strict, non-obvious rules for AI-generated contributions (leaving the PR template blank, never skipping hooks, specific git-safety constraints, a pre-commit quality checklist) and not following them produces commits and PRs that have to be redone or manually fixed by a maintainer.
---

# Committing Changes in actualbudget/actual

Before creating any git commit or pull request in this repo, read:

**`.github/agents/pr-and-commit-rules.md`**

It is the authoritative source for the rules you must apply yourself: leaving the PR template blank (and the Chinese exception). The mechanical commit/git rules are enforced by tooling and aren't restated there. Read it on every commit/PR session so any updates are picked up automatically.

## Why this matters

The "do not fill in the PR template" rule exists because the human is the one who actually tested the change and can write the Description / Testing / Checklist sections honestly — an AI-filled template misrepresents who did what.

The rules file is short. Read it before each commit/PR rather than relying on this skill's summary, because the rules file evolves and this skill deliberately does not restate it.
