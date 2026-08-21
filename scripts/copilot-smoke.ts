import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient } from "@github/copilot-sdk";
import { COPILOT_MODEL } from "../src/config.ts";

const token = process.env.COPILOT_GITHUB_TOKEN;
if (!token) throw new Error("COPILOT_GITHUB_TOKEN is required for the live smoke test");

const root = await mkdtemp(join(tmpdir(), "copilot-sdk-smoke-"));
const home = join(root, "home");
const work = join(root, "work");
await Promise.all([mkdir(home), mkdir(work)]);
const client = new CopilotClient({
  mode: "empty",
  baseDirectory: home,
  workingDirectory: work,
  gitHubToken: token,
  useLoggedInUser: false,
  logLevel: "warning",
});

try {
  await client.start();
  const session = await client.createSession({
    model: COPILOT_MODEL,
    availableTools: [],
    excludedTools: ["builtin:*", "mcp:*", "custom:*"],
    infiniteSessions: { enabled: false },
    memory: { enabled: false },
    enableConfigDiscovery: false,
    enableSkills: false,
    enableHostGitOperations: false,
  });
  try {
    const response = await session.sendAndWait({ prompt: "Reply with exactly: sdk-ok" });
    const content = response?.data.content?.trim().toLowerCase();
    if (content !== "sdk-ok") throw new Error(`Unexpected smoke response: ${content ?? "empty"}`);
    console.log("Copilot SDK Bun smoke test passed");
  } finally {
    await session.disconnect();
  }
} finally {
  await client.stop().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
