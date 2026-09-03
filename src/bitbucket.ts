import { z } from "zod";
import type { LinkedIssue, PullRequest, PullRequestChange, PullRequestIdentity, ReviewComment } from "./domain.ts";
import { HttpClient } from "./http.ts";
import type { PullRequestProvider } from "./provider.ts";

const refSchema = z.object({
  id: z.string(),
  displayId: z.string(),
  latestCommit: z.string(),
}).passthrough();

const pullRequestSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  description: z.string().nullish(),
  fromRef: refSchema,
  toRef: refSchema,
  author: z.object({ user: z.object({ displayName: z.string().optional(), name: z.string().optional() }).passthrough() }).passthrough().optional(),
  draft: z.boolean().optional(),
}).passthrough();

const changeSchema = z.object({
  path: z.object({ toString: z.string() }).passthrough(),
  srcPath: z.object({ toString: z.string() }).passthrough().optional(),
  type: z.string().default("MODIFY"),
}).passthrough();

const commentSchema = z.object({
  id: z.number().int(),
  text: z.string().default(""),
  state: z.string().optional(),
  anchor: z.object({ path: z.string().optional(), line: z.number().int().optional() }).passthrough().optional(),
}).passthrough();

const activitySchema = z.object({ comment: commentSchema.optional() }).passthrough();
const linkedIssueSchema = z.object({
  key: z.string().min(1),
  url: z.string().url(),
}).passthrough();

const pageSchema = <T extends z.ZodType>(item: T) => z.object({
  values: z.array(item).default([]),
  isLastPage: z.boolean().optional(),
  nextPageStart: z.number().int().nullish(),
}).passthrough();

export interface BitbucketClientOptions {
  baseUrl: string;
  owner: string;
  repository: string;
  pullRequestId: number;
  token: string;
  http: HttpClient;
}

export class BitbucketClient implements PullRequestProvider {
  readonly identity: PullRequestIdentity;
  readonly cloneUrl: string;
  readonly sourceFetchRef: string;
  readonly gitAuthorizationHeader: string;
  readonly #baseUrl: string;
  readonly #projectKey: string;
  readonly #repositorySlug: string;
  readonly #pullRequestId: number;
  readonly #headers: HeadersInit;
  readonly #http: HttpClient;

  constructor(options: BitbucketClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#projectKey = options.owner;
    this.#repositorySlug = options.repository;
    this.#pullRequestId = options.pullRequestId;
    this.#headers = { Authorization: `Bearer ${options.token}`, Accept: "application/json" };
    this.#http = options.http;
    this.identity = {
      provider: "bitbucket",
      host: new URL(options.baseUrl).hostname,
      owner: options.owner,
      repository: options.repository,
      pullRequestId: options.pullRequestId,
      url: `${options.baseUrl}/projects/${encodeURIComponent(options.owner)}/repos/${encodeURIComponent(options.repository)}/pull-requests/${options.pullRequestId}`,
    };
    this.cloneUrl = `${options.baseUrl}/scm/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repository)}.git`;
    this.sourceFetchRef = `refs/pull-requests/${options.pullRequestId}/from`;
    this.gitAuthorizationHeader = `Bearer ${options.token}`;
  }

  async getPullRequest(): Promise<PullRequest> {
    const value = await this.#http.json(this.#prUrl(), { headers: this.#headers }, pullRequestSchema);
    return {
      id: value.id,
      title: value.title,
      description: value.description ?? "",
      sourceBranch: value.fromRef.displayId,
      sourceRef: value.fromRef.id,
      sourceHash: value.fromRef.latestCommit,
      targetBranch: value.toRef.displayId,
      targetRef: value.toRef.id,
      targetHash: value.toRef.latestCommit,
      ...(value.author?.user.displayName || value.author?.user.name
        ? { author: value.author.user.displayName ?? value.author.user.name ?? "" }
        : {}),
      draft: value.draft ?? false,
    };
  }

  async listChanges(): Promise<PullRequestChange[]> {
    const values = await this.#allPages(`${this.#prUrl()}/changes`, changeSchema);
    return values.map((value) => ({
      path: value.path.toString,
      ...(value.srcPath ? { sourcePath: value.srcPath.toString } : {}),
      type: value.type,
    }));
  }

  async listComments(): Promise<ReviewComment[]> {
    const activities = await this.#allPages(`${this.#prUrl()}/activities`, activitySchema);
    return activities.flatMap((activity) => activity.comment ? [mapComment(activity.comment)] : []);
  }

  async listLinkedIssues(): Promise<LinkedIssue[]> {
    const project = encodeURIComponent(this.#projectKey);
    const repository = encodeURIComponent(this.#repositorySlug);
    return this.#http.json(
      `${this.#baseUrl}/rest/jira/latest/projects/${project}/repos/${repository}/pull-requests/${this.#pullRequestId}/issues`,
      { headers: this.#headers },
      z.array(linkedIssueSchema),
    );
  }

  async postComment(text: string, anchor?: { path: string; line: number; sourceHash: string; targetHash: string }): Promise<number> {
    const bitbucketAnchor = anchor ? {
      fromHash: anchor.targetHash,
      toHash: anchor.sourceHash,
      line: anchor.line,
      lineType: "ADDED",
      fileType: "TO",
      path: anchor.path,
      diffType: "EFFECTIVE",
    } : undefined;
    const response = await this.#http.json(this.#prUrl() + "/comments", {
      method: "POST",
      headers: { ...this.#headers, "Content-Type": "application/json" },
      body: JSON.stringify({ text, ...(bitbucketAnchor ? { anchor: bitbucketAnchor } : {}) }),
    }, commentSchema);
    return response.id;
  }

  async #allPages<T>(url: string, itemSchema: z.ZodType<T>): Promise<T[]> {
    const result: T[] = [];
    let start = 0;
    for (let page = 0; page < 100; page += 1) {
      const separator = url.includes("?") ? "&" : "?";
      const value = await this.#http.json(`${url}${separator}limit=100&start=${start}`, { headers: this.#headers }, pageSchema(itemSchema));
      result.push(...value.values);
      if (value.isLastPage !== false || value.nextPageStart == null) return result;
      start = value.nextPageStart;
    }
    throw new Error("Bitbucket pagination exceeded 100 pages");
  }

  #prUrl(): string {
    const project = encodeURIComponent(this.#projectKey);
    const repository = encodeURIComponent(this.#repositorySlug);
    return `${this.#baseUrl}/rest/api/latest/projects/${project}/repos/${repository}/pull-requests/${this.#pullRequestId}`;
  }
}

function mapComment(comment: z.infer<typeof commentSchema>): ReviewComment {
  return {
    id: comment.id,
    text: comment.text,
    ...(comment.state ? { state: comment.state } : {}),
    ...(comment.anchor?.path ? { path: comment.anchor.path } : {}),
    ...(comment.anchor?.line ? { line: comment.anchor.line } : {}),
  };
}
