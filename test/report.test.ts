import { afterEach, expect, test } from "bun:test";
import type { PullRequest } from "../src/domain.ts";
import { GitRepository } from "../src/git.ts";
import { validateFindings } from "../src/report.ts";
import { createGitFixture, type GitFixture } from "./helpers.ts";

let fixture: GitFixture | undefined;
afterEach(async () => fixture?.cleanup());

test("validates anchors and rejects unchanged paths and duplicates", async () => {
  fixture = await createGitFixture();
  const pullRequest: PullRequest = {
    id: 7,
    title: "TEAM-123",
    description: "",
    sourceBranch: "feature",
    sourceRef: "refs/heads/feature",
    sourceHash: fixture.sourceHash,
    targetBranch: "main",
    targetRef: "refs/heads/main",
    targetHash: fixture.baseHash,
    draft: false,
  };
  const repository = new GitRepository(fixture.directory, 100_000);
  const result = await validateFindings({
    summary: "Found concrete issues",
    limitations: [],
    findings: [
      { severity: "high", category: "correctness", title: "Changed behavior", body: "This changed line breaks the required behavior; restore the guard.", path: "src/file.txt", line: 2 },
      { severity: "high", category: "correctness", title: "Changed behavior", body: "This changed line breaks the required behavior; restore the guard.", path: "src/file.txt", line: 2 },
      { severity: "low", category: "tests", title: "Wrong file", body: "This is long enough to pass structural validation.", path: "other.txt" },
    ],
  }, {
    provider: "github",
    host: "github.example.com",
    owner: "org",
    repositoryName: "repo",
    pullRequest,
    changes: [{ path: "src/file.txt", type: "MODIFY" }],
    mergeBase: fixture.baseHash,
    repository,
  });
  expect(result.findings).toHaveLength(1);
  expect(result.findings[0]?.anchorable).toBeTrue();
  expect(result.errors).toHaveLength(2);
});
