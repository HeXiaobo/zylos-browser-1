/**
 * Login registry — which browser profile is logged in to which site.
 *
 * Stored in ~/zylos/components/browser/logins.json. One entry per
 * (profile, domain) pair. Only domains, profile names, timestamps and the
 * confirmation method are stored — never passwords, cookies or tokens.
 *
 * A "profile" is a named browser endpoint. The built-in profile "default"
 * is the component's own Chrome (config.cdp_port). Extra profiles can be
 * declared in config.json:
 *
 *   "profiles": { "work": { "cdp_port": 9223 } }
 */

import fs from 'node:fs';
import path from 'node:path';
import { LOGINS_PATH, getConfig } from './config.js';
import { BrowserError, LoginRequiredError } from './errors.js';

export const DEFAULT_PROFILE = 'default';
export const REGISTRY_VERSION = 1;

/** Methods accepted by --how */
export const METHODS = ['manual', 'url', 'selector'];

// Hostname labels / path segments that indicate a login page.
const LOGIN_HOST_LABELS = new Set([
  'login', 'signin', 'passport', 'sso', 'auth', 'accounts', 'cas', 'oauth'
]);
const LOGIN_PATH_SEGMENTS = new Set([
  'login', 'log-in', 'log_in', 'signin', 'sign-in', 'sign_in', 'logon',
  'passport', 'sso', 'oauth', 'oauth2', 'authorize', 'auth', 'cas'
]);

/**
 * Normalize a user-supplied site into a bare domain:
 * "https://www.Example.com:8080/a?b" -> "example.com"
 */
export function normalizeDomain(input) {
  if (!input || typeof input !== 'string') {
    throw new BrowserError('Missing domain', 'INVALID_ARGUMENT');
  }
  let s = input.trim().toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `https://${s}`;
  let host;
  try {
    host = new URL(s).hostname;
  } catch {
    throw new BrowserError(`Invalid domain: ${input}`, 'INVALID_ARGUMENT');
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  if (!host) throw new BrowserError(`Invalid domain: ${input}`, 'INVALID_ARGUMENT');
  return host;
}

/**
 * Parse a --how value: "manual" | "url" | "selector=<css>"
 * @returns {{ method: string, selector?: string }}
 */
export function parseHow(how, fallback = 'manual') {
  if (!how) return { method: fallback };
  const eq = how.indexOf('=');
  const method = (eq === -1 ? how : how.slice(0, eq)).trim();
  const value = eq === -1 ? '' : how.slice(eq + 1).trim();
  if (!METHODS.includes(method)) {
    throw new BrowserError(
      `Unknown --how "${how}". Use one of: manual, url, selector=<css>`,
      'INVALID_ARGUMENT'
    );
  }
  if (method === 'selector') {
    if (!value) {
      throw new BrowserError('--how selector needs a CSS selector: selector=<css>', 'INVALID_ARGUMENT');
    }
    return { method, selector: value };
  }
  return { method };
}

// --- Storage ---

function emptyRegistry() {
  return { version: REGISTRY_VERSION, entries: [] };
}

/**
 * Load the registry. A missing file is an empty registry; an unreadable or
 * malformed file is an error (never silently overwritten).
 */
export function loadRegistry(file = LOGINS_PATH) {
  if (!fs.existsSync(file)) return emptyRegistry();
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new BrowserError(
      `Login registry ${file} is not valid JSON (${err.message}). Fix or move it aside; it was not modified.`,
      'REGISTRY_CORRUPT'
    );
  }
  if (!data || !Array.isArray(data.entries)) {
    throw new BrowserError(
      `Login registry ${file} has no "entries" array. Fix or move it aside; it was not modified.`,
      'REGISTRY_CORRUPT'
    );
  }
  return data;
}

