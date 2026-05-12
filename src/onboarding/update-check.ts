/**
 * Self-update awareness for the connector.
 *
 * On startup the connector queries the npm registry for the latest
 * `jdcodec` version and compares against the version baked into this
 * build. If a newer version exists, the proxy emits a one-line warning
 * on stderr; the `doctor` subcommand surfaces the same finding as a
 * "warn" probe. The check is fire-and-forget — registry-down, no PATH
 * to npm, and timeout all degrade silently. We never block startup.
 *
 * Cache:
 *   - Successful lookups (any verdict — match or mismatch) cache the
 *     result for 24h at `~/.jdcodec/version-check.json` so repeated
 *     connector restarts don't hammer the registry. Cache is also
 *     written on a *failed* lookup with a short TTL (10 min) so a
 *     transient registry outage doesn't retry on every boot.
 *   - Cache directory mirrors the existing config-file location so
 *     the connector only ever touches one directory under the home dir.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { VERSION } from "./version.js";

export const REGISTRY_URL = "https://registry.npmjs.org/jdcodec/latest";
export const PACKAGE_NAME = "jdcodec";
const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 10 * 60 * 1000;
const REGISTRY_TIMEOUT_MS = 5_000;

export type UpdateVerdict =
	| { state: "current"; current: string; latest: string }
	| { state: "outdated"; current: string; latest: string }
	| { state: "unknown"; current: string; reason: string };

interface CacheRow {
	checkedAtMs: number;
	expiresAtMs: number;
	verdict: UpdateVerdict;
}

export interface UpdateCheckIO {
	/** Defaults to globalThis.fetch. */
	fetchImpl?: typeof fetch;
	/** Defaults to `~/.jdcodec/version-check.json`. */
	cachePath?: string;
	/** Defaults to Date.now. */
	now?: () => number;
	/** Defaults to the package's own VERSION constant. */
	currentVersion?: string;
}

function defaultCachePath(): string {
	return join(homedir(), ".jdcodec", "version-check.json");
}

function readCache(path: string, now: number): UpdateVerdict | null {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as CacheRow;
		if (
			typeof raw?.expiresAtMs === "number" &&
			raw.expiresAtMs > now &&
			raw.verdict &&
			typeof raw.verdict === "object"
		) {
			return raw.verdict;
		}
	} catch {
		// Corrupt / missing file — treat as no cache.
	}
	return null;
}

function writeCache(path: string, row: CacheRow): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(row, null, 2), "utf8");
	} catch {
		// Cache write failures are non-fatal — the connector's startup
		// path proceeds regardless.
	}
}

/**
 * Loose semver comparison sufficient for newer-than checks against
 * what npm publishes for this package. Avoids pulling in a semver
 * dependency for a single comparison point. Returns:
 *   -1 if a < b, 0 if a == b, 1 if a > b
 * Pre-release suffixes (e.g. -beta.1) compare lexicographically after
 * the numeric triple; this is a minor deviation from strict semver but
 * is correct for our publish discipline (we ship clean x.y.z bumps).
 */
export function compareVersions(a: string, b: string): number {
	const split = (s: string) => {
		const dash = s.indexOf("-");
		const head = dash === -1 ? s : s.slice(0, dash);
		const tail = dash === -1 ? "" : s.slice(dash + 1);
		const nums = head.split(".").map((p) => Number.parseInt(p, 10) || 0);
		while (nums.length < 3) nums.push(0);
		return { nums, tail };
	};
	const A = split(a);
	const B = split(b);
	for (let i = 0; i < 3; i++) {
		if (A.nums[i] < B.nums[i]) return -1;
		if (A.nums[i] > B.nums[i]) return 1;
	}
	if (A.tail === B.tail) return 0;
	if (A.tail === "") return 1;
	if (B.tail === "") return -1;
	return A.tail < B.tail ? -1 : 1;
}

async function fetchLatest(
	fetchImpl: typeof fetch,
): Promise<string> {
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		REGISTRY_TIMEOUT_MS,
	);
	try {
		const res = await fetchImpl(REGISTRY_URL, {
			method: "GET",
			headers: { Accept: "application/json" },
			signal: controller.signal,
		});
		if (!res.ok) {
			throw new Error(`registry returned HTTP ${res.status}`);
		}
		const body = (await res.json()) as { version?: string };
		if (typeof body?.version !== "string" || body.version.length === 0) {
			throw new Error("registry response missing 'version'");
		}
		return body.version;
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Resolve the update verdict for the connector. Reads cache, queries the
 * registry if stale, writes cache, returns. Never throws — failures
 * become `state: "unknown"` verdicts with a human-readable reason.
 */
export async function checkForUpdate(
	io: UpdateCheckIO = {},
): Promise<UpdateVerdict> {
	const current = io.currentVersion ?? VERSION;
	const now = io.now ? io.now() : Date.now();
	const cachePath = io.cachePath ?? defaultCachePath();
	const fetchImpl = io.fetchImpl ?? globalThis.fetch;

	const cached = readCache(cachePath, now);
	if (cached) return cached;

	let verdict: UpdateVerdict;
	let ttl: number;
	try {
		const latest = await fetchLatest(fetchImpl);
		verdict =
			compareVersions(current, latest) < 0
				? { state: "outdated", current, latest }
				: { state: "current", current, latest };
		ttl = SUCCESS_TTL_MS;
	} catch (err) {
		verdict = {
			state: "unknown",
			current,
			reason: (err as Error)?.message ?? "registry lookup failed",
		};
		ttl = FAILURE_TTL_MS;
	}

	writeCache(cachePath, {
		checkedAtMs: now,
		expiresAtMs: now + ttl,
		verdict,
	});
	return verdict;
}

/** One-line human-readable summary suitable for a log line. */
export function formatVerdict(verdict: UpdateVerdict): string {
	switch (verdict.state) {
		case "outdated":
			return `A newer ${PACKAGE_NAME} is available: ${verdict.current} → ${verdict.latest}. Upgrade with: npm install -g jdcodec@latest`;
		case "current":
			return `${PACKAGE_NAME} is up to date (${verdict.current}).`;
		case "unknown":
			return `${PACKAGE_NAME} update check skipped: ${verdict.reason}.`;
	}
}
