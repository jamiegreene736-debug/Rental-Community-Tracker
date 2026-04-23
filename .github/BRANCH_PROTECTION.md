Enable a branch protection rule on `main` after these workflows land.

Recommended settings:

- Require a pull request before merging
- Require approvals
- Dismiss stale approvals when new commits are pushed
- Require status checks to pass before merging
- Require branches to be up to date before merging
- Restrict force pushes

Recommended required checks:

- `quality`
- `secret-scan`
- `analyze`

Notes:

- `npm run check` currently fails on existing TypeScript issues in the repo, so it is not wired into required checks yet.
- Local `npm audit --omit=dev --audit-level=high` currently reports existing dependency advisories, including a high-severity Drizzle ORM advisory. Dependabot and CodeQL are set up to help surface and track those safely before we make upgrade changes.
