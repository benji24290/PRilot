import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRepository, normalizeRepoPath, prepareRepository, runCommand } from "../src/git.ts";
import { createGitFixture, type GitFixture } from "./helpers.ts";

let fixture: GitFixture | undefined;
let temporaryDirectory: string | undefined;
afterEach(async () => {
  await fixture?.cleanup();
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  fixture = undefined;
  temporaryDirectory = undefined;
});

describe("GitRepository", () => {
  test("reads exact revisions and changed lines without changing the worktree", async () => {
    fixture = await createGitFixture();
    const repository = new GitRepository(fixture.directory, 100_000);
    await repository.ensureSource(fixture.sourceHash);
    expect(await repository.mergeBase(fixture.baseHash, fixture.sourceHash)).toBe(fixture.baseHash);
    expect(await repository.readFile(fixture.sourceHash, "src/file.txt", 2, 3)).toContain("2: new");
    expect(await repository.addedLines(fixture.baseHash, fixture.sourceHash, "src/file.txt")).toEqual(new Set([2, 3]));
    await Bun.write(join(fixture.directory, "untracked.txt"), "preserve me");
    await repository.diff(fixture.baseHash, fixture.sourceHash);
    expect(await Bun.file(join(fixture.directory, "untracked.txt")).text()).toBe("preserve me");
  });

  test("rejects a checkout mismatch without changing the worktree", async () => {
    fixture = await createGitFixture();
    const repository = new GitRepository(fixture.directory, 100_000);
    Bun.spawnSync(["git", "-C", fixture.directory, "checkout", "--detach", fixture.baseHash]);
    await Bun.write(join(fixture.directory, "local.txt"), "preserve me");

    await expect(repository.ensureSource(fixture.sourceHash)).rejects.toThrow("does not match PR source");
    expect(await repository.head()).toBe(fixture.baseHash);
    expect(await Bun.file(join(fixture.directory, "local.txt")).text()).toBe("preserve me");
  });

  test("clones and checks out the pull request source when no checkout exists", async () => {
    fixture = await createGitFixture();
    temporaryDirectory = await mkdtemp(join(tmpdir(), "difflynx-checkout-test-"));
    const checkout = join(temporaryDirectory, "repository");
    const repository = await prepareRepository({
      directory: checkout,
      cloneUrl: fixture.directory,
      sourceHash: fixture.sourceHash,
      sourceRef: "refs/heads/master",
      targetHash: fixture.baseHash,
      targetRef: "refs/heads/master",
      maxOutputBytes: 100_000,
    });
    expect(await repository.head()).toBe(fixture.sourceHash);
    expect(await Bun.file(join(checkout, "src/file.txt")).text()).toContain("new");
  });

  test("moves a clean existing checkout to the pull request source", async () => {
    fixture = await createGitFixture();
    Bun.spawnSync(["git", "-C", fixture.directory, "checkout", "--detach", fixture.baseHash]);
    const repository = await prepareRepository({
      directory: fixture.directory,
      cloneUrl: fixture.directory,
      sourceHash: fixture.sourceHash,
      sourceRef: "refs/heads/master",
      targetHash: fixture.baseHash,
      targetRef: "refs/heads/master",
      maxOutputBytes: 100_000,
    });
    expect(await repository.head()).toBe(fixture.sourceHash);
  });

  test("refuses to review an existing checkout with local changes", async () => {
    fixture = await createGitFixture();
    await Bun.write(join(fixture.directory, "local.txt"), "not part of the PR");
    await expect(prepareRepository({
      directory: fixture.directory,
      cloneUrl: fixture.directory,
      sourceHash: fixture.sourceHash,
      sourceRef: "refs/heads/master",
      targetHash: fixture.baseHash,
      targetRef: "refs/heads/master",
      maxOutputBytes: 100_000,
    })).rejects.toThrow("local changes");
  });

  test("rejects path traversal", () => {
    expect(() => normalizeRepoPath("../etc/passwd")).toThrow("Unsafe");
    expect(() => normalizeRepoPath("/absolute")).toThrow("Unsafe");
  });

  test("redacts configured secrets from verification results", async () => {
    fixture = await createGitFixture();
    const repository = new GitRepository(fixture.directory, 100_000, undefined, ["supersecret"]);
    const result = await repository.runVerification({
      id: "redaction",
      argv: [process.execPath, "-e", "console.log('supersecret')"],
      timeoutSeconds: 10,
    });
    expect(result.stdout).toContain("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain("supersecret");
  });

  test("runs argv without a shell and truncates bounded output", async () => {
    fixture = await createGitFixture();
    const result = await runCommand([
      process.execPath,
      "-e",
      "process.stdout.write(process.argv.at(-1).repeat(10))",
      "$(echo-not-executed)",
    ], {
      cwd: fixture.directory,
      timeoutMs: 10_000,
      maxOutputBytes: 20,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toStartWith("$(echo-not-executed)");
    expect(result.stdout).toEndWith("[output truncated]");
  });

  test("terminates verification commands that exceed their timeout", async () => {
    fixture = await createGitFixture();
    const result = await runCommand([
      process.execPath,
      "-e",
      "setTimeout(() => undefined, 10_000)",
    ], {
      cwd: fixture.directory,
      timeoutMs: 50,
      maxOutputBytes: 1_000,
    });

    expect(result.timedOut).toBeTrue();
    expect(result.exitCode).not.toBe(0);
  });
});
