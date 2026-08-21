import type { Finding, PullRequest, ReviewComment } from "./domain.ts";
import type { PullRequestProvider } from "./provider.ts";
import { fingerprintMarker } from "./report.ts";

export interface PublicationResult {
  publishedCount: number;
  skippedCount: number;
  failedCount: number;
  errors: string[];
}

export async function publishFindings(options: {
  enabled: boolean;
  findings: Finding[];
  existingComments: ReviewComment[];
  pullRequest: PullRequest;
  provider: PullRequestProvider;
}): Promise<PublicationResult> {
  if (!options.enabled) {
    for (const finding of options.findings) finding.publication = { status: "dry-run" };
    return { publishedCount: 0, skippedCount: 0, failedCount: 0, errors: [] };
  }

  const activeText = options.existingComments
    .filter((comment) => comment.state?.toUpperCase() !== "RESOLVED")
    .map((comment) => comment.text)
    .join("\n");
  const pendingGeneral: Finding[] = [];
  let publishedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const errors: string[] = [];

  for (const finding of options.findings) {
    if (activeText.includes(fingerprintMarker(finding.fingerprint))) {
      finding.publication = { status: "skipped-existing" };
      skippedCount += 1;
      continue;
    }
    if (!finding.anchorable || !finding.path || finding.line === undefined) {
      pendingGeneral.push(finding);
      continue;
    }
    try {
      const commentId = await options.provider.postComment(formatFinding(finding), {
        targetHash: options.pullRequest.targetHash,
        sourceHash: options.pullRequest.sourceHash,
        line: finding.line,
        path: finding.path,
      });
      finding.publication = { status: "published", commentId };
      publishedCount += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finding.publication = { status: "failed", error: message };
      failedCount += 1;
      errors.push(`${finding.fingerprint}: ${message}`);
    }
  }

  for (const group of groupGeneralFindings(pendingGeneral, 30_000)) {
    try {
      const commentId = await options.provider.postComment(formatGeneral(group));
      for (const finding of group) finding.publication = { status: "published", commentId };
      publishedCount += group.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const finding of group) finding.publication = { status: "failed", error: message };
      failedCount += group.length;
      errors.push(`${group.map((finding) => finding.fingerprint).join(",")}: ${message}`);
    }
  }

  return { publishedCount, skippedCount, failedCount, errors };
}

function formatFinding(finding: Finding): string {
  return `**[${finding.severity.toUpperCase()}] ${finding.title}**\n\n${finding.body}\n\n${fingerprintMarker(finding.fingerprint)}`;
}

function formatGeneral(findings: Finding[]): string {
  return [
    "## DiffLynx code review findings",
    ...findings.map((finding) => {
      const location = finding.path ? ` (${finding.path}${finding.line ? `:${finding.line}` : ""})` : "";
      return `### [${finding.severity.toUpperCase()}] ${finding.title}${location}\n\n${finding.body}\n\n${fingerprintMarker(finding.fingerprint)}`;
    }),
  ].join("\n\n");
}

function groupGeneralFindings(findings: Finding[], maxLength: number): Finding[][] {
  const groups: Finding[][] = [];
  let current: Finding[] = [];
  let length = 0;
  for (const finding of findings) {
    const itemLength = formatFinding(finding).length + 100;
    if (current.length > 0 && length + itemLength > maxLength) {
      groups.push(current);
      current = [];
      length = 0;
    }
    current.push(finding);
    length += itemLength;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}
