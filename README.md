# PRilot

PRilot is an open-source pull request review agent for GitHub and Bitbucket. Give it a PR URL and it checks out the correct code, loads linked Jira context, reviews the diff with an isolated AI agent, and validates every finding before reporting it.

Reviews are read-only by default. PRilot posts comments only with `--publish` or `PUBLISH=true`; it never approves, merges, declines, commits, or pushes code.

## Quick start

Requirements: Git, Node.js `^20.19.0 || >=22.12.0` or Bun, and a GitHub token with Copilot access.

Store local tokens in macOS Keychain, Windows Credential Manager, or Linux Secret Service:

```sh
npx prilot auth set github     # or: bitbucket
npx prilot auth set copilot
npx prilot https://github.com/acme/widgets/pull/42
```

With Bun:

```sh
bunx prilot https://code.example.com/projects/TEAM/repos/widgets/pull-requests/42
```

Pipeline-friendly output and severity gating:

```sh
npx --yes prilot "$PR_URL" --format json --output prilot.json --fail-on high
```

Manage stored credentials with:

```sh
prilot auth status
prilot auth set <github|bitbucket|jira|copilot>
prilot auth delete <github|bitbucket|jira|copilot>
```

Token input is hidden and stored values are never printed. Environment variables take precedence, and the keyring is skipped when `CI=true` or `PRILOT_DISABLE_KEYRING=true`.

## Supported services

- GitHub and GitHub Enterprise
- Bitbucket Server and Data Center
- Jira Server and Data Center using Bearer-token authentication

PRilot discovers Jira issues from provider links, `/browse/KEY-123` URLs, and issue keys in PR titles, descriptions, and branch names. Missing Jira access is reported as a limitation and does not stop the code review.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `PR_URL` | If no URL argument is given | Pull request URL |
| `GITHUB_TOKEN` | For GitHub PRs | Read the PR and optionally publish comments |
| `BITBUCKET_TOKEN` | For Bitbucket PRs | Read the PR and optionally publish comments |
| `COPILOT_GITHUB_TOKEN` | Yes | Run the review agent |
| `JIRA_TOKEN` | No | Load linked Jira issues |
| `JIRA_BASE_URL` | No | Resolve bare Jira issue keys |
| `SOURCE_DIR` | No | Select an existing or new checkout directory |
| `PUBLISH` | No | Publish comments when exactly `true` |
| `VERIFICATION_COMMANDS_JSON` | No | Expose trusted commands to the reviewer |

CLI options override output behavior:

- `--format markdown|json` selects the report format.
- `--output <path>` writes the report to a file instead of stdout.
- `--fail-on low|medium|high|critical` exits `2` when a finding reaches the threshold.

Pipeline example:

```sh
GITHUB_TOKEN=... \
COPILOT_GITHUB_TOKEN=... \
npx --yes prilot https://github.com/acme/widgets/pull/42
```

Trusted verification commands use `{id, argv, timeoutSeconds}` objects:

```sh
VERIFICATION_COMMANDS_JSON='[{"id":"tests","argv":["npm","test"],"timeoutSeconds":900}]'
```

## Behavior and safety

PRilot reuses a matching checkout, moves a clean checkout to the PR source commit, or clones into a temporary directory. It refuses to overwrite local changes or a non-empty, non-Git directory.

PR text, Jira content, comments, diffs, and repository files are treated as untrusted input. The review model receives no service credentials or direct network access and has only constrained read and verification tools. Publishing is opt-in and idempotent.

The process exits `0` after a completed review by default, `2` when `--fail-on` is reached, and `1` for configuration, authentication, checkout, model-validation, or publication failures. Reports use stdout; structured operational logs use stderr.

## Development

```sh
bun install --frozen-lockfile
bun run check
```

Publishing is automated from `main`: increasing the stable `package.json` version runs all checks, publishes through npm trusted publishing, and creates the matching tag and GitHub Release. Configure npm's trusted publisher for the `release.yml` workflow before the first release.

## License

[MIT](LICENSE)
