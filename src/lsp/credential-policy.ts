/**
 * Which credential may be released for a server's `zenwave/credential` request.
 *
 * Pure, and deliberately strict: this is the boundary that stops a manifest in
 * an untrusted repository from naming a host and being handed a token for it.
 * Wire shape per zenwave-specs 001 design §Decision (task 1.4), pending review.
 */

export type CredentialType = 'HEADER' | 'QUERY';
export type CredentialSource = 'github' | 'stored';

/** Non-secret configuration of one authorised origin (`zenwave.credentials.origins`). */
export interface CredentialOrigin {
  readonly origin: string;
  readonly source: CredentialSource;
  readonly type: CredentialType;
  /** Header or query parameter name. */
  readonly key: string;
  /** Prepended to the secret, e.g. `Bearer `. */
  readonly valuePrefix: string;
}

export interface CredentialRequest {
  readonly uri: string;
  readonly origin: string;
  readonly attempt: 'initial' | 'rejected';
  readonly status?: number;
}

export interface CredentialAnswer {
  readonly type: CredentialType;
  readonly key: string;
  readonly value: string;
}

const DEFAULT_PORTS: Readonly<Record<string, string>> = { 'http:': '80', 'https:': '443' };

/**
 * `scheme://host[:port]` of an http(s) URL, lower-cased, default port omitted.
 * `undefined` for anything else, including URLs carrying user information —
 * `https://github.com@evil.example` is a request to `evil.example`, and a
 * credential must never be matched on text that merely looks like a host.
 */
export function originOf(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!(url.protocol in DEFAULT_PORTS) || url.username || url.password || !url.hostname) return undefined;
  const port = url.port && url.port !== DEFAULT_PORTS[url.protocol] ? `:${url.port}` : '';
  return `${url.protocol}//${url.hostname.toLowerCase()}${port}`;
}

/**
 * A configured origin, normalised. Only a bare origin is accepted — a path,
 * query, fragment or wildcard would make the authorisation broader or vaguer
 * than the user can see.
 */
export function configuredOrigin(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.includes('*')) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.pathname !== '/' || url.search || url.hash || trimmed.endsWith('?') || trimmed.endsWith('#')) return undefined;
  } catch {
    return undefined;
  }
  return originOf(trimmed);
}

/** Reads `zenwave.credentials.origins` entries, dropping (and reporting) anything malformed. */
export function readCredentialOrigins(raw: unknown): { origins: CredentialOrigin[]; problems: string[] } {
  const origins: CredentialOrigin[] = [];
  const problems: string[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const value = typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : {};
    const origin = typeof value.origin === 'string' ? configuredOrigin(value.origin) : undefined;
    if (!origin) {
      problems.push(`zenwave.credentials.origins: ${JSON.stringify(value.origin)} is not an http(s) origin (scheme://host[:port], nothing else)`);
      continue;
    }
    const source: CredentialSource = value.source === 'github' ? 'github' : 'stored';
    const type: CredentialType = value.type === 'QUERY' ? 'QUERY' : 'HEADER';
    const key = typeof value.key === 'string' && value.key.trim() ? value.key.trim() : 'Authorization';
    const valuePrefix = typeof value.valuePrefix === 'string'
      ? value.valuePrefix
      : source === 'github' && type === 'HEADER' && key.toLowerCase() === 'authorization' ? 'Bearer ' : '';
    origins.push({ origin, source, type, key, valuePrefix });
  }
  return { origins, problems };
}

export type CredentialDecision =
  | { readonly release: true; readonly entry: CredentialOrigin; readonly origin: string }
  | { readonly release: false; readonly reason: string };

/** Reads the request's params; anything malformed is refused. */
export function readCredentialRequest(params: unknown): CredentialRequest | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const { uri, origin, attempt, status } = params as Record<string, unknown>;
  if (typeof uri !== 'string' || typeof origin !== 'string') return undefined;
  if (attempt !== 'initial' && attempt !== 'rejected') return undefined;
  return { uri, origin, attempt, ...(typeof status === 'number' ? { status } : {}) };
}

/**
 * Release only where the request's own URL is on an origin the user authorised,
 * compared as a whole. The origin the server states must agree with the URL:
 * a request claiming one origin for a URL on another is refused, not trusted.
 */
export function decideCredential(request: CredentialRequest, origins: readonly CredentialOrigin[]): CredentialDecision {
  const origin = originOf(request.uri);
  if (!origin) return { release: false, reason: `${redact(request.uri)} is not an http(s) location without user information` };
  if (configuredOrigin(request.origin) !== origin) {
    return { release: false, reason: `stated origin ${request.origin} does not match ${origin}` };
  }
  const entry = origins.find((candidate) => candidate.origin === origin);
  return entry
    ? { release: true, entry, origin }
    : { release: false, reason: `${origin} is not an origin the user authorised (zenwave.credentials.origins)` };
}

/** The URL without query or fragment, for logs: a query may itself carry a credential. */
export function redact(uri: string): string {
  try {
    const url = new URL(uri);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '<unparseable location>';
  }
}

/** Secret-storage key for an origin's stored credential. */
export function secretKey(origin: string): string {
  return `zenwave.credential:${origin}`;
}
