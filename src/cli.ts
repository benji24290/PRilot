import { runCopilotReview } from "./agent.ts";
import { BitbucketClient } from "./bitbucket.ts";
import { loadConfig, MAX_TOOL_OUTPUT_BYTES, type AppConfig } from "./config.ts";
import { loadStoredCredentials, runAuth } from "./credentials.ts";
import type { Finding, IssueContext, PullRequest, PullRequestChange, PullRequestProviderName, VerificationResult } from "./domain.ts";
import { prepareRepository, type GitRepository } from "./git.ts";
import { GitHubClient } from "./github.ts";
import { HttpClient } from "./http.ts";
import { discoverLinkedIssues } from "./issues.ts";
import { JiraClient } from "./jira.ts";
import { Logger } from "./logger.ts";
import type { PullRequestProvider } from "./provider.ts";
import { publishFindings } from "./publisher.ts";
import { validateFindings } from "./report.ts";

let logger = new Logger();
let terminating = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    terminating = true;
    logger.warn("termination_requested", { signal });
  });
}

export async function main(
  env: Record<string, string | undefined> = process.env,
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  if (argv[0] === "auth") {
    await runAuth(argv.slice(1));
    return;
  }
  const arguments_ = parseArguments(argv);
  if (arguments_.help) {
    console.log(helpText());
    return;
  }
  const effectiveEnvironment = await loadStoredCredentials({
    ...env,
    ...(arguments_.sourceDirectory ? { SOURCE_DIR: arguments_.sourceDirectory } : {}),
    ...(arguments_.publish ? { PUBLISH: "true" } : {}),
  });
  const config = loadConfig(effectiveEnvironment, process.cwd(), arguments_.pullRequestUrl);
  const secrets = [config.pullRequest.token, config.jira?.token, config.copilotToken]
    .filter((value): value is string => Boolean(value));
  logger = new Logger(secrets);
  const http = new HttpClient();
  const provider = createProvider(config, http);
  const identity = provider.identity;
  logger.info("review_started", { ...identity, publish: config.publish });

  const pullRequest = await provider.getPullRequest();
  checkTermination();
  const [apiChanges, comments, providerIssueLinks] = await Promise.all([
    provider.listChanges(),
    provider.listComments(),
    provider.listLinkedIssues().catch((error: unknown) => {
      logger.warn("provider_issue_links_unavailable", { reason: error instanceof Error ? error.message : String(error) });
      return [];
    }),
  ]);

  const repository = await prepareRepository({
    directory: config.sourceDirectory,
    cloneUrl: provider.cloneUrl,
    sourceHash: pullRequest.sourceHash,
    sourceRef: provider.sourceFetchRef ?? pullRequest.sourceRef,
    targetHash: pullRequest.targetHash,
    targetRef: pullRequest.targetRef,
    gitAuthorizationHeader: provider.gitAuthorizationHeader,
    maxOutputBytes: MAX_TOOL_OUTPUT_BYTES,
    redactedSecrets: secrets,
  });
  const mergeBase = await repository.mergeBase(pullRequest.targetHash, pullRequest.sourceHash);
  const changes = await changesWithFallback(apiChanges, repository, mergeBase, pullRequest.sourceHash);
  const limitations: string[] = [];
  const issues = await loadIssues(config, pullRequest, providerIssueLinks, http, limitations);

  checkTermination();
  const agentContext = {
    provider: identity.provider,
    host: identity.host,
    owner: identity.owner,
    repositoryName: identity.repository,
    pullRequest,
    issues,
    changes,
    comments,
    mergeBase,
    repository,
    verificationCommands: config.verificationCommands,
  };
  const agentResult = await runCopilotReview(agentContext, { token: config.copilotToken, logger });
  const validationContext = {
    provider: identity.provider,
    host: identity.host,
    owner: identity.owner,
    repositoryName: identity.repository,
    pullRequest,
    changes,
    mergeBase,
    repository,
  };
  const validated = await validateFindings(agentResult.submission, validationContext);
  if (validated.errors.length > 0) throw new Error(`Review validation failed: ${validated.errors.join("; ")}`);
  limitations.push(...agentResult.submission.limitations);

  const publication = await publishFindings({
    enabled: config.publish,
    findings: validated.findings,
    existingComments: comments,
    pullRequest,
    provider,
  });
  const status = limitations.length > 0 ? "incomplete" : validated.findings.length > 0 ? "findings" : "clean";
  printMarkdown(identity.provider, pullRequest, agentResult.submission.summary, limitations, validated.findings, agentResult.verification);
  logger.info("review_completed", {
    status,
    sourceSha: pullRequest.sourceHash,
    findingCount: validated.findings.length,
    publishedCount: publication.publishedCount,
    skippedCount: publication.skippedCount,
    failedCount: publication.failedCount,
  });
  if (publication.errors.length > 0) throw new Error(`One or more comments could not be published: ${publication.errors.join("; ")}`);
}

