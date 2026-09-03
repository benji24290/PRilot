import { spawn } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { VerificationCommand, VerificationResult } from "./domain.ts";

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export class GitRepository {
  constructor(
    readonly directory: string,
    readonly maxOutputBytes: number,
    readonly gitAuthorizationHeader?: string,
    readonly redactedSecrets: string[] = [],
  ) {}

  async head(): Promise<string> {
    return (await this.#git(["rev-parse", "HEAD"])).stdout.trim();
  }

  async prepareCheckout(sourceHash: string, sourceRef: string, targetHash: string, targetRef: string, materialize = false): Promise<void> {
    await this.#ensureCommit(sourceHash, sourceRef, "source");
    await this.#ensureCommit(targetHash, targetRef, "target");
    const head = await this.head();
    if (materialize) {
      const checkout = await this.#git(["checkout", "--force", "--detach", sourceHash], true);
      if (checkout.exitCode !== 0) throw new Error(`Unable to materialize PR source commit ${sourceHash}: ${clip(checkout.stderr, 1_000)}`);
      return;
    }
    const status = await this.#git(["status", "--porcelain", "--untracked-files=normal"]);
    if (status.stdout.trim()) {
      throw new Error(`Checkout ${this.directory} has local changes; refusing to review an unclean worktree`);
    }
    if (head === sourceHash) return;
    const checkout = await this.#git(["checkout", "--detach", sourceHash], true);
    if (checkout.exitCode !== 0 || await this.head() !== sourceHash) {
      throw new Error(`Unable to check out PR source commit ${sourceHash}: ${clip(checkout.stderr, 1_000)}`);
    }
  }

  async hasCommit(hash: string): Promise<boolean> {
    const result = await this.#git(["cat-file", "-e", `${hash}^{commit}`], true);
    return result.exitCode === 0;
  }

  async mergeBase(targetHash: string, sourceHash: string): Promise<string> {
    return (await this.#git(["merge-base", targetHash, sourceHash])).stdout.trim();
  }

  async diff(baseHash: string, sourceHash: string, path?: string): Promise<string> {
    const args = ["diff", "--no-ext-diff", "--no-color", "--find-renames", `${baseHash}..${sourceHash}`];
    if (path) args.push("--", normalizeRepoPath(path));
    return (await this.#git(args)).stdout;
  }

  async changedPaths(baseHash: string, sourceHash: string): Promise<string[]> {
    const output = (await this.#git(["diff", "--name-only", "-z", `${baseHash}..${sourceHash}`])).stdout;
    return output.split("\0").filter(Boolean);
  }

  async addedLines(baseHash: string, sourceHash: string, path: string): Promise<Set<number>> {
    const normalized = normalizeRepoPath(path);
    const output = (await this.#git([
      "diff", "--unified=0", "--no-ext-diff", "--no-color", `${baseHash}..${sourceHash}`, "--", normalized,
    ])).stdout;
    const lines = new Set<number>();
    for (const line of output.split("\n")) {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match?.[1]) continue;
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      for (let index = 0; index < count; index += 1) lines.add(start + index);
    }
    return lines;
  }

  async readFile(revision: string, path: string, startLine = 1, endLine = 400): Promise<string> {
    const normalized = normalizeRepoPath(path);
    if (startLine < 1 || endLine < startLine || endLine - startLine > 1_000) {
      throw new Error("Requested line range is invalid or exceeds 1001 lines");
    }
    const result = await this.#git(["show", `${revision}:${normalized}`], true);
    if (result.exitCode !== 0) throw new Error(`File ${normalized} does not exist at the selected revision`);
    return result.stdout.split("\n").slice(startLine - 1, endLine).map((line, index) => `${startLine + index}: ${line}`).join("\n");
  }

  async fileExists(revision: string, path: string): Promise<boolean> {
    const result = await this.#git(["cat-file", "-e", `${revision}:${normalizeRepoPath(path)}`], true);
    return result.exitCode === 0;
  }

  async search(revision: string, query: string, pathPrefix?: string): Promise<string> {
    if (!query || query.length > 500 || query.includes("\0")) throw new Error("Search query is invalid");
    const args = ["grep", "-n", "-I", "-F", "-e", query, revision, "--"];
    if (pathPrefix) args.push(normalizeRepoPath(pathPrefix));
    const result = await this.#git(args, true);
    if (result.exitCode === 1) return "";
    if (result.exitCode !== 0) throw new Error(`Git search failed: ${clip(result.stderr, 1_000)}`);
    return result.stdout;
  }

  async runVerification(command: VerificationCommand): Promise<VerificationResult> {
    const result = await runCommand(command.argv, {
      cwd: this.directory,
      timeoutMs: command.timeoutSeconds * 1_000,
      maxOutputBytes: this.maxOutputBytes,
      env: verificationEnvironment(),
    });
    return {
      id: command.id,
      argv: command.argv.map((argument) => this.#redact(argument)),
      ...result,
      stdout: this.#redact(result.stdout),
      stderr: this.#redact(result.stderr),
    };
  }

  async #git(args: string[], allowFailure = false, env?: Record<string, string>): Promise<CommandResult> {
    const result = await runCommand(["git", "-C", this.directory, ...args], {
      cwd: this.directory,
      timeoutMs: 120_000,
      maxOutputBytes: this.maxOutputBytes,
      ...(env ? { env: { ...verificationEnvironment(), ...env } } : {}),
    });
    if (!allowFailure && result.exitCode !== 0) {
      throw new Error(`Git command failed: ${clip(result.stderr, 1_000)}`);
    }
    return result;
  }

  async #ensureCommit(hash: string, ref: string, label: string): Promise<void> {
    if (await this.hasCommit(hash)) return;
    const refspec = ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
    const environment = this.gitAuthorizationHeader ? gitAuthEnvironment(this.gitAuthorizationHeader) : undefined;
    const fetch = await this.#git(["fetch", "--no-tags", "origin", refspec], true, environment);
    if (fetch.exitCode !== 0 || !(await this.hasCommit(hash))) {
      throw new Error(`Unable to fetch ${label} commit ${hash}: ${clip(fetch.stderr, 1_000)}`);
    }
  }

  #redact(value: string): string {
    let redacted = value;
    for (const secret of this.redactedSecrets) {
      if (secret.length >= 4) redacted = redacted.replaceAll(secret, "[REDACTED]");
    }
    return redacted;
  }
}

