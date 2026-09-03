import { z } from "zod";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { PullRequestLocator, VerificationCommand } from "./domain.ts";
import { sameRepository } from "./git.ts";

export const COPILOT_MODEL = "gpt-5.6-sol";
export const MAX_TOOL_OUTPUT_BYTES = 200_000;

const booleanString = z.string().default("false").transform((value, ctx) => {
  if (value === "true") return true;
  if (value === "false") return false;
  ctx.addIssue({ code: "custom", message: "must be true or false" });
  return z.NEVER;
});

const verificationCommandSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9._-]+$/).max(80),
  argv: z.array(z.string().min(1).max(2_000)).min(1).max(50),
  timeoutSeconds: z.number().int().positive().max(3_600).default(900),
});

const optionalString = (schema: z.ZodString) => z.preprocess(
  (value) => value === "" || value === undefined ? undefined : value,
  schema.optional(),
);

const environmentSchema = z.object({
  PR_URL: optionalString(z.string().url()),
  GITHUB_TOKEN: optionalString(z.string().min(1)),
  BITBUCKET_TOKEN: optionalString(z.string().min(1)),
  JIRA_TOKEN: optionalString(z.string().min(1)),
  JIRA_BASE_URL: optionalString(z.string().url()),
  COPILOT_GITHUB_TOKEN: z.string().min(1),
  PUBLISH: booleanString,
  SOURCE_DIR: optionalString(z.string().min(1)),
  VERIFICATION_COMMANDS_JSON: z.string().default("[]"),
});

export interface AppConfig {
  pullRequest: PullRequestLocator & {
    token: string;
  };
  jira?: {
    token: string;
    baseUrl?: string;
  };
  copilotToken: string;
  publish: boolean;
  sourceDirectory: string;
  verificationCommands: VerificationCommand[];
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  currentDirectory = process.cwd(),
  pullRequestUrl?: string,
): AppConfig {
  const parsed = environmentSchema.parse(env);
  const requestedUrl = pullRequestUrl ?? parsed.PR_URL;
  if (!requestedUrl) throw new Error("A pull request URL is required as an argument or through PR_URL");
  const pullRequest = parsePullRequestUrl(requestedUrl);
  const token = pullRequest.provider === "github" ? parsed.GITHUB_TOKEN : parsed.BITBUCKET_TOKEN;
  if (!token) throw new Error(`${pullRequest.provider === "github" ? "GITHUB_TOKEN" : "BITBUCKET_TOKEN"} is required for this pull request`);
  let verificationJson: unknown;
  try {
    verificationJson = JSON.parse(parsed.VERIFICATION_COMMANDS_JSON);
  } catch {
    throw new Error("VERIFICATION_COMMANDS_JSON must contain valid JSON");
  }
  const verificationCommands = z.array(verificationCommandSchema).max(30).parse(verificationJson);
  const ids = new Set<string>();
  for (const command of verificationCommands) {
    if (ids.has(command.id)) throw new Error(`Duplicate verification command id: ${command.id}`);
    ids.add(command.id);
  }
  return {
    pullRequest: {
      ...pullRequest,
      token,
    },
    ...(parsed.JIRA_TOKEN ? {
      jira: {
        token: parsed.JIRA_TOKEN,
        ...(parsed.JIRA_BASE_URL ? { baseUrl: normalizeBaseUrl(parsed.JIRA_BASE_URL) } : {}),
      },
    } : {}),
    copilotToken: parsed.COPILOT_GITHUB_TOKEN,
    publish: parsed.PUBLISH,
    sourceDirectory: parsed.SOURCE_DIR ?? defaultCheckoutDirectory(currentDirectory, pullRequest),
    verificationCommands,
  };
}

export function parsePullRequestUrl(value: string): PullRequestLocator {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("PR_URL must be an HTTP(S) URL without credentials");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const projectsIndex = segments.indexOf("projects");
  const expectedTail = projectsIndex >= 0 ? segments.slice(projectsIndex) : [];
  if (projectsIndex >= 0 && (
    expectedTail.length < 6
    || expectedTail[0] !== "projects"
    || expectedTail[2] !== "repos"
    || expectedTail[4] !== "pull-requests"
    || !/^[1-9]\d*$/.test(expectedTail[5] ?? "")
    || (expectedTail[6] !== undefined && !["overview", "diff", "commits"].includes(expectedTail[6]))
    || expectedTail.length > 7
  )) {
    throw new Error("PR_URL must point to a GitHub /owner/repository/pull/{id} or Bitbucket /projects/{project}/repos/{repository}/pull-requests/{id} URL");
  }
  if (projectsIndex >= 0) {
    const prefix = segments.slice(0, projectsIndex).map((segment) => encodeURIComponent(decodeURIComponent(segment))).join("/");
    return {
      provider: "bitbucket",
      baseUrl: `${url.origin}${prefix ? `/${prefix}` : ""}`,
      owner: decodeURIComponent(expectedTail[1] ?? ""),
      repository: decodeURIComponent(expectedTail[3] ?? ""),
      pullRequestId: Number(expectedTail[5]),
    };
  }
  const pullIndex = segments.lastIndexOf("pull");
  const githubTab = segments[pullIndex + 2];
  if (
    pullIndex < 2
    || !/^[1-9]\d*$/.test(segments[pullIndex + 1] ?? "")
    || (githubTab !== undefined && !["files", "commits", "checks"].includes(githubTab))
    || segments.length > pullIndex + 3
  ) {
    throw new Error("PR_URL must point to a GitHub /owner/repository/pull/{id} or Bitbucket /projects/{project}/repos/{repository}/pull-requests/{id} URL");
  }
  return {
    provider: "github",
    baseUrl: url.origin,
    owner: decodeURIComponent(segments[pullIndex - 2] ?? ""),
    repository: decodeURIComponent(segments[pullIndex - 1] ?? "").replace(/\.git$/, ""),
    pullRequestId: Number(segments[pullIndex + 1]),
  };
}

function defaultCheckoutDirectory(currentDirectory: string, pullRequest: PullRequestLocator): string {
  if (looksLikeMatchingGitCheckout(currentDirectory, pullRequest)) return currentDirectory;
  const slug = [pullRequest.provider, new URL(pullRequest.baseUrl).hostname, pullRequest.owner, pullRequest.repository, pullRequest.pullRequestId]
    .join("-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-");
  return join(tmpdir(), "prilot", slug);
}

function looksLikeMatchingGitCheckout(directory: string, pullRequest: PullRequestLocator): boolean {
  if (!process.env.GIT_DIR && !existsSync(join(directory, ".git"))) return false;
  const result = spawnSync("git", ["-C", directory, "remote", "get-url", "origin"], { encoding: "utf8" });
  if (result.status !== 0) return false;
  const expected = pullRequest.provider === "bitbucket"
    ? `${pullRequest.baseUrl}/scm/${encodeURIComponent(pullRequest.owner)}/${encodeURIComponent(pullRequest.repository)}.git`
    : `${pullRequest.baseUrl}/${encodeURIComponent(pullRequest.owner)}/${encodeURIComponent(pullRequest.repository)}.git`;
  return sameRepository(result.stdout.trim(), expected);
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/$/, "");
}
