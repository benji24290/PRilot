# DiffLynx

DiffLynx is an open-source, issue-aware pull request review agent. Give it a GitHub or Bitbucket pull request URL and it will fetch the PR, prepare the correct checkout, load linked Jira context when available, inspect the change with an isolated AI agent, and produce a validated review.

It is dry-run by default. DiffLynx prints its report without changing the pull request unless publishing is explicitly enabled.

## What it does

1. Reads PR metadata, changed files, commits, and existing comments from the hosting provider.
2. Uses the current Git checkout when it already matches the PR. Otherwise it clones a missing checkout or moves a clean checkout to the PR source commit.
3. Discovers Jira issues from provider links, `/browse/KEY-123` URLs, and issue keys in the PR title, description, or source branch.
4. Gives the review model a constrained, read-only toolset for diffs, repository files, search, comments, and trusted verification commands.
5. Validates every finding against real changed paths and line anchors.
6. Prints a Markdown review and optionally posts idempotent inline or general comments.

DiffLynx never approves, merges, declines, commits, pushes, or resolves review threads.

## Supported providers

| Provider | PR input | Checkout | Existing comments | Publish | Jira discovery |
| --- | --- | --- | --- | --- | --- |
| GitHub and GitHub Enterprise | `/owner/repo/pull/42` | Yes | Yes | Yes | PR text/branch links and keys |
| Bitbucket Server/Data Center | `/projects/TEAM/repos/repo/pull-requests/42` | Yes | Yes | Yes | Bitbucket Jira integration plus PR text/branch |

## Quick start

Requirements: Git and Node.js `^20.19.0 || >=22.12.0` (or a compatible Bun runtime). The AI reviewer currently uses the GitHub Copilot SDK and requires an entitled GitHub token.

For GitHub:

```sh
GITHUB_TOKEN=github_pat_... \
COPILOT_GITHUB_TOKEN=github_pat_... \
npx --yes difflynx https://github.com/acme/widgets/pull/42
```

For Bitbucket Server/Data Center:

```sh
BITBUCKET_TOKEN=... \
COPILOT_GITHUB_TOKEN=github_pat_... \
npx --yes difflynx https://code.example.com/projects/TEAM/repos/widgets/pull-requests/42
```

The URL may instead be supplied through `PR_URL`. Use `--help` for the compact CLI reference.

## Checkout behavior

`SOURCE_DIR` or `--source-dir` selects the checkout directory.

- If it is already a Git repository at the PR source commit, DiffLynx uses it as-is.
- If it is a clean Git repository at another commit, DiffLynx fetches missing PR commits and checks out the source commit in detached-HEAD mode.
- If it does not exist, DiffLynx clones the provider repository and checks out the source commit.
- If it contains local changes or is a non-empty, non-Git directory, DiffLynx stops instead of overwriting work.

When no directory is configured, DiffLynx uses the current directory if its `origin` matches the PR repository; otherwise it creates a provider/PR-specific checkout below the operating system's temporary directory.

## Jira context

Set `JIRA_TOKEN` to load issues linked from the PR. Set `JIRA_BASE_URL` as well to turn bare keys such as `PAY-123` into issue links.

```sh
JIRA_BASE_URL=https://acme.atlassian.net
JIRA_TOKEN=...
JIRA_EMAIL=developer@acme.example
```

When `JIRA_EMAIL` is set, DiffLynx uses Basic authentication for Atlassian Cloud API tokens. Without an email it uses Bearer authentication, which is common for Jira Server/Data Center personal access tokens. `JIRA_API_VERSION` accepts `2`, `3`, or `latest` and defaults to `latest`.

Missing Jira configuration or an unavailable linked issue is reported as a review limitation; it does not prevent review of the code.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PR_URL` | Unless passed as an argument | — | GitHub or Bitbucket pull request URL |
| `GITHUB_TOKEN` | For GitHub PRs | — | Read PR/repository data and optionally publish comments |
| `BITBUCKET_TOKEN` | For Bitbucket PRs | — | Read PR/repository data and optionally publish comments |
| `COPILOT_GITHUB_TOKEN` | Yes | — | Run the isolated review model |
| `JIRA_TOKEN` | No | — | Load linked Jira issue details |
| `JIRA_EMAIL` | No | — | Use Jira Basic authentication with this account email |
| `JIRA_BASE_URL` | No | — | Resolve bare Jira keys found in PR text or branch names |
| `JIRA_API_VERSION` | No | `latest` | Jira REST API version (`2`, `3`, or `latest`) |
| `SOURCE_DIR` | No | Current checkout or temp cache | Repository checkout location |
| `PUBLISH` | No | `false` | Post review comments only when exactly `true` |
| `VERIFICATION_COMMANDS_JSON` | No | `[]` | Trusted `{id, argv, timeoutSeconds}` commands available to the reviewer |

Example verification configuration:

```sh
VERIFICATION_COMMANDS_JSON='[{"id":"tests","argv":["npm","test"],"timeoutSeconds":900}]'
```

Commands are executed directly without a shell. Token-, secret-, password-, API-key-, and PAT-shaped environment variables are removed from their environment, and configured secrets are redacted from results.

## Publishing and exit status

Publishing requires `--publish` or the exact environment value `PUBLISH=true`. A hidden DiffLynx fingerprint makes reruns idempotent for the same PR source revision and finding.

The process exits `0` when the review completes, including when it finds issues, Jira is unavailable, or a configured verification command fails. It exits `1` for invalid configuration, provider/authentication errors, unsafe checkout state, invalid model output, or comment publication failure.

## Development

```sh
bun install --frozen-lockfile
bun run check
```

Build the Node-compatible ESM package and inspect its publish contents:

```sh
bun run build
bun run pack:check
```

The authenticated SDK smoke check is separate from the normal test suite:

```sh
COPILOT_GITHUB_TOKEN=... bun run smoke:copilot
```

## Security model

PR text, Jira content, comments, diffs, and repository files are treated as untrusted input. The model receives no service credentials or direct network access and can call only the registered review tools. Git operations use argument arrays without a shell, publishing is opt-in, outputs are bounded, and repository paths are validated against traversal.

## License

[MIT](LICENSE)
