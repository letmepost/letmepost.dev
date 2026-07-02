import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Raised when a URL resolves to a disallowed (internal / link-local /
 * metadata) address. The message is intentionally generic so a resolved
 * internal IP can't be used as an SSRF oracle.
 */
export class SsrfBlockedError extends Error {
  readonly code = "SSRF_BLOCKED" as const;
  constructor(message = "The requested URL is not allowed.") {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

/** Raised when a URL's scheme is not http: or https:. */
export class UnsupportedProtocolError extends Error {
  readonly code = "UNSUPPORTED_PROTOCOL" as const;
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedProtocolError";
  }
}

/** True for either guard-level rejection — used by callers to map to a 4xx. */
export function isDisallowedUrlError(err: unknown): boolean {
  return (
    err instanceof SsrfBlockedError || err instanceof UnsupportedProtocolError
  );
}

const IPV4_BLOCKED: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["255.255.255.255", 32],
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = ((n << 8) | v) >>> 0;
  }
  return n >>> 0;
}

function ipv4InCidr(value: number, baseIp: string, prefix: number): boolean {
  const base = ipv4ToInt(baseIp);
  if (base === null) return false;
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) >>> 0 === (base & mask) >>> 0;
}

function isBlockedIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return true;
  return IPV4_BLOCKED.some(([base, prefix]) => ipv4InCidr(value, base, prefix));
}

/**
 * Parse any textual IPv6 form (including "::" compression and an embedded
 * dotted-quad IPv4 tail like "::ffff:10.0.0.1") into its 16 bytes. Returns
 * null on anything unparseable so the caller can block conservatively.
 */
function ipv6ToBytes(input: string): Uint8Array | null {
  let ip = input;
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);

  const lastColon = ip.lastIndexOf(":");
  if (lastColon === -1) return null;
  const tail = ip.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = tail.split(".");
    if (octets.length !== 4) return null;
    const nums: number[] = [];
    for (const octet of octets) {
      if (!/^\d{1,3}$/.test(octet)) return null;
      const v = Number(octet);
      if (v > 255) return null;
      nums.push(v);
    }
    const hi = ((nums[0]! << 8) | nums[1]!).toString(16);
    const lo = ((nums[2]! << 8) | nums[3]!).toString(16);
    ip = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tailGroups =
    halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;

  let groups: string[];
  if (tailGroups === null) {
    groups = head;
    if (groups.length !== 8) return null;
  } else {
    const missing = 8 - (head.length + tailGroups.length);
    if (missing < 0) return null;
    groups = [...head, ...Array<string>(missing).fill("0"), ...tailGroups];
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const group = groups[i]!;
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    const v = parseInt(group, 16);
    bytes[i * 2] = (v >> 8) & 0xff;
    bytes[i * 2 + 1] = v & 0xff;
  }
  return bytes;
}

function isV4Mapped(bytes: Uint8Array): boolean {
  for (let i = 0; i < 10; i += 1) if (bytes[i] !== 0) return false;
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

function isBlockedIpv6(bytes: Uint8Array): boolean {
  // :: (unspecified)
  if (bytes.every((b) => b === 0)) return true;
  // ::1 (loopback)
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true;
  // fc00::/7 (unique local)
  if ((bytes[0]! & 0xfe) === 0xfc) return true;
  // fe80::/10 (link-local)
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true;
  // ff00::/8 (multicast)
  if (bytes[0] === 0xff) return true;
  return false;
}

/**
 * True when `ip` is an address we must never let a user-supplied URL reach:
 * loopback, private, link-local (incl. the cloud metadata 169.254.169.254),
 * CGNAT, benchmarking, multicast and reserved ranges. IPv4-mapped IPv6
 * (e.g. "::ffff:10.0.0.1") is unwrapped and re-checked as IPv4 — a known
 * bypass. Pure and side-effect free so it can be unit tested directly.
 */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isBlockedIpv4(ip);
  if (kind === 6) {
    const bytes = ipv6ToBytes(ip);
    if (bytes === null) return true;
    if (isV4Mapped(bytes)) {
      return isBlockedIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
    }
    return isBlockedIpv6(bytes);
  }
  return true;
}

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;

async function assertHostAllowed(hostname: string): Promise<void> {
  const host =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  let results: Array<{ address: string }>;
  try {
    results = await lookup(host, { all: true, verbatim: true });
  } catch {
    // Resolution failed (ENOTFOUND/ENODATA/…). There is nothing to connect
    // to, so no SSRF is possible — let the fetch proceed and fail naturally
    // (in tests, MSW intercepts the mocked host before any real connection).
    return;
  }
  for (const { address } of results) {
    if (isBlockedAddress(address)) throw new SsrfBlockedError();
  }
}

/**
 * SSRF-hardened `fetch` for user-supplied URLs. Only http/https is allowed;
 * redirects are followed manually so every hop's host is re-validated against
 * {@link isBlockedAddress} before the request is made.
 */
export async function guardedFetch(
  url: string,
  opts: { maxRedirects?: number; signal?: AbortSignal } = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeout])
    : timeout;

  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const parsed = new URL(current);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new UnsupportedProtocolError(
        `URL protocol '${parsed.protocol}' is not allowed; use http or https.`,
      );
    }
    await assertHostAllowed(parsed.hostname);

    const res = await fetch(current, { redirect: "manual", signal });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return res;
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new Error(`Exceeded ${maxRedirects} redirects fetching ${url}.`);
}