export async function prepareRepository(options: {
  directory: string;
  cloneUrl: string;
  sourceHash: string;
  sourceRef: string;
  targetHash: string;
  targetRef: string;
  gitAuthorizationHeader?: string;
  maxOutputBytes: number;
  redactedSecrets?: string[];
}): Promise<GitRepository> {
  const repositoryExists = await isGitRepository(options.directory);
  let cloned = false;
  if (repositoryExists) {
    const remote = await repositoryRemote(options.directory);
    if (remote && !sameRepository(remote, options.cloneUrl)) {
      throw new Error(`Checkout ${options.directory} belongs to ${remote}, not pull request repository ${options.cloneUrl}`);
    }
  }
  if (!repositoryExists) {
    const entries = await directoryEntries(options.directory);
    if (entries.length > 0) {
      throw new Error(`Checkout directory ${options.directory} is not a Git repository and is not empty`);
    }
    await mkdir(dirname(options.directory), { recursive: true });
    const environment = options.gitAuthorizationHeader
      ? { ...verificationEnvironment(), ...gitAuthEnvironment(options.gitAuthorizationHeader) }
      : verificationEnvironment();
    const clone = await runCommand(["git", "clone", "--no-checkout", options.cloneUrl, options.directory], {
      cwd: dirname(options.directory),
      timeoutMs: 5 * 60_000,
      maxOutputBytes: options.maxOutputBytes,
      env: environment,
    });
    if (clone.exitCode !== 0) throw new Error(`Unable to clone pull request repository: ${clip(clone.stderr, 1_000)}`);
    cloned = true;
  }
  const repository = new GitRepository(
    options.directory,
    options.maxOutputBytes,
    options.gitAuthorizationHeader,
    options.redactedSecrets ?? [],
  );
  await repository.prepareCheckout(options.sourceHash, options.sourceRef, options.targetHash, options.targetRef, cloned);
  return repository;
}

