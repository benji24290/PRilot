export class Logger {
  constructor(readonly secrets: string[] = []) {}

  info(event: string, fields: Record<string, unknown> = {}): void {
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "info", event, ...fields }));
  }

  warn(event: string, fields: Record<string, unknown> = {}): void {
    console.warn(JSON.stringify({ timestamp: new Date().toISOString(), level: "warn", event, ...fields }));
  }

  error(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      event,
      error: redactError(error, this.secrets),
      ...fields,
    }));
  }
}

export function redactError(error: unknown, secrets: string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret.length >= 4) message = message.replaceAll(secret, "[REDACTED]");
  }
  return message
    .replace(/(authorization|token|api[-_ ]?key)(\s*[:=]\s*)([^\s,;]+)/gi, "$1$2[REDACTED]")
    .replace(/(https?:\/\/)([^/@\s]+)@/gi, "$1[REDACTED]@")
    .replace(/([?&](?:token|access_token|api_key)=)[^&\s]+/gi, "$1[REDACTED]");
}
