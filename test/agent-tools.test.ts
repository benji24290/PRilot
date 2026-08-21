import { expect, test } from "bun:test";
import type { AgentContext } from "../src/agent.ts";
import { createReviewTools } from "../src/agent.ts";
import type { GitRepository } from "../src/git.ts";

const repository = {
  diff: async () => "diff",
  readFile: async () => "1: content",
  search: async () => "",
  runVerification: async (command: { id: string; argv: string[] }) => ({
    id: command.id, argv: command.argv, exitCode: 0, timedOut: false, stdout: "", stderr: "", durationMs: 1,
  }),
} as unknown as GitRepository;

const context: AgentContext = {
  provider: "github",
  host: "github.example.com",
  owner: "org",
  repositoryName: "repo",
  pullRequest: {
    id: 1, title: "PR", description: "", sourceBranch: "feature", sourceRef: "refs/heads/feature", sourceHash: "source",
    targetBranch: "main", targetRef: "refs/heads/main", targetHash: "target", draft: false,
  },
  issues: [],
  changes: [{ path: "file.ts", type: "MODIFY" }],
  comments: [],
  mergeBase: "base",
  repository,
  verificationCommands: [{ id: "tests", argv: ["bun", "test"], timeoutSeconds: 60 }],
};

test("exposes only the constrained tool surface", () => {
  const tools = createReviewTools(context, [], new Map());
  expect(tools.map((tool) => tool.name)).toEqual([
    "list_changed_files", "get_diff", "read_file", "search_repo", "get_existing_comments", "run_verification", "submit_review",
  ]);
  expect(tools.every((tool) => tool.skipPermission && tool.defer === "never")).toBeTrue();
});

test("verification accepts only configured command ids", async () => {
  const tools = createReviewTools(context, [], new Map());
  const run = tools.find((tool) => tool.name === "run_verification")?.handler;
  await expect(run?.({ id: "arbitrary" }, {} as never)).rejects.toThrow("Unknown verification command");
});
