import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createApp } from '../server/app.mjs';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NEWAPI_BASE_URL = 'https://api.42w.example';
const NEWAPI_ADMIN_ACCESS_TOKEN = 'admin-token';
const NEWAPI_ADMIN_USER_ID = '1';
const DEFAULT_REWARD_DELIVERY = {
  backend: 'newapi',
  claimMode: 'manual',
  newapi: {
    amounts: {
      pve: {
        novice: 0,
        easy: 0,
        normal: 1_000_000,
        hard: 1_500_000
      },
      pvp: {
        duel: 1_500_000,
        deathmatch: 2_000_000
      }
    }
  }
};

function createMockFetch({ oauthUsersByCode, newapiUsers, updateDelayMs = 0 }) {
  const state = {
    putCalls: [],
    searchCalls: [],
    detailCalls: []
  };

  const users = newapiUsers;

  const fetchImpl = async (url, init = {}) => {
    const target = new URL(String(url));
    const method = String(init.method || 'GET').toUpperCase();

    if (target.origin === 'https://connect.linux.do' && target.pathname === '/oauth2/token') {
      const body = init.body instanceof URLSearchParams ? init.body : new URLSearchParams(String(init.body || ''));
      const code = String(body.get('code') || '');
      const user = oauthUsersByCode.get(code);
      if (!user) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }

      return Response.json({
        access_token: `token:${code}`
      });
    }

    if (target.origin === 'https://connect.linux.do' && target.pathname === '/api/user') {
      const authorization = String(init.headers?.Authorization || init.headers?.authorization || '');
      const code = authorization.replace(/^Bearer\s+/iu, '').replace(/^token:/u, '');
      const user = oauthUsersByCode.get(code);
      if (!user) {
        return new Response(JSON.stringify({ error: 'invalid_token' }), {
          status: 401,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }

      return Response.json({
        sub: user.id,
        preferred_username: user.username,
        name: user.displayName
      });
    }

    if (target.origin !== NEWAPI_BASE_URL) {
      throw new Error(`Unexpected outbound fetch: ${target.toString()}`);
    }

    const authorization = String(init.headers?.Authorization || init.headers?.authorization || '');
    assert.equal(authorization, `Bearer ${NEWAPI_ADMIN_ACCESS_TOKEN}`);
    const newApiUser = String(init.headers?.['New-Api-User'] || init.headers?.['new-api-user'] || '');
    assert.equal(newApiUser, NEWAPI_ADMIN_USER_ID);

    if (target.pathname === '/api/user/search') {
      const keyword = String(target.searchParams.get('keyword') || '').trim();
      state.searchCalls.push(keyword);
      const items = Array.from(users.values()).filter((entry) =>
        [entry.username, entry.display_name, entry.email]
          .filter(Boolean)
          .some((value) => String(value).includes(keyword))
      );

      return Response.json({
        success: true,
        data: items.map((entry) => ({
          id: entry.id,
          username: entry.username,
          display_name: entry.display_name,
          email: entry.email,
          quota: entry.quota
        }))
      });
    }

    if (target.pathname.startsWith('/api/user/') && method === 'GET') {
      const userId = decodeURIComponent(target.pathname.slice('/api/user/'.length));
      state.detailCalls.push(userId);
      const user = users.get(String(userId));
      if (!user) {
        return new Response(JSON.stringify({ success: false, message: 'not found' }), {
          status: 404,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }

      return Response.json({
        success: true,
        data: {
          ...user
        }
      });
    }

    if (target.pathname === '/api/user/' && method === 'PUT') {
      const body = JSON.parse(String(init.body || '{}'));
      const user = users.get(String(body.id));
      if (!user) {
        return new Response(JSON.stringify({ success: false, message: 'not found' }), {
          status: 404,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }

      state.putCalls.push({
        id: String(body.id),
        quota: Number(body.quota),
        beforeQuota: Number(user.quota || 0)
      });

      if (updateDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, updateDelayMs));
      }

      user.quota = Number(body.quota || 0);
      return Response.json({
        success: true,
        data: true
      });
    }

    throw new Error(`Unexpected NewAPI request: ${target.toString()} (${method})`);
  };

  return {
    fetchImpl,
    state
  };
}

function getMockTopupAmountUnits(quota, rewardDelivery = DEFAULT_REWARD_DELIVERY) {
  const quotaPerUnit = Number(rewardDelivery?.newapi?.quotaPerUnit || 500_000) || 500_000;
  return Math.max(1, Math.ceil(Number(quota || 0) / quotaPerUnit));
}

function createMockRewardCreditImpl({ newapiUsers, now, delayMs = 0, rewardDelivery = DEFAULT_REWARD_DELIVERY }) {
  const state = {
    topupCalls: []
  };

  return {
    state,
    async impl({ matchedUser, creditAmountQuota }) {
      const user = newapiUsers.get(String(matchedUser?.id || ''));
      if (!user) {
        const error = new Error('newapi_user_not_found');
        error.code = 'newapi_user_not_found';
        throw error;
      }

      const previousQuota = Number(user.quota || 0);
      const topupTradeNo = `SHG${matchedUser.id}NO${String(state.topupCalls.length + 1).padStart(6, '0')}`;
      const topupAmount = getMockTopupAmountUnits(creditAmountQuota, rewardDelivery);

      state.topupCalls.push({
        userId: String(matchedUser.id),
        previousQuota,
        creditAmountQuota: Number(creditAmountQuota || 0),
        topupTradeNo,
        topupAmount
      });

      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      const nextQuota = previousQuota + Number(creditAmountQuota || 0);
      user.quota = nextQuota;

      return {
        deliveryStatus: 'delivered',
        deliveryError: null,
        creditedAt: now(),
        newapiUserId: String(matchedUser.id),
        previousQuota,
        nextQuota,
        topupTradeNo,
        topupAmount,
        topupMoney: 0,
        topupPaymentMethod: 'Game Reward',
        topupPaymentProvider: 'shooters-main'
      };
    }
  };
}

async function createRewardApp(context, options = {}) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'shooters-newapi-'));
  const dataDir = path.join(tempRoot, 'data');
  let nowMs = Date.UTC(2026, 4, 3, 0, 0, 0);
  const oauthUser = {
    code: 'code-alice',
    id: '1001',
    username: 'alice',
    displayName: 'Alice'
  };
  const oauthUsersByCode = new Map([[oauthUser.code, oauthUser]]);
  const newapiUsers = new Map(
    Array.isArray(options.newapiUsers)
      ? options.newapiUsers.map((entry) => [String(entry.id), { ...entry }])
      : []
  );
  const mockFetch = createMockFetch({
    oauthUsersByCode,
    newapiUsers,
    updateDelayMs: options.updateDelayMs || 0
  });
  const mockRewardCredit = createMockRewardCreditImpl({
    newapiUsers,
    delayMs: options.updateDelayMs || 0,
    rewardDelivery: DEFAULT_REWARD_DELIVERY,
    now: () => new Date(nowMs).toISOString()
  });

  await mkdir(dataDir, { recursive: true });
  await writeFile(
    path.join(dataDir, 'app-config.json'),
    JSON.stringify(
      {
        adminUsernames: ['alice'],
        adminUserIds: [],
        rewardDelivery: DEFAULT_REWARD_DELIVERY
      },
      null,
      2
    )
  );

  const app = createApp({
    rootDir,
    dataDir,
    host: '127.0.0.1',
    port: 0,
    allowClientReportedAwards: true,
    rewardDelivery: DEFAULT_REWARD_DELIVERY,
    newapi: {
      baseUrl: NEWAPI_BASE_URL,
      adminAccessToken: NEWAPI_ADMIN_ACCESS_TOKEN,
      adminUserId: NEWAPI_ADMIN_USER_ID
    },
    linuxDo: {
      clientId: 'test-client',
      clientSecret: 'test-secret',
      baseUrl: 'http://127.0.0.1'
    },
    now: () => nowMs,
    fetchImpl: mockFetch.fetchImpl,
    newapiRewardCreditImpl: mockRewardCredit.impl
  });

  context.after(async () => {
    await app.close();
  });

  const baseUrl = await app.start();

  return {
    baseUrl,
    dataDir,
    oauthUser,
    newapiUsers,
    fetchState: mockFetch.state,
    rewardCreditState: mockRewardCredit.state,
    advance(ms) {
      nowMs += ms;
    }
  };
}

