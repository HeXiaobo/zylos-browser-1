import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  normalizeDomain,
  parseHow,
  loadRegistry,
  markLogin,
  pickProfile,
  recordCheck,
  listLogins,
  isLoginUrl,
  evaluateLoginState,
  resolveProfilePort,
  checkLogin
} from '../logins.js';

let tmpDir;
let file;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-browser-logins-'));
  file = path.join(tmpDir, 'logins.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const T0 = new Date('2026-01-01T00:00:00.000Z');
const T1 = new Date('2026-01-02T00:00:00.000Z');
const T2 = new Date('2026-01-03T00:00:00.000Z');

describe('logins - normalizeDomain', () => {
  it('strips scheme, www, port, path and case', () => {
    assert.equal(normalizeDomain('https://www.Example.com:8080/a?b=1'), 'example.com');
    assert.equal(normalizeDomain('app.example.com'), 'app.example.com');
    assert.equal(normalizeDomain('  EXAMPLE.com/path '), 'example.com');
  });

  it('rejects empty input', () => {
    assert.throws(() => normalizeDomain(''), { code: 'INVALID_ARGUMENT' });
  });
});

describe('logins - parseHow', () => {
  it('parses methods', () => {
    assert.deepEqual(parseHow(undefined), { method: 'manual' });
    assert.deepEqual(parseHow('url'), { method: 'url' });
    assert.deepEqual(parseHow('selector=#avatar .x'), { method: 'selector', selector: '#avatar .x' });
  });

  it('rejects unknown method and empty selector', () => {
    assert.throws(() => parseHow('cookie'), { code: 'INVALID_ARGUMENT' });
    assert.throws(() => parseHow('selector='), { code: 'INVALID_ARGUMENT' });
  });
});

describe('logins - registry storage', () => {
  it('missing file is an empty registry', () => {
    assert.deepEqual(loadRegistry(file), { version: 1, entries: [] });
  });

  it('corrupt file throws and is left untouched', () => {
    fs.writeFileSync(file, '{not json');
    assert.throws(() => markLogin('example.com', 'default', { file }), { code: 'REGISTRY_CORRUPT' });
    assert.equal(fs.readFileSync(file, 'utf8'), '{not json');
  });

  it('stores only profile, domain, timestamps and method', () => {
    markLogin('https://www.example.com/login', 'default', { file, now: T0, how: 'selector=#me' });
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.entries.length, 1);
    assert.deepEqual(Object.keys(raw.entries[0]).sort(), [
      'confirm_method', 'domain', 'first_marked_at',
      'last_confirmed_at', 'last_expired_at', 'profile', 'status'
    ]);
    assert.equal(raw.entries[0].domain, 'example.com');
  });
});

describe('logins - mark / pick', () => {
  it('pick returns the marked profile', () => {
    markLogin('example.com', 'work', { file, now: T0 });
    const e = pickProfile('www.example.com', { file });
    assert.equal(e.profile, 'work');
    assert.equal(e.status, 'active');
    assert.equal(e.confirm_method, 'manual');
    assert.equal(e.first_marked_at, T0.toISOString());
  });

  it('pick fails with LOGIN_REQUIRED when not registered', () => {
    assert.throws(() => pickProfile('example.com', { file }), err => {
      assert.equal(err.code, 'LOGIN_REQUIRED');
      assert.equal(err.details.reason, 'not_registered');
      assert.match(err.message, /example\.com/);
      assert.match(err.message, /human needs to log in/);
      return true;
    });
  });

  it('pick fails with LOGIN_REQUIRED naming the profile when expired', () => {
    markLogin('example.com', 'work', { file, now: T0 });
    recordCheck('example.com', 'work', { loggedIn: false, method: 'url' }, { file, now: T1 });
    assert.throws(() => pickProfile('example.com', { file }), err => {
      assert.equal(err.code, 'LOGIN_REQUIRED');
      assert.equal(err.details.reason, 'expired');
      assert.match(err.message, /"work"/);
      assert.match(err.message, /log in again/);
      return true;
    });
  });

  it('pick prefers the most recently confirmed active profile', () => {
    markLogin('example.com', 'a', { file, now: T0 });
    markLogin('example.com', 'b', { file, now: T1 });
    assert.equal(pickProfile('example.com', { file }).profile, 'b');
    recordCheck('example.com', 'b', { loggedIn: false, method: 'url' }, { file, now: T2 });
    assert.equal(pickProfile('example.com', { file }).profile, 'a');
  });

  it('pick --profile restricts the choice', () => {
    markLogin('example.com', 'a', { file, now: T0 });
    assert.throws(() => pickProfile('example.com', { file, profile: 'b' }), { code: 'LOGIN_REQUIRED' });
  });

  it('pick --max-age rejects stale confirmations', () => {
    markLogin('example.com', 'a', { file, now: T0 });
    assert.equal(pickProfile('example.com', { file, maxAgeHours: 48, now: T1 }).profile, 'a');
    assert.throws(() => pickProfile('example.com', { file, maxAgeHours: 1, now: T1 }), err => {
      assert.equal(err.details.reason, 'stale');
      return true;
    });
  });

  it('re-mark after expiry restores active and keeps history', () => {
    markLogin('example.com', 'a', { file, now: T0 });
    recordCheck('example.com', 'a', { loggedIn: false, method: 'url' }, { file, now: T1 });
    const e = markLogin('example.com', 'a', { file, now: T2 });
    assert.equal(e.status, 'active');
    assert.equal(e.first_marked_at, T0.toISOString());
    assert.equal(e.last_expired_at, T1.toISOString());
    assert.equal(e.last_confirmed_at, T2.toISOString());
    assert.equal(listLogins({ file }).length, 1);
  });
});

