import type {
  LinkedIssue,
  PullRequest,
  PullRequestChange,
  PullRequestIdentity,
  ReviewComment,
} from "./domain.ts";

export interface PullRequestProvider {
  readonly identity: PullRequestIdentity;
  readonly cloneUrl: string;
  readonly sourceFetchRef?: string;
  readonly gitAuthorizationHeader: string;
  getPullRequest(): Promise<PullRequest>;
  listChanges(): Promise<PullRequestChange[]>;
  listComments(): Promise<ReviewComment[]>;
  listLinkedIssues(): Promise<LinkedIssue[]>;
  postComment(text: string, anchor?: { path: string; line: number; sourceHash: string; targetHash: string }): Promise<number>;
}
