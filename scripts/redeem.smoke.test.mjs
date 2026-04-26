import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';

const USERS = {
  alice: {
    code: 'alice-code',
    id: 1,
    username: 'alice',
    name: 'Alice',
    avatar_url: null
  }
};

function createMockLinuxDoFetch(usersByCode) {
  return async (target, init = {}) => {
    const url = new URL(target, 'http://linuxdo.local');
    if (url.pathname === '/oauth2/token' && init.method === 'POST') {
      const body = new URLSearchParams(init.body);
      const code = body.get('code');
      if (usersByCode.has(code)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: `token-${code}`, token_type: 'Bearer' })
        };
      }
    }

    if (url.pathname === '/api/user') {
      const auth = init.headers?.Authorization || init.headers?.authorization || '';
      const token = String(auth).replace(/^Bearer\s+/i, '');
      const code = token.replace(/^token-/, '');
      const user = usersByCode.get(code);
      if (user) {
        return { ok: true, status: 200, json: async () => user };
      }
    }

    throw new Error(`Unexpected outbound fetch: ${target}`);
  };
}

async function startApp(context) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'shooters-redeem-'));
  const dataDir = path.join(tempRoot, 'data');
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    path.join(dataDir, 'app-config.json'),
    JSON.stringify({ adminUsernames: ['alice'], adminUserIds: [] }, null, 2)
  );

  const usersByCode = new Map(Object.values(USERS).map((user) => [user.code, user]));
  const app = createApp({
    rootDir: tempRoot,
    dataDir,
    host: '127.0.0.1',
    port: 0,
    linuxDo: { clientId: 'test-client', clientSecret: 'test-secret' },
    pvpConfig: { enabled: false, matchmakingEnabled: false, rewardEnabled: false },
    now: () => Date.now(),
    pvpSweepIntervalMs: 60000,
    fetchImpl: createMockLinuxDoFetch(usersByCode)
  });

  context.after(async () => {
    await app.close();
  });

  const baseUrl = await app.start();
  return { baseUrl, dataDir };
}

async function loginAs(baseUrl, user) {
  const startRes = await fetch(`${baseUrl}/auth/linuxdo/start?returnTo=/`, { redirect: 'manual' });
  const loc = startRes.headers.get('location');
  const state = new URL(loc).searchParams.get('state');
  const cbRes = await fetch(
    `${baseUrl}/auth/linuxdo/callback?code=${encodeURIComponent(user.code)}&state=${encodeURIComponent(state)}`,
    { redirect: 'manual' }
  );
  const setCookie = cbRes.headers.get('set-cookie') || '';
  return setCookie.split(';')[0];
}

test('redeem endpoints reject unauthenticated requests', async (context) => {
  const { baseUrl } = await startApp(context);

  const redeemRes = await fetch(`${baseUrl}/api/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'whatever' })
  });
  assert.equal(redeemRes.status, 401);

  const listRes = await fetch(`${baseUrl}/api/admin/redeem-codes`);
  assert.equal(listRes.status, 401);

  const upsertRes = await fetch(`${baseUrl}/api/admin/redeem-codes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'x', creditAmountQuota: 100 })
  });
  assert.equal(upsertRes.status, 401);
});

test('admin can create a redeem code and user can redeem it once', async (context) => {
  const { baseUrl } = await startApp(context);
  const cookie = await loginAs(baseUrl, USERS.alice);

  const code = '42thirdShortcakeAtLinuxdo';
  const quota = 2100000;

  const createRes = await fetch(`${baseUrl}/api/admin/redeem-codes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ code, creditAmountQuota: quota, note: '首测' })
  });
  assert.equal(createRes.status, 200);
  const created = await createRes.json();
  assert.equal(created.code.code, code);
  assert.equal(created.code.creditAmountQuota, quota);
  assert.equal(created.code.status, 'active');
  assert.equal(created.code.claimCount, 0);
  assert.equal(created.created, true);

  const listRes = await fetch(`${baseUrl}/api/admin/redeem-codes`, { headers: { cookie } });
  assert.equal(listRes.status, 200);
  const listed = await listRes.json();
  assert.equal(listed.codes.length, 1);
  assert.equal(listed.codes[0].code, code);

  const redeemRes = await fetch(`${baseUrl}/api/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ code })
  });
  assert.equal(redeemRes.status, 200);
  const redeemed = await redeemRes.json();
  assert.equal(redeemed.code, code);
  assert.equal(redeemed.creditAmountQuota, quota);
  assert.equal(redeemed.newlyClaimed, true);

  const againRes = await fetch(`${baseUrl}/api/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ code })
  });
  assert.equal(againRes.status, 409);
  const againBody = await againRes.json();
  assert.equal(againBody.error, 'already_redeemed');
});

test('unknown and disabled codes are rejected', async (context) => {
  const { baseUrl } = await startApp(context);
  const cookie = await loginAs(baseUrl, USERS.alice);

  const unknownRes = await fetch(`${baseUrl}/api/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ code: 'does-not-exist' })
  });
  assert.equal(unknownRes.status, 404);
  assert.equal((await unknownRes.json()).error, 'redeem_code_not_found');

  await fetch(`${baseUrl}/api/admin/redeem-codes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ code: 'disabled-code', creditAmountQuota: 500000 })
  });

  await fetch(`${baseUrl}/api/admin/redeem-codes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-redeem-action': 'toggle' },
    body: JSON.stringify({ code: 'disabled-code', status: 'disabled' })
  });

  const disabledRes = await fetch(`${baseUrl}/api/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ code: 'disabled-code' })
  });
  assert.equal(disabledRes.status, 409);
  assert.equal((await disabledRes.json()).error, 'redeem_code_disabled');
});