/** Atomic write (temp file + rename) */
export function saveRegistry(registry, file = LOGINS_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function findEntry(registry, profile, domain) {
  return registry.entries.find(e => e.profile === profile && e.domain === domain);
}

function nowIso(now) {
  return (now ?? new Date()).toISOString();
}

// --- Profiles ---

/**
 * Resolve a profile name to its CDP port.
 * "default" -> config.cdp_port; others -> config.profiles[name].cdp_port.
 */
export function resolveProfilePort(profile, config = getConfig()) {
  if (profile === DEFAULT_PROFILE) return config.cdp_port ?? 9222;
  const port = config.profiles?.[profile]?.cdp_port;
  if (!port) {
    throw new BrowserError(
      `Unknown profile "${profile}". Declare it in config.json as "profiles": { "${profile}": { "cdp_port": <port> } }, or pass --cdp <port>.`,
      'UNKNOWN_PROFILE'
    );
  }
  return port;
}

// --- Operations ---

/**
 * Record that a human has logged in `profile` to `domain`.
 */
export function markLogin(domain, profile = DEFAULT_PROFILE, options = {}) {
  const file = options.file ?? LOGINS_PATH;
  const d = normalizeDomain(domain);
  const how = parseHow(options.how, 'manual');
  const ts = nowIso(options.now);

  const registry = loadRegistry(file);
  let entry = findEntry(registry, profile, d);
  if (!entry) {
    entry = { profile, domain: d, first_marked_at: ts, last_expired_at: null };
    registry.entries.push(entry);
  }
  entry.status = 'active';
  entry.last_confirmed_at = ts;
  entry.confirm_method = how.method;
  // Check inputs can contain secrets; never persist them, including legacy values.
  delete entry.check_selector;
  delete entry.check_url;
  saveRegistry(registry, file);
  return { ...entry };
}

/**
 * Pick the profile to use for `domain`.
 * Returns the active entry confirmed most recently; throws
 * LoginRequiredError if none is active. Never creates a profile.
 */
export function pickProfile(domain, options = {}) {
  const file = options.file ?? LOGINS_PATH;
  const d = normalizeDomain(domain);
  const registry = loadRegistry(file);
  let entries = registry.entries.filter(e => e.domain === d);
  if (options.profile) entries = entries.filter(e => e.profile === options.profile);

  const active = entries
    .filter(e => e.status === 'active')
    .sort((a, b) => String(b.last_confirmed_at).localeCompare(String(a.last_confirmed_at)));

  if (active.length === 0) {
    if (entries.length === 0) {
      const who = options.profile ? `Profile "${options.profile}" is not` : 'No profile is';
      throw new LoginRequiredError(
        `${who} registered as logged in to ${d}. A human needs to log in, then run: zylos-browser login mark ${d} --profile <name>. Do not open a new profile.`,
        { domain: d, profile: options.profile ?? null, reason: 'not_registered' }
      );
    }
    const names = entries.map(e => `"${e.profile}" (expired ${e.last_expired_at ?? 'unknown'})`).join(', ');
    throw new LoginRequiredError(
      `Login expired for ${d} on profile ${names}. A human needs to log in again, then run: zylos-browser login mark ${d} --profile <name>. Do not open a new profile.`,
      { domain: d, profile: entries[0].profile, reason: 'expired' }
    );
  }

  const best = active[0];
  if (options.maxAgeHours != null) {
    const ageMs = (options.now ?? new Date()) - new Date(best.last_confirmed_at);
    if (!(ageMs <= options.maxAgeHours * 3600 * 1000)) {
      throw new LoginRequiredError(
        `Profile "${best.profile}" on ${d} was last confirmed at ${best.last_confirmed_at}, older than ${options.maxAgeHours}h. Run: zylos-browser login check ${d} --profile ${best.profile}`,
        { domain: d, profile: best.profile, reason: 'stale' }
      );
    }
  }
  return { ...best };
}

/**
 * Store the result of a login check.
 */
export function recordCheck(domain, profile, result, options = {}) {
  const file = options.file ?? LOGINS_PATH;
  const d = normalizeDomain(domain);
  const ts = nowIso(options.now);
  const registry = loadRegistry(file);
  const entry = findEntry(registry, profile, d);
  if (!entry) {
    throw new BrowserError(`No registry entry for profile "${profile}" on ${d}`, 'NOT_REGISTERED');
  }
  if (result.loggedIn) {
    entry.status = 'active';
    entry.last_confirmed_at = ts;
    entry.confirm_method = result.method;
  } else {
    entry.status = 'expired';
    entry.last_expired_at = ts;
  }
  saveRegistry(registry, file);
  return { ...entry };
}

export function listLogins(options = {}) {
  const registry = loadRegistry(options.file ?? LOGINS_PATH);
  return [...registry.entries].sort((a, b) =>
    a.domain.localeCompare(b.domain) || a.profile.localeCompare(b.profile));
}

/**
 * True if the URL looks like a login / SSO page.
 */
export function isLoginUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.hostname.split('.').some(label => LOGIN_HOST_LABELS.has(label))) return true;
  const hashPath = u.hash.startsWith('#') ? u.hash.slice(1).split('?')[0] : '';
  const segments = `${u.pathname}/${hashPath}`
    .split('/')
    .filter(Boolean)
    .map(s => s.toLowerCase().replace(/\.[a-z0-9]+$/, ''));
  return segments.some(s => LOGIN_PATH_SEGMENTS.has(s));
}

