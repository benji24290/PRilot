import { z } from "zod";
import type { IssueContext, LinkedIssue } from "./domain.ts";
import { HttpClient } from "./http.ts";

const issueSchema = z.object({
  key: z.string(),
  fields: z.object({
    summary: z.string().default(""),
    description: z.unknown().nullish(),
    status: z.object({ name: z.string().optional() }).passthrough().nullish(),
    priority: z.object({ name: z.string().optional() }).passthrough().nullish(),
    issuetype: z.object({ name: z.string().optional() }).passthrough().nullish(),
    attachment: z.array(z.object({ filename: z.string().optional() }).passthrough()).default([]),
    comment: z.object({
      comments: z.array(z.object({ body: z.unknown().nullish() }).passthrough()).default([]),
    }).passthrough().nullish(),
  }).passthrough(),
}).passthrough();

export class JiraClient {
  constructor(
    readonly token: string,
    readonly http: HttpClient,
    readonly options: { email?: string; apiVersion?: string } = {},
  ) {}

  async getIssue(link: LinkedIssue): Promise<IssueContext> {
    const baseUrl = jiraBaseUrl(link);
    const authorization = this.options.email
      ? `Basic ${Buffer.from(`${this.options.email}:${this.token}`).toString("base64")}`
      : `Bearer ${this.token}`;
    const issue = await this.http.json(
      `${baseUrl}/rest/api/${this.options.apiVersion ?? "latest"}/issue/${encodeURIComponent(link.key)}`,
      { headers: { Authorization: authorization, Accept: "application/json" } },
      issueSchema,
    );
    return {
      key: issue.key,
      summary: issue.fields.summary,
      description: renderContent(issue.fields.description, 30_000),
      ...(issue.fields.status?.name ? { status: issue.fields.status.name } : {}),
      ...(issue.fields.priority?.name ? { priority: issue.fields.priority.name } : {}),
      ...(issue.fields.issuetype?.name ? { issueType: issue.fields.issuetype.name } : {}),
      comments: issue.fields.comment?.comments.map((comment) => renderContent(comment.body, 4_000)).filter(Boolean).slice(-20) ?? [],
      attachments: issue.fields.attachment.map((attachment) => attachment.filename).filter((value): value is string => Boolean(value)),
    };
  }

}

function jiraBaseUrl(link: LinkedIssue): string {
  const url = new URL(link.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error(`Invalid Jira issue URL for ${link.key}`);
  }
  const suffix = `/browse/${encodeURIComponent(link.key)}`;
  if (!url.pathname.endsWith(suffix)) {
    throw new Error(`Jira issue URL for ${link.key} must end with ${suffix}`);
  }
  const contextPath = url.pathname.slice(0, -suffix.length).replace(/\/$/, "");
  return `${url.origin}${contextPath}`;
}

function renderContent(value: unknown, limit: number): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated]`;
}