async function loginAs(baseUrl, user) {
  const startResponse = await fetch(`${baseUrl}/auth/linuxdo/start?returnTo=/`, {
    redirect: 'manual'
  });
  assert.equal(startResponse.status, 302);

  const authorizeLocation = startResponse.headers.get('location');
  assert.ok(authorizeLocation);
  const stateToken = new URL(authorizeLocation).searchParams.get('state');
  assert.ok(stateToken);

  const callbackResponse = await fetch(
    `${baseUrl}/auth/linuxdo/callback?code=${encodeURIComponent(user.code)}&state=${encodeURIComponent(stateToken)}`,
    {
      redirect: 'manual'
    }
  );
  assert.equal(callbackResponse.status, 302);

  const cookie = callbackResponse.headers.get('set-cookie');
  assert.ok(cookie);
  return cookie.split(';', 1)[0];
}

async function apiJson(baseUrl, pathname, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');

  if (options.cookie) {
    headers.set('Cookie', options.cookie);
  }

  if (options.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function prepareEligibleReward(baseUrl, cookie, advance, options = {}) {
  const start = await apiJson(baseUrl, '/api/awards/matches/start', {
    method: 'POST',
    cookie,
    body: {
      gameMode: options.gameMode || 'duel',
      difficulty: options.difficulty || 'normal',
      matchType: options.matchType
    }
  });
  assert.equal(start.response.status, 200);
  assert.ok(start.payload.activeMatch?.ticketId);

  advance(options.durationMs || 60_000);

  const prepare = await apiJson(baseUrl, '/api/awards/prepare', {
    method: 'POST',
    cookie,
    body: {
      ticketId: start.payload.activeMatch.ticketId,
      summary: {
        gameMode: options.gameMode || 'duel',
        difficulty: options.difficulty || 'normal',
        matchType: options.matchType,
        rewardPool: options.matchType === 'pvp' ? 'pvp' : undefined,
        winnerTeam: 'p1',
        playerTeam: 'p1',
        playerWon: true,
        playerIsMvp: true,
        eligibleForAward: true,
        mvpTeam: 'p1',
        mvpName: 'Alice',
        playerName: 'Alice',
        matchDurationSeconds: Number((options.durationMs || 60_000) / 1000),
        playerStats: {
          kills: 3,
          deaths: 1,
          damageDealt: 120
        }
      }
    }
  });

  assert.equal(prepare.response.status, 200);
  assert.equal(prepare.payload.prepared, true);
  return {
    start: start.payload,
    prepare: prepare.payload
  };
}

test('newapi reward claim creates a visible topup record and stays idempotent on repeat click', async (context) => {
  const app = await createRewardApp(context, {
    newapiUsers: [
      {
        id: '501',
        username: 'alice',
        display_name: 'Alice',
        email: 'alice@example.com',
        linux_do_id: '1001',
        quota: 2_000_000
      }
    ]
  });
  const { baseUrl, dataDir, oauthUser, newapiUsers, advance, fetchState, rewardCreditState } = app;
  const cookie = await loginAs(baseUrl, oauthUser);

  await prepareEligibleReward(baseUrl, cookie, advance, {
    difficulty: 'normal'
  });

  const claim = await apiJson(baseUrl, '/api/rewards/claim', {
    method: 'POST',
    cookie
  });
  assert.equal(claim.response.status, 200);
  assert.equal(claim.payload.newlyClaimed, true);
  assert.equal(claim.payload.rewardBackend, 'newapi');
  assert.equal(claim.payload.deliveryStatus, 'delivered');
  assert.equal(claim.payload.assignedCdk, null);
  assert.equal(claim.payload.assignedReward.creditAmountQuota, 1_000_000);
  assert.equal(claim.payload.assignedReward.creditAmountLabel, '2 LDC');
  assert.equal(claim.payload.assignedReward.topupPaymentMethod, 'Game Reward');
  assert.match(claim.payload.assignedReward.topupTradeNo, /^SHG501NO/u);
  assert.equal(claim.payload.creditAmountLabel, '2 LDC');
  assert.equal(newapiUsers.get('501').quota, 3_000_000);
  assert.deepEqual(fetchState.searchCalls.slice(0, 2), ['1001', 'alice']);

  const repeatedClaim = await apiJson(baseUrl, '/api/rewards/claim', {
    method: 'POST',
    cookie
  });
  assert.equal(repeatedClaim.response.status, 200);
  assert.equal(repeatedClaim.payload.newlyClaimed, false);
  assert.equal(repeatedClaim.payload.deliveryStatus, 'delivered');
  assert.equal(repeatedClaim.payload.assignedReward.creditAmountLabel, '2 LDC');
  assert.equal(newapiUsers.get('501').quota, 3_000_000);
  assert.equal(fetchState.putCalls.length, 0);
  assert.equal(rewardCreditState.topupCalls.length, 1);

  const rewards = await apiJson(baseUrl, '/api/rewards/me', {
    cookie
  });
  assert.equal(rewards.response.status, 200);
  assert.equal(rewards.payload.rewardBackend, 'newapi');
  assert.equal(rewards.payload.latestClaim.creditAmountLabel, '2 LDC');
  assert.match(rewards.payload.latestClaim.topupTradeNo, /^SHG501NO/u);
  assert.equal(rewards.payload.claimCount, 1);
  assert.equal(rewards.payload.recentClaims.length, 1);
  assert.equal(rewards.payload.recentClaims[0].topupPaymentMethod, 'Game Reward');

  const matchesStore = JSON.parse(await readFile(path.join(dataDir, 'matches.json'), 'utf8'));
  const claimedMatch = matchesStore.matches.find((entry) => entry.rewardStatus === 'claimed');
  assert.ok(claimedMatch);
  assert.equal(claimedMatch.rewardBackend, 'newapi');
  assert.equal(claimedMatch.deliveryStatus, 'delivered');
  assert.equal(claimedMatch.creditAmountQuota, 1_000_000);
  assert.match(claimedMatch.topupTradeNo, /^SHG501NO/u);
  assert.equal(claimedMatch.topupPaymentMethod, 'Game Reward');
  assert.equal(claimedMatch.newapiUserId, '501');
  assert.ok(claimedMatch.creditedAt);
});

test('newapi reward claim stays pending until the user logs into 42 API once', async (context) => {
  const app = await createRewardApp(context, {
    newapiUsers: []
  });
  const { baseUrl, oauthUser, newapiUsers, advance } = app;
  const cookie = await loginAs(baseUrl, oauthUser);

  await prepareEligibleReward(baseUrl, cookie, advance, {
    difficulty: 'hard'
  });

  const firstClaim = await apiJson(baseUrl, '/api/rewards/claim', {
    method: 'POST',
    cookie
  });
  assert.equal(firstClaim.response.status, 409);
  assert.equal(firstClaim.payload.error, 'awaiting_newapi_account');
  assert.equal(firstClaim.payload.rewardBackend, 'newapi');
  assert.equal(firstClaim.payload.deliveryStatus, 'awaiting_newapi_account');
  assert.equal(firstClaim.payload.creditAmountLabel, '3 LDC');

  const rewardsBeforeLogin = await apiJson(baseUrl, '/api/rewards/me', {
    cookie
  });
  assert.equal(rewardsBeforeLogin.response.status, 200);
  assert.ok(rewardsBeforeLogin.payload.pendingAward);
  assert.equal(rewardsBeforeLogin.payload.deliveryStatus, 'awaiting_newapi_account');

  newapiUsers.set('601', {
    id: '601',
    username: 'alice',
    display_name: 'Alice',
    email: 'alice@example.com',
    linux_do_id: '1001',
    quota: 500_000
  });

  const secondClaim = await apiJson(baseUrl, '/api/rewards/claim', {
    method: 'POST',
    cookie
  });
  assert.equal(secondClaim.response.status, 200);
  assert.equal(secondClaim.payload.newlyClaimed, true);
  assert.equal(secondClaim.payload.deliveryStatus, 'delivered');
  assert.equal(secondClaim.payload.creditAmountQuota, 1_500_000);
  assert.equal(newapiUsers.get('601').quota, 2_000_000);
  assert.match(secondClaim.payload.assignedReward.topupTradeNo, /^SHG601NO/u);

  const rewardsAfterLogin = await apiJson(baseUrl, '/api/rewards/me', {
    cookie
  });
  assert.equal(rewardsAfterLogin.response.status, 200);
  assert.equal(rewardsAfterLogin.payload.pendingAward, null);
  assert.equal(rewardsAfterLogin.payload.latestClaim.creditAmountLabel, '3 LDC');
  assert.match(rewardsAfterLogin.payload.latestClaim.topupTradeNo, /^SHG601NO/u);
});

test('same user concurrent newapi claims are serialized so quota never gets overwritten', async (context) => {
  const app = await createRewardApp(context, {
    updateDelayMs: 80,
    newapiUsers: [
      {
        id: '777',
        username: 'alice',
        display_name: 'Alice',
        email: 'alice@example.com',
        linux_do_id: '1001',
        quota: 0
      }
    ]
  });
  const { baseUrl, oauthUser, newapiUsers, advance, fetchState, rewardCreditState } = app;
  const cookieA = await loginAs(baseUrl, oauthUser);
  const cookieB = await loginAs(baseUrl, oauthUser);

  await prepareEligibleReward(baseUrl, cookieA, advance, {
    difficulty: 'normal'
  });
  await prepareEligibleReward(baseUrl, cookieB, advance, {
    difficulty: 'hard'
  });

  const [claimA, claimB] = await Promise.all([
    apiJson(baseUrl, '/api/rewards/claim', {
      method: 'POST',
      cookie: cookieA
    }),
    apiJson(baseUrl, '/api/rewards/claim', {
      method: 'POST',
      cookie: cookieB
    })
  ]);

  assert.equal(claimA.response.status, 200);
  assert.equal(claimB.response.status, 200);
  assert.equal(newapiUsers.get('777').quota, 2_500_000);
  assert.equal(fetchState.putCalls.length, 0);
  assert.equal(rewardCreditState.topupCalls.length, 2);
  assert.equal(rewardCreditState.topupCalls.at(-1)?.creditAmountQuota, 1_500_000);
  assert.ok(
    rewardCreditState.topupCalls.some(
      (entry) => entry.creditAmountQuota === 1_000_000 || entry.creditAmountQuota === 1_500_000
    )
  );
});
