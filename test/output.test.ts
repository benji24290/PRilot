import { describe, expect, test } from "bun:test";
import type { Finding } from "../src/domain.ts";
import { parseArguments } from "../src/cli.ts";
import { createReviewReport, formatReviewReport, reachesFailureThreshold } from "../src/output.ts";

const findings: Finding[] = [{
  severity: "high",
  title: "Authorization bypass",
  body: "The new endpoint no longer checks administrator permissions.",
  path: "src/users.ts",
  line: 12,
  fingerprint: "fingerprint",
  anchorable: true,
  publication: { status: "dry-run" },
}];

describe("pipeline output", () => {
  test("parses JSON, output, and failure-threshold options", () => {
    expect(parseArguments([
      "https://github.com/acme/widgets/pull/1",
      "--format", "json",
      "--output", "review.json",
      "--fail-on", "high",
    ])).toMatchObject({ format: "json", outputPath: "review.json", failOn: "high" });
  });

  test("rejects invalid output controls", () => {
    expect(() => parseArguments(["--format", "xml"])).toThrow("markdown or json");
    expect(() => parseArguments(["--fail-on", "warning"])).toThrow("never, low, medium, high, or critical");
  });

  test("emits a versioned JSON report without losing finding details", () => {
    const report = createReviewReport({
      identity: { provider: "github", host: "github.com", owner: "acme", repository: "widgets", pullRequestId: 1, url: "https://github.com/acme/widgets/pull/1" },
      pullRequest: { id: 1, title: "Change", description: "", sourceBranch: "feature", sourceRef: "feature", sourceHash: "source", targetBranch: "main", targetRef: "main", targetHash: "target", draft: false },
      summary: "One issue",
      limitations: [],
      findings,
      verification: [],
      publication: { publishedCount: 0, skippedCount: 0, failedCount: 0, errors: [] },
    });
    const parsed = JSON.parse(formatReviewReport(report, "json"));
    expect(parsed).toMatchObject({ schemaVersion: 1, status: "findings", findings: [{ title: "Authorization bypass" }] });
  });

  test("fails only at or above the configured severity", () => {
    expect(reachesFailureThreshold(findings, "critical")).toBeFalse();
    expect(reachesFailureThreshold(findings, "high")).toBeTrue();
    expect(reachesFailureThreshold(findings, "medium")).toBeTrue();
    expect(reachesFailureThreshold(findings, "never")).toBeFalse();
  });
});
