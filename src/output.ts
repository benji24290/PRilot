import type {
  Finding,
  PullRequest,
  PullRequestIdentity,
  Severity,
  VerificationResult,
} from "./domain.ts";
import type { PublicationResult } from "./publisher.ts";

export type OutputFormat = "markdown" | "json";
export type FailureThreshold = Severity | "never";
export type ReviewStatus = "clean" | "findings" | "incomplete";

export interface ReviewReport {
  schemaVersion: 1;
  status: ReviewStatus;
  pullRequest: PullRequestIdentity & {
    title: string;
    sourceBranch: string;
    sourceHash: string;
    targetBranch: string;
    targetHash: string;
  };
  summary: string;
  limitations: string[];
  findings: Finding[];
  verification: VerificationResult[];
  publication: PublicationResult;
}

export function createReviewReport(options: {
  identity: PullRequestIdentity;
  pullRequest: PullRequest;
  summary: string;
  limitations: string[];
  findings: Finding[];
  verification: VerificationResult[];
  publication: PublicationResult;
}): ReviewReport {
  return {
    schemaVersion: 1,
    status: options.limitations.length > 0 ? "incomplete" : options.findings.length > 0 ? "findings" : "clean",
    pullRequest: {
      ...options.identity,
      title: options.pullRequest.title,
      sourceBranch: options.pullRequest.sourceBranch,
      sourceHash: options.pullRequest.sourceHash,
      targetBranch: options.pullRequest.targetBranch,
      targetHash: options.pullRequest.targetHash,
    },
    summary: options.summary,
    limitations: options.limitations,
    findings: options.findings,
    verification: options.verification,
    publication: options.publication,
  };
}

export function formatReviewReport(report: ReviewReport, format: OutputFormat): string {
  return format === "json" ? JSON.stringify(report, null, 2) : formatMarkdown(report);
}

export function reachesFailureThreshold(findings: Finding[], threshold: FailureThreshold): boolean {
  if (threshold === "never") return false;
  const rank: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };
  return findings.some((finding) => rank[finding.severity] >= rank[threshold]);
}

function formatMarkdown(report: ReviewReport): string {
  const lines = [
    `# PRilot review: ${report.pullRequest.provider} PR ${report.pullRequest.pullRequestId}`,
    "",
    report.summary,
    "",
  ];
  if (report.limitations.length > 0) {
    lines.push("## Limitations", "", ...report.limitations.map((limitation) => `- ${limitation}`), "");
  }
  lines.push("## Findings", "");
  if (report.findings.length === 0) lines.push("No actionable findings.", "");
  for (const finding of report.findings) {
    const location = finding.path ? ` — ${finding.path}${finding.line ? `:${finding.line}` : ""}` : "";
    lines.push(
      `### ${finding.severity.toUpperCase()}: ${finding.title}${location}`,
      "",
      finding.body,
      "",
      `Publication: ${finding.publication.status}`,
      "",
    );
  }
  if (report.verification.length > 0) {
    lines.push("## Verification", "");
    for (const result of report.verification) {
      lines.push(`- ${result.id}: exit ${result.exitCode ?? "unknown"}${result.timedOut ? " (timed out)" : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