describe('logins - login page detection', () => {
  it('detects login URLs', () => {
    for (const u of [
      'https://example.com/login',
      'https://example.com/user/sign-in?next=/',
      'https://passport.example.com/',
      'https://accounts.example.com/x',
      'https://example.com/#/login',
      'https://example.com/login.html'
    ]) assert.equal(isLoginUrl(u), true, u);
  });

  it('does not flag normal pages', () => {
    for (const u of [
      'https://example.com/',
      'https://example.com/account/settings',
      'https://example.com/blog/how-to-login-faster',
      'https://author.example.com/'
    ]) assert.equal(isLoginUrl(u), false, u);
  });

  it('evaluateLoginState covers url and selector methods', () => {
    assert.equal(evaluateLoginState({ finalUrl: 'https://example.com/home' }).loggedIn, true);
    assert.equal(evaluateLoginState({ finalUrl: 'https://example.com/login' }).loggedIn, false);
    assert.equal(evaluateLoginState({ finalUrl: 'https://example.com/', selector: '#me', selectorCount: 1 }).loggedIn, true);
    assert.equal(evaluateLoginState({ finalUrl: 'https://example.com/', selector: '#me', selectorCount: 0 }).loggedIn, false);
  });

  it('evaluateLoginState refuses to judge a page that did not load', () => {
    assert.throws(() => evaluateLoginState({ finalUrl: 'about:blank' }), { code: 'CHECK_INCONCLUSIVE' });
    assert.throws(() => evaluateLoginState({ finalUrl: 'chrome-error://chromewebdata/' }), { code: 'CHECK_INCONCLUSIVE' });
  });
});

describe('logins - profiles', () => {
  it('resolves default and declared profiles', () => {
    const config = { cdp_port: 9222, profiles: { work: { cdp_port: 9333 } } };
    assert.equal(resolveProfilePort('default', config), 9222);
    assert.equal(resolveProfilePort('work', config), 9333);
    assert.throws(() => resolveProfilePort('other', config), { code: 'UNKNOWN_PROFILE' });
  });
});

function fakeBrowserFactory(pages, calls) {
  return ({ cdpPort }) => ({
    async _exec(args) {
      calls.push({ cdpPort, args });
      const page = pages[cdpPort];
      if (args[0] === 'get' && args[1] === 'url') return page.url;
      if (args[0] === 'get' && args[1] === 'count') return String(page.count ?? 0);
      return '';
    }
  });
}