async function isGitRepository(directory: string): Promise<boolean> {
  try {
    const result = await runCommand(["git", "-C", directory, "rev-parse", "--git-dir"], {
      cwd: directory,
      timeoutMs: 10_000,
      maxOutputBytes: 10_000,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function directoryEntries(directory: string): Promise<string[]> {
  try {
    if (!(await stat(directory)).isDirectory()) throw new Error(`Checkout path ${directory} is not a directory`);
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function repositoryRemote(directory: string): Promise<string | undefined> {
  const result = await runCommand(["git", "-C", directory, "remote", "get-url", "origin"], {
    cwd: directory,
    timeoutMs: 10_000,
    maxOutputBytes: 10_000,
  });
  return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

export function sameRepository(left: string, right: string): boolean {
  const normalizedLeft = normalizeRemote(left);
  const normalizedRight = normalizeRemote(right);
  if (normalizedLeft === normalizedRight) return true;
  const leftParts = normalizedLeft.split(/[/:]/).filter(Boolean);
  const rightParts = normalizedRight.split(/[/:]/).filter(Boolean);
  return leftParts.slice(-2).join("/") === rightParts.slice(-2).join("/");
}

function normalizeRemote(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/\/$/, "").replace(/\.git$/i, "").toLowerCase();
}

export function normalizeRepoPath(path: string): string {
  if (path.includes("\0")) throw new Error("Repository path contains a null byte");
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`Unsafe repository path: ${path}`);
  }
  return normalized;
}

export async function runCommand(
  argv: string[],
  options: { cwd: string; timeoutMs: number; maxOutputBytes: number; env?: Record<string, string> },
): Promise<CommandResult> {
  const [command, ...args] = argv;
  if (!command) throw new Error("Command argv must not be empty");
  const started = performance.now();
  const proc = spawn(command, args, {
    cwd: options.cwd,
    ...(options.env ? { env: options.env } : {}),
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, options.timeoutMs);
  try {
    const exited = new Promise<number | null>((resolve, reject) => {
      proc.once("error", reject);
      proc.once("close", resolve);
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      readStream(proc.stdout, options.maxOutputBytes),
      readStream(proc.stderr, options.maxOutputBytes),
      exited,
    ]);
    return {
      exitCode,
      stdout,
      stderr,
      timedOut,
      durationMs: Math.round(performance.now() - started),
    };
  } finally {
    clearTimeout(timer);
  }
}

function verificationEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
    value !== undefined && !/(?:TOKEN|PASSWORD|SECRET|API_KEY|PAT)$/i.test(key) && key !== "COPILOT_GITHUB_TOKEN",
  )) as Record<string, string>;
}

function gitAuthEnvironment(authorizationHeader: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: ${authorizationHeader}`,
  };
}

async function readStream(stream: NodeJS.ReadableStream, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let retainedBytes = 0;
  let truncated = false;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (retainedBytes >= limit) {
      truncated = true;
      continue;
    }
    const retained = chunk.subarray(0, limit - retainedBytes);
    chunks.push(retained);
    retainedBytes += retained.byteLength;
    if (retained.byteLength < chunk.byteLength) truncated = true;
  }
  return `${Buffer.concat(chunks).toString("utf8")}${truncated ? "\n[output truncated]" : ""}`;
}

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)} [truncated]`;
}
