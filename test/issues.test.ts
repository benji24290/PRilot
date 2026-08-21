import { expect, test } from "bun:test";
import type { PullRequest } from "../src/domain.ts";
import { discoverLinkedIssues } from "../src/issues.ts";

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 1,
    title: "ACME-42 add retries",
    description: "See https://jira.example.com/browse/OPS-7.",
    sourceBranch: "feature/ACME-42",
    sourceRef: "refs/heads/feature/ACME-42",
    sourceHash: "source",
    targetBranch: "main",
    targetRef: "refs/heads/main",
    targetHash: "target",
    draft: false,
    ...overrides,
  };
}

test("discovers explicit Jira links and issue keys without duplicates", () => {
  expect(discoverLinkedIssues(pullRequest(), [], "https://jira.example.com")).toEqual([
    { key: "OPS-7", url: "https://jira.example.com/browse/OPS-7" },
    { key: "ACME-42", url: "https://jira.example.com/browse/ACME-42" },
  ]);
});

test("keeps provider links and explicit URLs when Jira base URL is not configured", () => {
  const linked = [{ key: "TEAM-9", url: "https://work.example.com/browse/TEAM-9" }];
  expect(discoverLinkedIssues(pullRequest({ title: "No issue" }), linked)).toEqual([
    ...linked,
    { key: "OPS-7", url: "https://jira.example.com/browse/OPS-7" },
  ]);
});
