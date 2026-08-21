import type { LinkedIssue, PullRequest } from "./domain.ts";

const ISSUE_KEY = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
const BROWSE_URL = /https?:\/\/[^\s<>()\]"']+\/browse\/([A-Z][A-Z0-9]+-\d+)\b/g;

export function discoverLinkedIssues(
  pullRequest: PullRequest,
  providerLinks: LinkedIssue[],
  jiraBaseUrl?: string,
): LinkedIssue[] {
  const result = new Map<string, LinkedIssue>();
  for (const link of providerLinks) result.set(link.key.toUpperCase(), link);
  const text = [pullRequest.title, pullRequest.description, pullRequest.sourceBranch].join("\n");
  for (const match of text.matchAll(BROWSE_URL)) {
    const key = match[1]?.toUpperCase();
    const url = match[0]?.replace(/[.,;:!?]+$/, "");
    if (key && url) result.set(key, { key, url });
  }
  if (jiraBaseUrl) {
    for (const match of text.matchAll(ISSUE_KEY)) {
      const key = match[1]?.toUpperCase();
      if (key && !result.has(key)) result.set(key, { key, url: `${jiraBaseUrl.replace(/\/$/, "")}/browse/${encodeURIComponent(key)}` });
    }
  }
  return [...result.values()];
}