/**
 * Decide login state from what the browser saw. Pure function.
 * @param {{ finalUrl: string, selector?: string, selectorCount?: number }} obs
 * @returns {{ loggedIn: boolean, method: string, reason: string }}
 */
export function evaluateLoginState(obs) {
  const { finalUrl, selector, selectorCount } = obs;
  if (!/^https?:\/\//i.test(finalUrl || '')) {
    throw new BrowserError(
      `Could not load the site (browser is at "${finalUrl || 'unknown'}"); login state not changed.`,
      'CHECK_INCONCLUSIVE'
    );
  }
  if (isLoginUrl(finalUrl)) {
    return { loggedIn: false, method: 'url', reason: `redirected to login page ${finalUrl}` };
  }
  if (selector) {
    if (selectorCount > 0) {
      return { loggedIn: true, method: 'selector', reason: `selector "${selector}" present` };
    }
    return { loggedIn: false, method: 'selector', reason: `selector "${selector}" not found at ${finalUrl}` };
  }
  return { loggedIn: true, method: 'url', reason: `not redirected to a login page (${finalUrl})` };
}

/**
 * Open the site in the given profile's browser and update the registry.
 *
 * @param {string} domain
 * @param {object} options
 * @param {string}   [options.profile]  check only this profile (default: all registered for the domain)
 * @param {string}   [options.how]      "url" | "selector=<css>" (default: url; not stored)
 * @param {string}   [options.url]      URL to open (default: https://<domain>/; not stored)
 * @param {number}   [options.cdpPort]  override CDP port
 * @param {Function} options.browserFactory  ({ cdpPort }) => Browser-like with _exec(args)
 * @param {number}   [options.settleMs] wait after open for client-side redirects (default 2000)
 * @returns {Promise<Array<{ profile, loggedIn, method, reason, entry }>>}
 */
export async function checkLogin(domain, options = {}) {
  const file = options.file ?? LOGINS_PATH;
  const d = normalizeDomain(domain);
  const registry = loadRegistry(file);
  let entries = registry.entries.filter(e => e.domain === d);
  if (options.profile) entries = entries.filter(e => e.profile === options.profile);
  if (entries.length === 0) {
    const who = options.profile ? `Profile "${options.profile}" is not` : 'No profile is';
    throw new LoginRequiredError(
      `${who} registered for ${d}. A human needs to log in, then run: zylos-browser login mark ${d} --profile <name>.`,
      { domain: d, profile: options.profile ?? null, reason: 'not_registered' }
    );
  }

  if (options.cdpPort != null && !options.profile) {
    throw new BrowserError('Specify --profile when overriding the CDP port', 'INVALID_ARGUMENT');
  }
  const howOverride = options.how ? parseHow(options.how, 'url') : null;
  if (howOverride?.method === 'manual') {
    throw new BrowserError('login check cannot use --how manual; use url or selector=<css>', 'INVALID_ARGUMENT');
  }

  const results = [];
  for (const entry of entries) {
    const cdpPort = options.cdpPort ?? resolveProfilePort(entry.profile, options.config);
    const browser = options.browserFactory({ cdpPort });
    const selector = howOverride?.selector;
    const url = options.url ?? `https://${d}/`;

    await browser._exec(['open', url]);
    await browser._exec(['wait', String(options.settleMs ?? 2000)]);
    const finalUrl = (await browser._exec(['get', 'url'])).trim();
    let selectorCount;
    if (selector) {
      const out = await browser._exec(['get', 'count', selector]);
      selectorCount = parseInt(String(out).match(/\d+/)?.[0] ?? '0', 10);
    }

    const verdict = evaluateLoginState({ finalUrl, selector, selectorCount });
    const updated = recordCheck(d, entry.profile, verdict, { file, now: options.now });
    results.push({ profile: entry.profile, ...verdict, entry: updated });
  }
  return results;
}
