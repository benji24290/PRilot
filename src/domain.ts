import { z } from "zod";

export const severitySchema = z.enum(["critical", "high", "medium", "low"]);
export type Severity = z.infer<typeof severitySchema>;

export const findingInputSchema = z.object({
  severity: severitySchema,
  category: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(180),
  body: z.string().trim().min(10).max(4_000),
  path: z.string().trim().min(1).max(1_000).optional(),
  line: z.number().int().positive().optional(),
}).refine((value) => value.line === undefined || value.path !== undefined, {
  message: "line requires path",
});

export const reviewSubmissionSchema = z.object({
  summary: z.string().trim().min(1).max(4_000),
  limitations: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  findings: z.array(findingInputSchema).max(100),
});

export type FindingInput = z.infer<typeof findingInputSchema>;
export type ReviewSubmission = z.infer<typeof reviewSubmissionSchema>;

export interface PullRequest {
  id: number;
  title: string;
  description: string;
  sourceBranch: string;
  sourceRef: string;
  sourceHash: string;
  targetBranch: string;
  targetRef: string;
  targetHash: string;
  author?: string;
  draft: boolean;
}

export type PullRequestProviderName = "github" | "bitbucket";

export interface PullRequestLocator {
  provider: PullRequestProviderName;
  baseUrl: string;
  owner: string;
  repository: string;
  pullRequestId: number;
  url: string;
}

export interface PullRequestIdentity {
  provider: PullRequestProviderName;
  host: string;
  owner: string;
  repository: string;
  pullRequestId: number;
  url: string;
}

export interface PullRequestChange {
  path: string;
  sourcePath?: string;
  type: string;
}

export interface ReviewComment {
  id: number;
  text: string;
  state?: string;
  path?: string;
  line?: number;
}

export interface IssueContext {
  key: string;
  summary: string;
  description: string;
  status?: string;
  priority?: string;
  issueType?: string;
  comments: string[];
  attachments: string[];
}

export interface LinkedIssue {
  key: string;
  url: string;
}

export interface VerificationCommand {
  id: string;
  argv: string[];
  timeoutSeconds: number;
}

export interface VerificationResult {
  id: string;
  argv: string[];
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export type PublicationStatus = "dry-run" | "published" | "skipped-existing" | "failed";

export interface Finding extends FindingInput {
  fingerprint: string;
  anchorable: boolean;
  publication: {
    status: PublicationStatus;
    commentId?: number;
    error?: string;
  };
}

export interface ReviewReport {
  version: 2;
  generatedAt: string;
  status: "clean" | "findings" | "incomplete";
  pullRequest: {
    id: number;
    title: string;
    provider: PullRequestProviderName;
    host: string;
    owner: string;
    repository: string;
    sourceBranch: string;
    sourceHash: string;
    targetBranch: string;
    targetHash: string;
  };
  issues: Array<Pick<IssueContext, "key" | "summary" | "status" | "priority" | "issueType">>;
  model: string;
  summary: string;
  limitations: string[];
  verification: VerificationResult[];
  findings: Finding[];
  publication: {
    enabled: boolean;
    publishedCount: number;
    skippedCount: number;
    failedCount: number;
  };
}