export function createProvider(config: AppConfig, http: HttpClient): PullRequestProvider {
  const options = { ...config.pullRequest, http };
  return config.pullRequest.provider === "github" ? new GitHubClient(options) : new BitbucketClient(options);
}

async function changesWithFallback(
  changes: PullRequestChange[],
  repository: GitRepository,
  mergeBase: string,
  sourceHash: string,
): Promise<PullRequestChange[]> {
  if (changes.length > 0) return changes;
  return (await repository.changedPaths(mergeBase, sourceHash)).map((path) => ({ path, type: "MODIFY" }));
}

async function loadIssues(
  config: AppConfig,
  pullRequest: PullRequest,
  providerLinks: Awaited<ReturnType<PullRequestProvider["listLinkedIssues"]>>,
  http: HttpClient,
  limitations: string[],
): Promise<IssueContext[]> {
  const links = discoverLinkedIssues(pullRequest, providerLinks, config.jira?.baseUrl);
  if (links.length === 0) return [];
  if (!config.jira) {
    limitations.push(`Linked Jira issues ${links.map((link) => link.key).join(", ")} were found, but JIRA_TOKEN is not configured.`);
    return [];
  }
  const jira = new JiraClient(config.jira.token, http);
  const results = await Promise.all(links.map(async (link) => {
    try {
      return await jira.getIssue(link);
    } catch (error) {
      limitations.push(`Jira issue ${link.key} could not be loaded.`);
      logger.warn("jira_context_unavailable", { issueKey: link.key, reason: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }));
  return results.filter((issue): issue is IssueContext => issue !== undefined);
}

function printMarkdown(
  provider: PullRequestProviderName,
  pullRequest: PullRequest,
  summary: string,
  limitations: string[],
  findings: Finding[],
  verification: VerificationResult[],
): void {
  console.log(`\n# PRilot review: ${provider} PR ${pullRequest.id}\n`);
  console.log(`${summary}\n`);
  if (limitations.length > 0) {
    console.log("## Limitations\n");
    for (const limitation of limitations) console.log(`- ${limitation}`);
    console.log();
  }
  console.log("## Findings\n");
  if (findings.length === 0) console.log("No actionable findings.\n");
  for (const finding of findings) {
    const location = finding.path ? ` — ${finding.path}${finding.line ? `:${finding.line}` : ""}` : "";
    console.log(`- **${finding.severity.toUpperCase()}** ${finding.title}${location} (${finding.publication.status})`);
  }
  if (verification.length > 0) {
    console.log("\n## Verification\n");
    for (const result of verification) console.log(`- ${result.id}: exit ${result.exitCode ?? "unknown"}${result.timedOut ? " (timed out)" : ""}`);
  }
}

function parseArguments(argv: string[]): { pullRequestUrl?: string; sourceDirectory?: string; publish: boolean; help: boolean } {
  let pullRequestUrl: string | undefined;
  let sourceDirectory: string | undefined;
  let publish = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") help = true;
    else if (argument === "--publish") publish = true;
    else if (argument === "--source-dir") {
      sourceDirectory = argv[index + 1];
      if (!sourceDirectory) throw new Error("--source-dir requires a path");
      index += 1;
    } else if (argument?.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    else if (!pullRequestUrl && argument) pullRequestUrl = argument;
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  return {
    ...(pullRequestUrl ? { pullRequestUrl } : {}),
    ...(sourceDirectory ? { sourceDirectory } : {}),
    publish,
    help,
  };
}

function helpText(): string {
  return `PRilot — issue-aware pull request reviews

Usage:
  npx prilot <pull-request-url> [--source-dir <path>] [--publish]
  bunx prilot <pull-request-url> [--source-dir <path>] [--publish]
  prilot auth <status|set|delete> [credential]

Supports GitHub (including Enterprise) and Bitbucket Server/Data Center URLs.
The review is printed to stdout; comments are posted only with --publish or PUBLISH=true.
Local tokens can be stored in the operating system credential manager with prilot auth.`;
}

function checkTermination(): void {
  if (terminating) throw new Error("Review terminated by signal");
}

export async function run(): Promise<void> {
  try {
    await main();
  } catch (error) {
    logger.error("review_failed", error);
    process.exitCode = 1;
  }
}