describe('logins - checkLogin', () => {
  const config = { cdp_port: 9222, profiles: { work: { cdp_port: 9333 } } };

  it('confirms a profile that is still logged in', async () => {
    markLogin('example.com', 'work', { file, now: T0 });
    const calls = [];
    const [r] = await checkLogin('example.com', {
      file, config, now: T1, settleMs: 0,
      browserFactory: fakeBrowserFactory({ 9333: { url: 'https://example.com/dashboard' } }, calls)
    });
    assert.equal(r.loggedIn, true);
    assert.equal(r.entry.last_confirmed_at, T1.toISOString());
    assert.equal(r.entry.confirm_method, 'url');
    assert.deepEqual(calls[0], { cdpPort: 9333, args: ['open', 'https://example.com/'] });
  });

  it('marks expired when redirected to login, and pick then fails', async () => {
    markLogin('example.com', 'work', { file, now: T0 });
    const [r] = await checkLogin('example.com', {
      file, config, now: T1, settleMs: 0,
      browserFactory: fakeBrowserFactory({ 9333: { url: 'https://sso.example.com/?return=x' } }, [])
    });
    assert.equal(r.loggedIn, false);
    assert.equal(r.entry.status, 'expired');
    assert.equal(r.entry.last_expired_at, T1.toISOString());
    assert.equal(r.entry.last_confirmed_at, T0.toISOString());
    assert.throws(() => pickProfile('example.com', { file }), { code: 'LOGIN_REQUIRED' });
  });

  it('uses the selector supplied to check', async () => {
    markLogin('example.com', 'default', { file, now: T0, how: 'selector=.avatar' });
    const calls = [];
    const [r] = await checkLogin('example.com', {
      file, config, now: T1, settleMs: 0, how: 'selector=.avatar',
      browserFactory: fakeBrowserFactory({ 9222: { url: 'https://example.com/', count: 0 } }, calls)
    });
    assert.equal(r.loggedIn, false);
    assert.equal(r.method, 'selector');
    assert.ok(calls.some(c => c.args.join(' ') === 'get count .avatar'));
  });

  it('rejects a port override without a profile before updating any entries', async () => {
    markLogin('example.com', 'default', { file, now: T0 });
    markLogin('example.com', 'work', { file, now: T0 });
    const before = fs.readFileSync(file, 'utf8');
    await assert.rejects(checkLogin('example.com', {
      file, config, cdpPort: 9222, browserFactory: () => assert.fail('must not open')
    }), { code: 'INVALID_ARGUMENT' });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });

  it('never stores check arguments and clears old check settings on re-mark', async () => {
    markLogin('example.com', 'default', { file, how: 'selector=[data-token="FAKE_SECRET"]', checkUrl: 'https://example.com/?session=FAKE_SECRET' });
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /FAKE_SECRET/);
    const legacy = loadRegistry(file);
    legacy.entries[0].check_selector = '#old';
    legacy.entries[0].check_url = 'https://example.com/old';
    fs.writeFileSync(file, JSON.stringify(legacy));
    markLogin('example.com', 'default', { file });
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /check_selector|check_url/);
    const calls = [];
    await checkLogin('example.com', { file, config, settleMs: 0, url: 'https://example.com/?session=FAKE_SECRET', how: 'selector=[data-token="FAKE_SECRET"]', browserFactory: fakeBrowserFactory({ 9222: { url: 'https://example.com/', count: 1 } }, calls) });
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /FAKE_SECRET/);
  });

  it('does not change the registry when the page did not load', async () => {
    markLogin('example.com', 'default', { file, now: T0 });
    await assert.rejects(checkLogin('example.com', {
      file, config, now: T1, settleMs: 0,
      browserFactory: fakeBrowserFactory({ 9222: { url: 'about:blank' } }, [])
    }), { code: 'CHECK_INCONCLUSIVE' });
    assert.equal(pickProfile('example.com', { file }).last_confirmed_at, T0.toISOString());
  });

  it('refuses to check an unregistered domain', async () => {
    await assert.rejects(checkLogin('example.com', {
      file, config, settleMs: 0, browserFactory: () => assert.fail('should not open browser')
    }), { code: 'LOGIN_REQUIRED' });
  });
});

describe('logins - CLI', () => {
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../cli.js');
  const run = (zylosDir, ...args) => spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, ZYLOS_DIR: zylosDir },
    encoding: 'utf8'
  });

  it('pick exits 3 when not registered, and returns the profile after mark', () => {
    let r = run(tmpDir, 'login', 'pick', 'example.com');
    assert.equal(r.status, 3);
    assert.match(r.stderr, /LOGIN_REQUIRED/);

    r = run(tmpDir, 'login', 'mark', 'example.com', '--profile', 'default');
    assert.equal(r.status, 0, r.stderr);

    r = run(tmpDir, 'login', 'pick', 'example.com');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'default');
    assert.ok(fs.existsSync(path.join(tmpDir, 'components/browser/logins.json')));

    r = run(tmpDir, 'login', 'list', '--json');
    assert.equal(JSON.parse(r.stdout)[0].domain, 'example.com');
  });

  it('mark requires --profile', () => {
    const r = run(tmpDir, 'login', 'mark', 'example.com');
    assert.equal(r.status, 1);
  });
});
