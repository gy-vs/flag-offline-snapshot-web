// Deterministic encoding helpers shared by the server exporter and the offline client.

const encoder = new TextEncoder();

export function byteSize(text: string): number {
  return encoder.encode(text).length;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(record[key])).join(',') + '}';
}

/** Canonical JSON for a digest input: object keys sorted, array order preserved. */
export function canonicalJson(value: unknown): string {
  return stableStringify(value);
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = encoder.encode(input);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function shortFingerprint(digest: string): string {
  return digest.slice(0, 12);
}
