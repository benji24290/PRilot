import { describe, expect, test } from "bun:test";
import { loadStoredCredentials, runAuth, type CredentialStore } from "../src/credentials.ts";

class MemoryCredentialStore implements CredentialStore {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
}

describe("local credentials", () => {
  test("fills missing environment tokens without overriding explicit values", async () => {
    const store = new MemoryCredentialStore();
    store.values.set("GITHUB_TOKEN", "stored-github");
    store.values.set("JIRA_TOKEN", "stored-jira");

    const resolved = await loadStoredCredentials({ GITHUB_TOKEN: "environment-github" }, store);

    expect(resolved.GITHUB_TOKEN).toBe("environment-github");
    expect(resolved.JIRA_TOKEN).toBe("stored-jira");
  });

  test("never reads the system store in CI", async () => {
    const store: CredentialStore = {
      get: async () => { throw new Error("must not be called"); },
      set: async () => undefined,
      delete: async () => false,
    };
    expect(await loadStoredCredentials({ CI: "true" }, store)).toEqual({ CI: "true" });
  });

  test("sets, reports, and deletes credentials without printing their value", async () => {
    const store = new MemoryCredentialStore();
    const output: string[] = [];
    const options = {
      store,
      readSecret: async () => "super-secret-token",
      write: (message: string) => output.push(message),
    };

    await runAuth(["set", "github"], options);
    await runAuth(["status"], options);
    await runAuth(["delete", "github"], options);

    expect(store.values.has("GITHUB_TOKEN")).toBeFalse();
    expect(output.join("\n")).toContain("github: configured");
    expect(output.join("\n")).not.toContain("super-secret-token");
  });
});
