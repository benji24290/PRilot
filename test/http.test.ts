import { expect, test } from "bun:test";
import { z } from "zod";
import { HttpClient, safeEndpoint } from "../src/http.ts";

test("retries transient responses and validates JSON", async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response("busy", { status: 503 })
      : Response.json({ ok: true });
  };
  const client = new HttpClient({ timeoutMs: 1_000, maxRetries: 1, fetch: fakeFetch as unknown as typeof fetch });
  await expect(client.json("https://example.com/api?token=secret", {}, z.object({ ok: z.boolean() }))).resolves.toEqual({ ok: true });
  expect(calls).toBe(2);
});

test("safeEndpoint removes query strings and credentials", () => {
  expect(safeEndpoint("https://user:pass@example.com/path?token=secret")).toBe("https://example.com/path");
});
