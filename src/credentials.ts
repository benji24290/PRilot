import type { AsyncEntry } from "@napi-rs/keyring";

const SERVICE = "dev.prilot.cli";

export const credentials = [
  { name: "github", label: "GitHub", environmentVariable: "GITHUB_TOKEN" },
  { name: "bitbucket", label: "Bitbucket", environmentVariable: "BITBUCKET_TOKEN" },
  { name: "jira", label: "Jira", environmentVariable: "JIRA_TOKEN" },
  { name: "copilot", label: "GitHub Copilot", environmentVariable: "COPILOT_GITHUB_TOKEN" },
] as const;

export type CredentialName = typeof credentials[number]["name"];
type Credential = typeof credentials[number];

export interface CredentialStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export class SystemCredentialStore implements CredentialStore {
  async get(key: string): Promise<string | undefined> {
    return (await this.#entry(key)).getPassword();
  }

  async set(key: string, value: string): Promise<void> {
    await (await this.#entry(key)).setPassword(value);
  }

  async delete(key: string): Promise<boolean> {
    return (await this.#entry(key)).deletePassword();
  }

  async #entry(key: string): Promise<AsyncEntry> {
    try {
      const { AsyncEntry } = await import("@napi-rs/keyring");
      return new AsyncEntry(SERVICE, key);
    } catch {
      throw new Error("The system credential store is unavailable on this machine");
    }
  }
}

export async function loadStoredCredentials(
  env: Record<string, string | undefined>,
  store: CredentialStore = new SystemCredentialStore(),
): Promise<Record<string, string | undefined>> {
  const resolved = { ...env };
  if (env.CI === "true" || env.PRILOT_DISABLE_KEYRING === "true") return resolved;
  for (const credential of credentials) {
    if (resolved[credential.environmentVariable]) continue;
    try {
      const value = await store.get(credential.environmentVariable);
      if (value) resolved[credential.environmentVariable] = value;
    } catch {
      break;
    }
  }
  return resolved;
}

export async function runAuth(
  argv: string[],
  options: {
    store?: CredentialStore;
    readSecret?: (prompt: string) => Promise<string>;
    write?: (message: string) => void;
  } = {},
): Promise<void> {
  const store = options.store ?? new SystemCredentialStore();
  const read = options.readSecret ?? readSecret;
  const write = options.write ?? console.log;
  const [action = "status", requestedName, ...extra] = argv;

  if (action === "help" || action === "--help" || action === "-h") {
    write(authHelp());
    return;
  }
  if (extra.length > 0) throw new Error(`Unexpected auth argument: ${extra[0]}`);

  if (action === "status") {
    if (requestedName) throw new Error("auth status does not accept a credential name");
    for (const credential of credentials) {
      write(`${credential.name}: ${await store.get(credential.environmentVariable) ? "configured" : "not configured"}`);
    }
    return;
  }

  const credential = findCredential(requestedName);
  if (action === "set") {
    const value = (await read(`${credential.label} token: `)).trim();
    if (!value) throw new Error("Token must not be empty");
    await store.set(credential.environmentVariable, value);
    write(`${credential.name}: stored in the system credential store`);
    return;
  }
  if (action === "delete") {
    const deleted = await store.delete(credential.environmentVariable);
    write(`${credential.name}: ${deleted ? "deleted" : "not configured"}`);
    return;
  }
  throw new Error(`Unknown auth command: ${action}`);
}

function findCredential(name: string | undefined): Credential {
  if (!name) throw new Error("A credential name is required: github, bitbucket, jira, or copilot");
  const credential = credentials.find((candidate) => candidate.name === name);
  if (!credential) throw new Error(`Unknown credential: ${name}`);
  return credential;
}

function authHelp(): string {
  return `PRilot local credentials

Usage:
  prilot auth status
  prilot auth set <github|bitbucket|jira|copilot>
  prilot auth delete <github|bitbucket|jira|copilot>

Tokens are stored in macOS Keychain, Windows Credential Manager, or Linux Secret Service.
Environment variables override stored credentials. Set PRILOT_DISABLE_KEYRING=true to disable lookup.`;
}

async function readSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  const output = process.stderr;
  if (!input.isTTY || !output.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of input) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8").trim();
  }

  return new Promise<string>((resolve, reject) => {
    let value = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (data: Buffer | string) => {
      for (const character of data.toString()) {
        if (character === "\u0003") return finish(new Error("Authentication cancelled"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") {
          if (value) {
            value = value.slice(0, -1);
            output.write("\b \b");
          }
        } else if (character >= " " && character !== "\u001b") {
          value += character;
          output.write("*");
        }
      }
    };

    output.write(prompt);
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}
