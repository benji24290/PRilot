import { describe, expect, test } from "bun:test";
import { BitbucketClient } from "../src/bitbucket.ts";
import { HttpClient } from "../src/http.ts";
import { JiraClient } from "../src/jira.ts";
import { GitHubClient } from "../src/github.ts";

describe("BitbucketClient", () => {
  test("maps PR metadata and follows paginated changes", async () => {
    const requests: string[] = [];
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret");
      if (url.includes("/rest/jira/")) {
        return Response.json([
          { key: "TEAM-12", url: "https://jira.example.com/browse/TEAM-12" },
          { key: "TEAM-13", url: "https://jira.example.com/browse/TEAM-13" },
        ]);
      }
      if (url.includes("/changes") && url.includes("start=0")) {
        return Response.json({ values: [{ path: { toString: "a.ts" }, type: "ADD" }], isLastPage: false, nextPageStart: 1 });
      }
      if (url.includes("/changes") && url.includes("start=1")) {
        return Response.json({
          values: [{ path: { toString: "b.ts" }, srcPath: { toString: "old.ts" }, type: "MOVE" }],
          isLastPage: true,
          nextPageStart: null,
        });
      }
      return Response.json({
        id: 12,
        title: "TEAM-12 title",
        description: null,
        fromRef: { id: "refs/heads/feature", displayId: "feature", latestCommit: "source" },
        toRef: { id: "refs/heads/main", displayId: "main", latestCommit: "target" },
        author: { user: { displayName: "Reviewer" } },
        draft: false,
      });
    };
    const client = new BitbucketClient({
      baseUrl: "https://code.example.com",
      projectKey: "PROJ",
      repositorySlug: "repo",
      pullRequestId: 12,
      token: "secret",
      http: new HttpClient({ timeoutMs: 1_000, maxRetries: 0, fetch: fakeFetch as unknown as typeof fetch }),
    });
    expect(await client.getPullRequest()).toMatchObject({ id: 12, sourceHash: "source", targetHash: "target", description: "" });
    expect(await client.listChanges()).toEqual([
      { path: "a.ts", type: "ADD" },
      { path: "b.ts", sourcePath: "old.ts", type: "MOVE" },
    ]);
    expect(await client.listLinkedIssues()).toEqual([
      { key: "TEAM-12", url: "https://jira.example.com/browse/TEAM-12" },
      { key: "TEAM-13", url: "https://jira.example.com/browse/TEAM-13" },
    ]);
    expect(requests).toContain("https://code.example.com/rest/jira/latest/projects/PROJ/repos/repo/pull-requests/12/issues");
    expect(requests.filter((url) => url.includes("/changes"))).toHaveLength(2);
  });
});

describe("JiraClient", () => {
  test("maps text and structured issue content without exposing the token", async () => {
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://jira.example.com/rest/api/latest/issue/TEAM-12");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer jira-secret");
      return Response.json({
        key: "TEAM-12",
        fields: {
          summary: "Acceptance summary",
          description: { type: "doc", content: [{ type: "paragraph" }] },
          status: { name: "Open" },
          priority: { name: "High" },
          issuetype: { name: "Story" },
          attachment: [{ filename: "example.txt" }],
          comment: { comments: [{ body: "Acceptance detail" }] },
        },
      });
    };
    const issue = await new JiraClient(
      "jira-secret",
      new HttpClient({ timeoutMs: 1_000, maxRetries: 0, fetch: fakeFetch as unknown as typeof fetch }),
    ).getIssue({ key: "TEAM-12", url: "https://jira.example.com/browse/TEAM-12" });
    expect(issue).toMatchObject({ key: "TEAM-12", summary: "Acceptance summary", status: "Open", attachments: ["example.txt"] });
    expect(issue.description).toContain('"type":"doc"');
  });
});

describe("GitHubClient", () => {
  test("maps pull request metadata and paginated files", async () => {
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer github-secret");
      if (url.includes("/files?")) return Response.json([{ filename: "src/new.ts", status: "added" }]);
      if (url.includes("/comments?")) return Response.json([]);
      return Response.json({
        number: 8,
        title: "TEAM-8 feature",
        body: "Description",
        draft: false,
        user: { login: "octocat" },
        head: { ref: "feature", sha: "source", repo: { clone_url: "https://github.com/acme/widgets.git" } },
        base: { ref: "main", sha: "target", repo: { clone_url: "https://github.com/acme/widgets.git" } },
      });
    };
    const client = new GitHubClient({
      baseUrl: "https://github.com",
      owner: "acme",
      repository: "widgets",
      pullRequestId: 8,
      token: "github-secret",
      http: new HttpClient({ timeoutMs: 1_000, maxRetries: 0, fetch: fakeFetch as unknown as typeof fetch }),
    });
    expect(await client.getPullRequest()).toMatchObject({ id: 8, sourceHash: "source", targetHash: "target", author: "octocat" });
    expect(await client.listChanges()).toEqual([{ path: "src/new.ts", type: "ADDED" }]);
    expect(client.sourceFetchRef).toBe("refs/pull/8/head");
  });
});
