import { expect, test } from "bun:test";
import type { PullRequestProvider } from "../src/provider.ts";
import type { Finding, PullRequest } from "../src/domain.ts";
import { publishFindings } from "../src/publisher.ts";
import { fingerprintMarker } from "../src/report.ts";

const pullRequest: PullRequest = {
  id: 1,
  title: "PR",
  description: "",
  sourceBranch: "feature",
  sourceRef: "refs/heads/feature",
  sourceHash: "source",
  targetBranch: "main",
  targetRef: "refs/heads/main",
  targetHash: "target",
  draft: false,
};

function finding(fingerprint: string, anchorable: boolean): Finding {
  return {
    severity: "high",
    title: `Finding ${fingerprint}`,
    body: "A concrete problem that requires a specific correction.",
    path: "src/file.ts",
    line: 2,
    fingerprint,
    anchorable,
    publication: { status: "dry-run" },
  };
}

test("dry-run never calls the pull request provider", async () => {
  let posts = 0;
  const provider = { postComment: async () => ++posts } as unknown as PullRequestProvider;
  const result = await publishFindings({ enabled: false, findings: [finding("a", true)], existingComments: [], pullRequest, provider });
  expect(posts).toBe(0);
  expect(result.publishedCount).toBe(0);
});

test("skips active fingerprints and publishes inline and aggregate comments", async () => {
  const payloads: Array<{ text: string; anchor?: Record<string, unknown> }> = [];
  const provider = {
    postComment: async (text: string, anchor?: Record<string, unknown>) => {
      payloads.push({ text, ...(anchor ? { anchor } : {}) });
      return payloads.length;
    },
  } as unknown as PullRequestProvider;
  const findings = [finding("existing", true), finding("inline", true), finding("general", false)];
  const result = await publishFindings({
    enabled: true,
    findings,
    existingComments: [{ id: 9, text: fingerprintMarker("existing"), state: "OPEN" }],
    pullRequest,
    provider,
  });
  expect(result).toMatchObject({ publishedCount: 2, skippedCount: 1, failedCount: 0 });
  expect(payloads).toHaveLength(2);
  expect(payloads[0]?.anchor).toMatchObject({ path: "src/file.ts", line: 2, sourceHash: "source", targetHash: "target" });
  expect(payloads[1]?.anchor).toBeUndefined();
});

test("records partial publication failure for an idempotent retry", async () => {
  let calls = 0;
  const provider = {
    postComment: async () => {
      calls += 1;
      if (calls === 1) throw new Error("HTTP 503 from configured endpoint");
      return 2;
    },
  } as unknown as PullRequestProvider;
  const findings = [finding("first", true), finding("second", true)];
  const result = await publishFindings({ enabled: true, findings, existingComments: [], pullRequest, provider });
  expect(result).toMatchObject({ publishedCount: 1, failedCount: 1 });
  expect(findings[0]?.publication.status).toBe("failed");
  expect(findings[1]?.publication.status).toBe("published");
});
