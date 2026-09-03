import { createHash } from "node:crypto";
import type { Finding, FindingInput, PullRequest, PullRequestChange, ReviewSubmission } from "./domain.ts";
import { normalizeRepoPath, type GitRepository } from "./git.ts";

export interface FindingValidationContext {
  provider: string;
  host: string;
  owner: string;
  repositoryName: string;
  pullRequest: PullRequest;
  changes: PullRequestChange[];
  mergeBase: string;
  repository: GitRepository;
}

export async function validateFindings(
  submission: ReviewSubmission,
  context: FindingValidationContext,
): Promise<{ findings: Finding[]; errors: string[] }> {
  const changedPaths = new Set(context.changes.flatMap((change) => [change.path, change.sourcePath].filter((path): path is string => Boolean(path))));
  const addedLinesByPath = new Map<string, Set<number>>();
  const fingerprints = new Set<string>();
  const findings: Finding[] = [];
  const errors: string[] = [];

  for (const [index, input] of submission.findings.entries()) {
    let normalized: FindingInput = { ...input };
    if (input.path) {
      try {
        const path = normalizeRepoPath(input.path);
        normalized = { ...normalized, path };
        if (!changedPaths.has(path)) {
          errors.push(`Finding ${index + 1}: path is not part of the pull request changes: ${path}`);
          continue;
        }
        const existsInSource = await context.repository.fileExists(context.pullRequest.sourceHash, path);
        const existsInTarget = await context.repository.fileExists(context.pullRequest.targetHash, path);
        if (!existsInSource && !existsInTarget) {
          errors.push(`Finding ${index + 1}: path does not exist in either revision: ${path}`);
          continue;
        }
      } catch (error) {
        errors.push(`Finding ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }

    let anchorable = false;
    if (normalized.path && normalized.line !== undefined) {
      let addedLines = addedLinesByPath.get(normalized.path);
      if (!addedLines) {
        addedLines = await context.repository.addedLines(context.mergeBase, context.pullRequest.sourceHash, normalized.path);
        addedLinesByPath.set(normalized.path, addedLines);
      }
      anchorable = addedLines.has(normalized.line);
    }

    const fingerprint = findingFingerprint(context, normalized);
    if (fingerprints.has(fingerprint)) {
      errors.push(`Finding ${index + 1}: duplicates another submitted finding`);
      continue;
    }
    fingerprints.add(fingerprint);
    findings.push({
      ...normalized,
      fingerprint,
      anchorable,
      publication: { status: "dry-run" },
    });
  }
  return { findings, errors };
}

export function findingFingerprint(context: Omit<FindingValidationContext, "changes" | "mergeBase" | "repository">, finding: FindingInput): string {
  const stable = [
    context.provider,
    context.host,
    context.owner,
    context.repositoryName,
    String(context.pullRequest.id),
    context.pullRequest.sourceHash,
    finding.path ?? "",
    String(finding.line ?? ""),
    normalizeText(finding.title),
    normalizeText(finding.body),
  ].join("\u0000");
  return createHash("sha256").update(stable).digest("hex").slice(0, 24);
}

export function fingerprintMarker(fingerprint: string): string {
  return `<!-- prilot:${fingerprint} -->`;
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}
