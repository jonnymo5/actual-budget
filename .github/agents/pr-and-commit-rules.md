# PR and Commit Rules for AI Agents

This file lists the PR and commit rules you have to apply yourself.

## Pull Request Rules

### Pull requests go to the fork only

**Never open a pull request against upstream `actualbudget/actual`.** The user
never sends changes to the base repo. Every PR targets the user's own fork,
`jonnymo5/actual-budget` (base branch `master`), and the user has given standing
permission to push branches to `origin` and open PRs there. Always name the
target: `gh pr create --repo jonnymo5/actual-budget …` (a bare `gh pr create` in
a fork resolves to upstream). For the GitHub MCP tools, `create_pull_request`
must use owner `jonnymo5` and repo `actual-budget`. The agent hooks block
anything else.

The fork is public, so keep personal financial details (real account names,
payees, balances, amounts, paydays) out of code, tests, commit messages, PR text
and issues; use made-up examples. **Before every commit and every push, check
for them**: read the staged diff and the commit message, and search both for
real names and numbers from the budget being worked on. Do this before
committing, not after, because personal details must not appear in commit
history either, and history cannot be cleaned once it is pushed.

### Do not fill in the PR template

- **NEVER fill in the PR template** (`.github/PULL_REQUEST_TEMPLATE.md`). Create
  the PR with that template as the body, unmodified — leave all blank spaces and
  placeholder comments as-is, and leave every checklist box unchecked. The human
  who tested the change fills in the Description, Related issue(s), Testing, and
  Checklist sections.
- **Exception**: if a human **explicitly asks** you to fill it out, do so **in
  Chinese**, using Chinese characters (简体中文) for all content you add.

## GitHub issues

Agents may create GitHub issues **only on the user's own fork,
`jonnymo5/actual-budget`, and only when the user asks for one.** Never create an
issue on upstream `actualbudget/actual` or any other repository — if you believe
an issue should exist there, share the proposed title and body with the user and
let them file it.

- Always name the target explicitly: `gh issue create --repo jonnymo5/actual-budget …`
  (a bare `gh issue create` in a fork can resolve to the upstream repo). For the
  GitHub MCP tools, `issue_write` with method `create` must use owner
  `jonnymo5` and repo `actual-budget`. The agent hooks block anything else.
- The fork is public, so **never put personal details in an issue** — no account
  names, balances, transaction amounts, employer, or other personal financial
  information. Describe the feature generically.
- Issues follow the 🤖 prefix rule below (title and body).
- Updating existing issues (and commenting on them) remains allowed.

## GitHub comment, review and issue prefix

**Prefix everything you post to GitHub with the robot emoji 🤖** — pull-request
and issue comments, pull-request reviews (including inline review comments), and
the title and body of issues you edit. This keeps agent-authored content
visibly marked. PR titles and commit messages are written normally, with no
prefix.

Write the text normally; just make sure 🤖 is the first character (for issues,
on both the title and the body).

This applies only to comments **you** author — bots like CodeRabbit post under
their own identity and are not affected.
