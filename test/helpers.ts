import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitFixture {
  directory: string;
  baseHash: string;
  sourceHash: string;
  cleanup: () => Promise<void>;
}

export async function createGitFixture(): Promise<GitFixture> {
  const directory = await mkdtemp(join(tmpdir(), "review-agent-test-"));
  await mkdir(join(directory, "src"));
  git(directory, ["init", "-q"]);
  git(directory, ["config", "user.email", "test@example.com"]);
  git(directory, ["config", "user.name", "Test"]);
  await Bun.write(join(directory, "src/file.txt"), "one\nold\n");
  git(directory, ["add", "."]);
  git(directory, ["commit", "-q", "-m", "base"]);
  const baseHash = git(directory, ["rev-parse", "HEAD"]);
  await Bun.write(join(directory, "src/file.txt"), "one\nnew\nthree\n");
  git(directory, ["add", "."]);
  git(directory, ["commit", "-q", "-m", "TEAM-123 change"]);
  const sourceHash = git(directory, ["rev-parse", "HEAD"]);
  return {
    directory,
    baseHash,
    sourceHash,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function git(directory: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", directory, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
