import { z } from "zod";
import type { LinkedIssue, PullRequest, PullRequestChange, PullRequestIdentity, ReviewComment } from "./domain.ts";
import { HttpClient } from "./http.ts";
import type { PullRequestProvider } from "./provider.ts";

const userSchema = z.object({ login: z.string().optional() }).passthrough();
const repositorySchema = z.object({ clone_url: z.string().url() }).passthrough();
const refSchema = z.object({ ref: z.string(), sha: z.string(), repo: repositorySchema }).passthrough();
const pullRequestSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z.string().nullish(),
  draft: z.boolean().nullish(),
  user: userSchema.nullish(),
  head: refSchema,
  base: refSchema,
}).passthrough();
const fileSchema = z.object({
  filename: z.string(),
  previous_filename: z.string().optional(),
  status: z.string().default("modified"),
}).passthrough();
const commentSchema = z.object({
  id: z.number().int(),
  body: z.string().default(""),
  path: z.string().optional(),
  line: z.number().int().nullish(),
  original_line: z.number().int().nullish(),
}).passthrough();

export interface GitHubClientOptions {
  baseUrl: string;
  owner: string;
  repository: string;
  pullRequestId: number;
  token: string;
  http: HttpClient;
}

export class GitHubClient implements PullRequestProvider {
  readonly identity: PullRequestIdentity;
  readonly cloneUrl: string;
  readonly sourceFetchRef: string;
  readonly gitAuthorizationHeader: string;
  readonly #apiBaseUrl: string;
  readonly #headers: HeadersInit;
  readonly #http: HttpClient;
  readonly #owner: string;
  readonly #repository: string;
  readonly #pullRequestId: number;

  constructor(options: GitHubClientOptions) {
    const host = new URL(options.baseUrl).hostname;
    this.identity = {
      provider: "github",
      host,
      owner: options.owner,
      repository: options.repository,
      pullRequestId: options.pullRequestId,
      url: `${options.baseUrl}/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repository)}/pull/${options.pullRequestId}`,
    };
    this.cloneUrl = `${options.baseUrl}/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repository)}.git`;
    this.sourceFetchRef = `refs/pull/${options.pullRequestId}/head`;
    this.gitAuthorizationHeader = `Basic ${Buffer.from(`x-access-token:${options.token}`).toString("base64")}`;
    this.#apiBaseUrl = host === "github.com" ? "https://api.github.com" : `${options.baseUrl}/api/v3`;
    this.#owner = options.owner;
    this.#repository = options.repository;
    this.#pullRequestId = options.pullRequestId;
    this.#headers = {
      Authorization: `Bearer ${options.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    this.#http = options.http;
  }

  async getPullRequest(): Promise<PullRequest> {
    const value = await this.#http.json(this.#pullUrl(), { headers: this.#headers }, pullRequestSchema);
    return {
      id: value.number,
      title: value.title,
      description: value.body ?? "",
      sourceBranch: value.head.ref,
      sourceRef: this.sourceFetchRef,
      sourceHash: value.head.sha,
      targetBranch: value.base.ref,
      targetRef: `refs/heads/${value.base.ref}`,
      targetHash: value.base.sha,
      ...(value.user?.login ? { author: value.user.login } : {}),
      draft: value.draft ?? false,
    };
  }

  async listChanges(): Promise<PullRequestChange[]> {
    return (await this.#allPages(`${this.#pullUrl()}/files`, fileSchema)).map((file) => ({
      path: file.filename,
      ...(file.previous_filename ? { sourcePath: file.previous_filename } : {}),
      type: file.status.toUpperCase(),
    }));
  }

  async listComments(): Promise<ReviewComment[]> {
    const [reviewComments, issueComments] = await Promise.all([
      this.#allPages(`${this.#pullUrl()}/comments`, commentSchema),
      this.#allPages(`${this.#repositoryUrl()}/issues/${this.#pullRequestId}/comments`, commentSchema),
    ]);
    return [...reviewComments, ...issueComments].map((comment) => ({
      id: comment.id,
      text: comment.body,
      ...(comment.path ? { path: comment.path } : {}),
      ...(comment.line !== null && comment.line !== undefined
        ? { line: comment.line }
        : comment.original_line !== null && comment.original_line !== undefined
          ? { line: comment.original_line }
          : {}),
    }));
  }

  async listLinkedIssues(): Promise<LinkedIssue[]> {
    return [];
  }

  async postComment(text: string, anchor?: { path: string; line: number; sourceHash: string; targetHash: string }): Promise<number> {
    const url = anchor ? `${this.#pullUrl()}/comments` : `${this.#repositoryUrl()}/issues/${this.#pullRequestId}/comments`;
    const body = anchor
      ? { body: text, commit_id: anchor.sourceHash, path: anchor.path, line: anchor.line, side: "RIGHT" }
      : { body: text };
    const response = await this.#http.json(url, {
      method: "POST",
      headers: { ...this.#headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, commentSchema);
    return response.id;
  }

  async #allPages<T>(url: string, schema: z.ZodType<T>): Promise<T[]> {
    const result: T[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const separator = url.includes("?") ? "&" : "?";
      const values = await this.#http.json(`${url}${separator}per_page=100&page=${page}`, { headers: this.#headers }, z.array(schema));
      result.push(...values);
      if (values.length < 100) return result;
    }
    throw new Error("GitHub pagination exceeded 100 pages");
  }

  #repositoryUrl(): string {
    return `${this.#apiBaseUrl}/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repository)}`;
  }

  #pullUrl(): string {
    return `${this.#repositoryUrl()}/pulls/${this.#pullRequestId}`;
  }
}
