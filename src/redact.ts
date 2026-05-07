export function redactSecrets(value: string): string {
  let redacted = value;
  const discordToken = process.env.DISCORD_TOKEN;
  if (discordToken) {
    redacted = redacted.split(discordToken).join("[REDACTED_DISCORD_TOKEN]");
  }
  redacted = redacted.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_OPENAI_KEY]");
  redacted = redacted.replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]");
  redacted = redacted.replace(
    /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|KEY)[A-Z0-9_]*)\s*[:=]\s*["']?[^"'\s]+/gi,
    "$1=[REDACTED]",
  );
  return redacted;
}

export function redactPayload<T>(payload: T): T {
  try {
    return JSON.parse(redactSecrets(JSON.stringify(payload))) as T;
  } catch {
    return payload;
  }
}
