import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

const valid = {
  PR_URL: "https://code.example.com/projects/PROJ/repos/repo/pull-requests/42/overview",
  BITBUCKET_TOKEN: "bitbucket-secret",
  COPILOT_GITHUB_TOKEN: "copilot-secret",
  PUBLISH: "false",
  SOURCE_DIR: "/workspace/source/services/api",
  VERIFICATION_COMMANDS_JSON: '[{"id":"test","argv":["bun","test"],"timeoutSeconds":30}]',
};

describe("loadConfig", () => {
  test("parses trusted commands without a shell string", () => {
    const config = loadConfig(valid);
    expect(config.pullRequest.baseUrl).toBe("https://code.example.com");
    expect(config.pullRequest.provider).toBe("bitbucket");
    expect(config.pullRequest.owner).toBe("PROJ");
    expect(config.pullRequest.repository).toBe("repo");
    expect(config.pullRequest.pullRequestId).toBe(42);
    expect(config.sourceDirectory).toBe("/workspace/source/services/api");
    expect(config.publish).toBeFalse();
    expect(config.copilotToken).toBe("copilot-secret");
    expect(config.verificationCommands[0]?.argv).toEqual(["bun", "test"]);
  });

  test("uses safe defaults for omitted runtime controls", () => {
    const { PUBLISH: _publish, SOURCE_DIR: _sourceDirectory, VERIFICATION_COMMANDS_JSON: _commands, ...required } = valid;
    const config = loadConfig(required, "/pipeline/checkout");
    expect(config.publish).toBeFalse();
    expect(config.sourceDirectory).toContain("prilot");
    expect(config.verificationCommands).toEqual([]);
  });

  test("requires an exact boolean", () => {
    expect(() => loadConfig({ ...valid, PUBLISH: "yes" })).toThrow();
  });

  test("supports Bitbucket context paths and derives identifiers", () => {
    const config = loadConfig({
      ...valid,
      PR_URL: "https://code.example.com/bitbucket/projects/TEAM/repos/service/pull-requests/3232",
    });
    expect(config.pullRequest).toMatchObject({
      baseUrl: "https://code.example.com/bitbucket",
      owner: "TEAM",
      repository: "service",
      pullRequestId: 3232,
    });
  });

  test("rejects URLs that do not identify a pull request", () => {
    expect(() => loadConfig({ ...valid, PR_URL: "https://code.example.com/projects/PROJ/repos/repo" })).toThrow("must point to");
  });

  test("normalizes empty optional configuration", () => {
    const config = loadConfig({ ...valid, JIRA_TOKEN: "" });
    expect(config.jira).toBeUndefined();
  });

  test("parses GitHub pull request URLs and requires the matching token", () => {
    const { BITBUCKET_TOKEN: _bitbucket, ...rest } = valid;
    const config = loadConfig({
      ...rest,
      PR_URL: "https://github.com/acme/widgets/pull/17/files",
      GITHUB_TOKEN: "github-secret",
    });
    expect(config.pullRequest).toMatchObject({
      provider: "github",
      owner: "acme",
      repository: "widgets",
      pullRequestId: 17,
      token: "github-secret",
    });
  });

  test("reuses only a same-host checkout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prilot-config-test-"));
    try {
      Bun.spawnSync(["git", "-C", directory, "init", "-q"]);
      Bun.spawnSync(["git", "-C", directory, "remote", "add", "origin", "https://other.example/acme/widgets.git"]);
      const { BITBUCKET_TOKEN: _bitbucket, SOURCE_DIR: _source, ...rest } = valid;
      const env = { ...rest, PR_URL: "https://github.com/acme/widgets/pull/17", GITHUB_TOKEN: "github-secret" };
      expect(loadConfig(env, directory).sourceDirectory).not.toBe(directory);

      Bun.spawnSync(["git", "-C", directory, "remote", "set-url", "origin", "git@github.com:acme/widgets.git"]);
      expect(loadConfig(env, directory).sourceDirectory).toBe(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
