import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createApp } from '../server/app.mjs';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('Linux.do login flow can dispatch CDKs from separate PVE and PVP pools', async (context) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'shooters-auth-'));
  const dataDir = path.join(tempRoot, 'data');
  let nowMs = Date.UTC(2026, 2, 15, 0, 0, 0);
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    path.join(dataDir, 'app-config.json'),
    JSON.stringify(
      {
        adminUsernames: ['alice'],
        adminUserIds: []
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
    linuxDo: {
      clientId: 'test-client',
      clientSecret: 'test-secret',
      baseUrl: 'http://127.0.0.1'
    },
    now: () => nowMs,
    fetchImpl: async (url) => {
      const target = String(url);

      if (target === 'https://connect.linux.do/oauth2/token') {
        return Response.json({
          access_token: 'fake-access-token'
        });
      }

      if (target === 'https://connect.linux.do/api/user') {
        return Response.json({
          sub: '1001',
          preferred_username: 'alice',
          name: 'Alice'
        });
      }

      throw new Error(`Unexpected outbound fetch: ${target}`);
    }
  });

  context.after(async () => {
    await app.close();
  });

  const baseUrl = await app.start();

  const oauthStartResponse = await fetch(`${baseUrl}/auth/linuxdo/start?returnTo=/admin.html`, {
    redirect: 'manual'
  });

  assert.equal(oauthStartResponse.status, 302);
  const authorizeLocation = oauthStartResponse.headers.get('location');
  assert.ok(authorizeLocation);
  const stateToken = new URL(authorizeLocation).searchParams.get('state');
  assert.ok(stateToken);

  const callbackResponse = await fetch(
    `${baseUrl}/auth/linuxdo/callback?code=fake-code&state=${stateToken}`,
    {
      redirect: 'manual'
    }
  );

  assert.equal(callbackResponse.status, 302);
  assert.equal(callbackResponse.headers.get('location'), '/admin.html');

  const cookie = callbackResponse.headers.get('set-cookie');
  assert.ok(cookie);
  const sessionCookie = cookie.split(';', 1)[0];

  const sessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
    headers: {
      Cookie: sessionCookie
    }
  });

  assert.equal(sessionResponse.status, 200);
  const sessionPayload = await sessionResponse.json();
  assert.equal(sessionPayload.user.username, 'alice');
  assert.equal(sessionPayload.user.displayName, 'alice');

  const initialRewardPolicyResponse = await fetch(`${baseUrl}/api/admin/reward-policy`, {
    headers: {
      Cookie: sessionCookie
    }
  });

  assert.equal(initialRewardPolicyResponse.status, 200);
  const initialRewardPolicyPayload = await initialRewardPolicyResponse.json();
  assert.equal(initialRewardPolicyPayload.rewardPolicy.dailyLimits.pve.easy, 6);
  assert.equal(initialRewardPolicyPayload.rewardPolicy.dailyLimits.pve.hard, 10);
  assert.equal(initialRewardPolicyPayload.rewardPolicy.dailyLimits.pvp.default, 10);
  assert.equal(initialRewardPolicyPayload.rewardPolicyOverrides.hasOverrides, false);

  const saveRewardPolicyResponse = await fetch(`${baseUrl}/api/admin/reward-policy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie
    },
    body: JSON.stringify({
      timeZone: 'Asia/Shanghai',
      dailyLimits: {
        pve: {
          novice: 1,
          easy: 1,
          normal: 2,
          hard: 2
        },
        pvp: {
          default: 2
        }
      }
    })
  });

  assert.equal(saveRewardPolicyResponse.status, 200);
  const saveRewardPolicyPayload = await saveRewardPolicyResponse.json();
  assert.equal(saveRewardPolicyPayload.saved, true);
  assert.equal(saveRewardPolicyPayload.storedRewardPolicy.dailyLimits.pve.novice, 1);
  assert.equal(saveRewardPolicyPayload.storedRewardPolicy.dailyLimits.pve.easy, 1);
  assert.equal(saveRewardPolicyPayload.storedRewardPolicy.dailyLimits.pve.normal, 2);
  assert.equal(saveRewardPolicyPayload.storedRewardPolicy.dailyLimits.pve.hard, 2);
  assert.equal(saveRewardPolicyPayload.storedRewardPolicy.dailyLimits.pvp.default, 2);
  assert.equal(saveRewardPolicyPayload.rewardPolicy.dailyLimits.pve.easy, 1);
  assert.equal(saveRewardPolicyPayload.rewardPolicy.dailyLimits.pvp.default, 2);
  assert.equal(saveRewardPolicyPayload.rewardPolicyOverrides.hasOverrides, false);

  const adminAddResponse = await fetch(`${baseUrl}/api/admin/cdks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie
    },
    body: JSON.stringify({
      pool: 'pve',
      bulkText: 'AAA111\nCCC333\nDDD444',
      note: 'seed pve batch'
    })
  });

  assert.equal(adminAddResponse.status, 200);
  const adminAddPayload = await adminAddResponse.json();
  assert.equal(adminAddPayload.pool, 'pve');
  assert.equal(adminAddPayload.addedCount, 3);
  assert.equal(adminAddPayload.skippedCount, 0);

  const adminAddPvpResponse = await fetch(`${baseUrl}/api/admin/cdks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie
    },
    body: JSON.stringify({
      pool: 'pvp_duel',
      bulkText: 'BBB222',
      note: 'seed pvp duel batch'
    })
  });

  assert.equal(adminAddPvpResponse.status, 200);
  const adminAddPvpPayload = await adminAddPvpResponse.json();
  assert.equal(adminAddPvpPayload.pool, 'pvp_duel');
  assert.equal(adminAddPvpPayload.addedCount, 1);
  assert.equal(adminAddPvpPayload.skippedCount, 0);

  const adminAddPvpDeathmatchResponse = await fetch(`${baseUrl}/api/admin/cdks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie
    },
    body: JSON.stringify({
      pool: 'pvp_deathmatch',
      bulkText: 'EEE555',
      note: 'seed pvp deathmatch batch'
    })
  });

  assert.equal(adminAddPvpDeathmatchResponse.status, 200);
  const adminAddPvpDeathmatchPayload = await adminAddPvpDeathmatchResponse.json();
  assert.equal(adminAddPvpDeathmatchPayload.pool, 'pvp_deathmatch');
  assert.equal(adminAddPvpDeathmatchPayload.addedCount, 1);
  assert.equal(adminAddPvpDeathmatchPayload.skippedCount, 0);

  const startMatchResponse = await fetch(`${baseUrl}/api/awards/matches/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie
    },
    body: JSON.stringify({
      gameMode: 'duel',
      difficulty: 'normal'
    })
  });

  assert.equal(startMatchResponse.status, 200);
  const startMatchPayload = await startMatchResponse.json();
  assert.ok(startMatchPayload.activeMatch?.ticketId);

  nowMs += 53_200;
  const prepareResponse = await fetch(`${baseUrl}/api/awards/prepare`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie
    },
    body: JSON.stringify({
      ticketId: startMatchPayload.activeMatch.ticketId,
      summary: {
        gameMode: 'duel',
        difficulty: 'normal',
        winnerTeam: 'p1',
        playerTeam: 'p1',
        playerWon: true,
        playerIsMvp: true,
        eligibleForAward: true,
        mvpTeam: 'p1',
        mvpName: 'Alice',
        playerName: 'Alice',
        matchDurationSeconds: 53.2,
        playerStats: {
          kills: 3,
          deaths: 1,
          damageDealt: 124
        }
      }
    })
  });

  assert.equal(prepareResponse.status, 200);
  const preparePayload = await prepareResponse.json();
  assert.equal(preparePayload.prepared, true);

  const claimResponse = await fetch(`${baseUrl}/api/cdks/claim`, {
    method: 'POST',
    headers: {
      Cookie: sessionCookie
    }
  });

  assert.equal(claimResponse.status, 200);
  const claimPayload = await claimResponse.json();
  assert.equal(claimPayload.newlyClaimed, true);
  assert.equal(claimPayload.assignedCdk.code, 'AAA111');
  assert.equal(claimPayload.assignedCdk.pool, 'pve');
  assert.equal(claimPayload.rewardPool, 'pve');

  const myCodeResponse = await fetch(`${baseUrl}/api/cdks/me`, {
    headers: {
      Cookie: sessionCookie
    }
  });

  assert.equal(myCodeResponse.status, 200);
  const myCodePayload = await myCodeResponse.json();
  assert.equal(myCodePayload.latestClaim.code, 'AAA111');
  assert.equal(myCodePayload.availableCount, 4);
  assert.equal(myCodePayload.claimCount, 1);
  assert.equal(myCodePayload.availableCounts.pve, 2);
  assert.equal(myCodePayload.availableCounts.pvp, 2);
  assert.equal(myCodePayload.claimCounts.pve, 1);
  assert.equal(myCodePayload.claimCounts.pvp, 0);

  const secondMatchResponse = await fetch(`${baseUrl}/api/awards/matches/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie
    },
    body: JSON.stringify({
      gameMode: 'deathmatch',
      difficulty: 'hard'
    })
  });

  assert.equal(secondMatchResponse.status, 200);
  const secondMatchPayload = await secondMatchResponse.json();
  assert.ok(secondMatchPayload.activeMatch?.ticketId);

  nowMs += 91_400;
  const secondPrepareResponse = await fetch(`${baseUrl}/api/awards/prepare`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie
    },
    body: JSON.stringify({
      ticketId: secondMatchPayload.activeMatch.ticketId,
      summary: {
        gameMode: 'deathmatch',
        difficulty: 'hard',
        winnerTeam: 'p2',
        playerTeam: 'p1',
        playerWon: false,
        playerIsMvp: false,
        eligibleForAward: false,
        mvpTeam: 'p2',
        mvpName: 'Bot Bravo',
        playerName: 'Alice',
        matchDurationSeconds: 91.4,
        playerStats: {
          kills: 1,
          deaths: 3,
          damageDealt: 48
        }
      }
    })
  });

  assert.equal(secondPrepareResponse.status, 200);
  const secondPreparePayload = await secondPrepareResponse.json();
  assert.equal(secondPreparePayload.prepared, false);
  assert.equal(secondPreparePayload.eligible, false);

  const thirdMatchResponse = await fetch(`${baseUrl}/api/awards/matches/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie
    },
    body: JSON.stringify({
      gameMode: 'deathmatch',
      difficulty: 'easy'
    })
  });

  assert.equal(thirdMatchResponse.status, 200);
  const thirdMatchPayload = await thirdMatchResponse.json();
  assert.ok(thirdMatchPayload.activeMatch?.ticketId);

  nowMs += 54_100;
  const thirdPrepareResponse = await fetch(`${baseUrl}/api/awards/prepare`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie
    },
    body: JSON.stringify({
      ticketId: thirdMatchPayload.activeMatch.ticketId,
      summary: {
        gameMode: 'deathmatch',
        difficulty: 'easy',
        winnerTeam: 'p1',
        playerTeam: 'p1',
        playerWon: true,
        playerIsMvp: true,
        eligibleForAward: true,
        mvpTeam: 'p1',
        mvpName: 'Alice',
        playerName: 'Alice',
        matchDurationSeconds: 54.1,
        playerStats: {
          kills: 2,
          deaths: 1,
          damageDealt: 150
        }
      }
    })
  });

  assert.equal(thirdPrepareResponse.status, 200);
  const thirdPreparePayload = await thirdPrepareResponse.json();
  assert.equal(thirdPreparePayload.prepared, true);
  assert.equal(thirdPreparePayload.eligible, true);
  assert.equal(thirdPreparePayload.pendingAward.summary.difficulty, 'easy');
  assert.equal(thirdPreparePayload.pendingAward.summary.rewardPool, 'pve');

  const thirdClaimResponse = await fetch(`${baseUrl}/api/cdks/claim`, {
    method: 'POST',
    headers: {
      Cookie: sessionCookie
    }
  });

  assert.equal(thirdClaimResponse.status, 200);
  const thirdClaimPayload = await thirdClaimResponse.json();
  assert.equal(thirdClaimPayload.assignedCdk.code, 'CCC333');
  assert.equal(thirdClaimPayload.assignedCdk.pool, 'pve');
  assert.equal(thirdClaimPayload.limitStatus.limit, 1);
  assert.equal(thirdClaimPayload.limitStatus.used, 1);
  assert.equal(thirdClaimPayload.limitStatus.remaining, 0);

  const fourthMatchResponse = await fetch(`${baseUrl}/api/awards/matches/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie
    },
    body: JSON.stringify({
      gameMode: 'duel',
      difficulty: 'easy'
    })
  });

  assert.equal(fourthMatchResponse.status, 200);
  const fourthMatchPayload = await fourthMatchResponse.json();
  assert.ok(fourthMatchPayload.activeMatch?.ticketId);

  nowMs += 47_800;
  const fourthPrepareResponse = await fetch(`${baseUrl}/api/awards/prepare`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie
    },
    body: JSON.stringify({
      ticketId: fourthMatchPayload.activeMatch.ticketId,
      summary: {
        gameMode: 'duel',
        difficulty: 'easy',
        winnerTeam: 'p1',
        playerTeam: 'p1',
        playerWon: true,
        playerIsMvp: true,
        eligibleForAward: true,
        mvpTeam: 'p1',
        mvpName: 'Alice',
        playerName: 'Alice',
        matchDurationSeconds: 47.8,
        playerStats: {
          kills: 3,
          deaths: 0,
          damageDealt: 118
        }
      }
    })
  });

  assert.equal(fourthPrepareResponse.status, 200);
  const fourthPreparePayload = await fourthPrepareResponse.json();
  assert.equal(fourthPreparePayload.prepared, true);
  assert.equal(fourthPreparePayload.eligible, true);
  assert.equal(fourthPreparePayload.limitStatus.limit, 1);
  assert.equal(fourthPreparePayload.limitStatus.used, 1);
  assert.equal(fourthPreparePayload.limitStatus.remaining, 0);

  const fourthClaimResponse = await fetch(`${baseUrl}/api/cdks/claim`, {
    method: 'POST',
    headers: {
      Cookie: sessionCookie
    }
  });

  assert.equal(fourthClaimResponse.status, 409);
  const fourthClaimPayload = await fourthClaimResponse.json();
  assert.equal(fourthClaimPayload.error, 'daily_limit_reached');
  assert.equal(fourthClaimPayload.limitStatus.limit, 1);
  assert.equal(fourthClaimPayload.limitStatus.used, 1);
  assert.equal(fourthClaimPayload.limitStatus.remaining, 0);

  const fifthMatchResponse = await fetch(`${baseUrl}/api/awards/matches/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie
    },
    body: JSON.stringify({
      gameMode: 'duel',
      difficulty: 'normal'
    })
  });

  assert.equal(fifthMatchResponse.status, 200);
  const fifthMatchPayload = await fifthMatchResponse.json();
  assert.ok(fifthMatchPayload.activeMatch?.ticketId);

  const immediatePrepareResponse = await fetch(`${baseUrl}/api/awards/prepare`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie
    },
    body: JSON.stringify({
      ticketId: fifthMatchPayload.activeMatch.ticketId,
      summary: {
        gameMode: 'duel',
        difficulty: 'normal',
        winnerTeam: 'p1',
        playerTeam: 'p1',
        playerWon: true,
        playerIsMvp: true,
        eligibleForAward: true,
        mvpTeam: 'p1',
        mvpName: 'Alice',
        playerName: 'Alice',
        matchDurationSeconds: 999,
        playerStats: {
          kills: 4,
          deaths: 0,
          damageDealt: 200
        }
      }
    })
  });

  assert.equal(immediatePrepareResponse.status, 200);
  const immediatePreparePayload = await immediatePrepareResponse.json();
  assert.equal(immediatePreparePayload.prepared, false);
  assert.equal(immediatePreparePayload.eligible, false);
  assert.equal(immediatePreparePayload.disqualifyReason, 'match_too_short');
  assert.equal(immediatePreparePayload.summary.matchDurationSeconds, 0);

  const fifthRetryMatchResponse = await fetch(`${baseUrl}/api/awards/matches/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie
    },
    body: JSON.stringify({
      gameMode: 'duel',
      difficulty: 'normal'
    })
  });

  assert.equal(fifthRetryMatchResponse.status, 200);
  const fifthRetryMatchPayload = await fifthRetryMatchResponse.json();
  assert.ok(fifthRetryMatchPayload.activeMatch?.ticketId);

  nowMs += 105_000;
  const fifthPrepareResponse = await fetch(`${baseUrl}/api/awards/prepare`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie
    },
    body: JSON.stringify({
      ticketId: fifthRetryMatchPayload.activeMatch.ticketId,
      summary: {
        gameMode: 'duel',
        difficulty: 'normal',
        winnerTeam: 'p1',
        playerTeam: 'p1',
        playerWon: true,
        playerIsMvp: true,
        eligibleForAward: true,
        mvpTeam: 'p1',
        mvpName: 'Alice',
        playerName: 'Alice',
        matchDurationSeconds: 105,
        playerStats: {
          kills: 0,
          deaths: 0,
          damageDealt: 0
        }
      }
    })
  });

  assert.equal(fifthPrepareResponse.status, 200);
  const fifthPreparePayload = await fifthPrepareResponse.json();
  assert.equal(fifthPreparePayload.prepared, false);
  assert.equal(fifthPreparePayload.eligible, false);
  assert.equal(fifthPreparePayload.disqualifyReason, 'timeout_zero_kill');

  const sixthMatchResponse = await fetch(`${baseUrl}/api/awards/matches/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie
    },
    body: JSON.stringify({
      gameMode: 'pvp-duel',
      difficulty: 'easy',
      matchType: 'pvp'
    })
  });

  assert.equal(sixthMatchResponse.status, 200);
  const sixthMatchPayload = await sixthMatchResponse.json();
  assert.ok(sixthMatchPayload.activeMatch?.ticketId);
  assert.equal(sixthMatchPayload.activeMatch.matchType, 'pvp');

  nowMs += 63_700;
  const sixthPrepareResponse = await fetch(`${baseUrl}/api/awards/prepare`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie
    },
    body: JSON.stringify({
      ticketId: sixthMatchPayload.activeMatch.ticketId,
      summary: {
        gameMode: 'pvp-duel',
        difficulty: 'easy',
        matchType: 'pvp',
        rewardPool: 'pvp',
        winnerTeam: 'p1',
        playerTeam: 'p1',
        playerWon: true,
        playerIsMvp: true,
        eligibleForAward: true,
        mvpTeam: 'p1',
        mvpName: 'Alice',
        playerName: 'Alice',
        matchDurationSeconds: 63.7,
        playerStats: {
          kills: 4,
          deaths: 2,
          damageDealt: 188
        }
      }
    })
  });

  assert.equal(sixthPrepareResponse.status, 200);
  const sixthPreparePayload = await sixthPrepareResponse.json();
  assert.equal(sixthPreparePayload.prepared, true);
  assert.equal(sixthPreparePayload.eligible, true);
  assert.equal(sixthPreparePayload.rewardPool, 'pvp');
  assert.equal(sixthPreparePayload.codePool, 'pvp_duel');
  assert.equal(sixthPreparePayload.availableCounts.pvp, 2);
  assert.equal(sixthPreparePayload.availableCounts.pvp_duel, 1);
  assert.equal(sixthPreparePayload.availableCounts.pvp_deathmatch, 1);

  const sixthClaimResponse = await fetch(`${baseUrl}/api/cdks/claim`, {
    method: 'POST',
    headers: {
      Cookie: sessionCookie
    }
  });

  assert.equal(sixthClaimResponse.status, 200);
  const sixthClaimPayload = await sixthClaimResponse.json();
  assert.equal(sixthClaimPayload.newlyClaimed, true);
  assert.equal(sixthClaimPayload.assignedCdk.code, 'BBB222');
  assert.equal(sixthClaimPayload.assignedCdk.pool, 'pvp_duel');
  assert.equal(sixthClaimPayload.rewardPool, 'pvp');
  assert.equal(sixthClaimPayload.codePool, 'pvp_duel');

  const seventhMatchResponse = await fetch(`${baseUrl}/api/awards/matches/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie
    },
    body: JSON.stringify({
      gameMode: 'deathmatch',
      difficulty: 'normal',
      matchType: 'pvp'
    })
  });

  assert.equal(seventhMatchResponse.status, 200);
  const seventhMatchPayload = await seventhMatchResponse.json();
  assert.ok(seventhMatchPayload.activeMatch?.ticketId);
  assert.equal(seventhMatchPayload.activeMatch.matchType, 'pvp');

  nowMs += 72_300;
  const seventhPrepareResponse = await fetch(`${baseUrl}/api/awards/prepare`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie
    },
    body: JSON.stringify({
      ticketId: seventhMatchPayload.activeMatch.ticketId,
      summary: {
        gameMode: 'deathmatch',
        difficulty: 'normal',
        matchType: 'pvp',
        rewardPool: 'pvp',
        winnerTeam: 'p1',
        playerTeam: 'p1',
        playerWon: true,
        playerIsMvp: true,
        eligibleForAward: true,
        mvpTeam: 'p1',
        mvpName: 'Alice',
        playerName: 'Alice',
        matchDurationSeconds: 72.3,
        playerStats: {
          kills: 6,
          deaths: 3,
          damageDealt: 244
        }
      }
    })
  });

  assert.equal(seventhPrepareResponse.status, 200);
  const seventhPreparePayload = await seventhPrepareResponse.json();
  assert.equal(seventhPreparePayload.prepared, true);
  assert.equal(seventhPreparePayload.eligible, true);
  assert.equal(seventhPreparePayload.rewardPool, 'pvp');
  assert.equal(seventhPreparePayload.codePool, 'pvp_deathmatch');
  assert.equal(seventhPreparePayload.availableCounts.pvp, 1);
  assert.equal(seventhPreparePayload.availableCounts.pvp_duel, 0);
  assert.equal(seventhPreparePayload.availableCounts.pvp_deathmatch, 1);

  const seventhClaimResponse = await fetch(`${baseUrl}/api/cdks/claim`, {
    method: 'POST',
    headers: {
      Cookie: sessionCookie
    }
  });

  assert.equal(seventhClaimResponse.status, 200);
  const seventhClaimPayload = await seventhClaimResponse.json();
  assert.equal(seventhClaimPayload.newlyClaimed, true);
  assert.equal(seventhClaimPayload.assignedCdk.code, 'EEE555');
  assert.equal(seventhClaimPayload.assignedCdk.pool, 'pvp_deathmatch');
  assert.equal(seventhClaimPayload.rewardPool, 'pvp');
  assert.equal(seventhClaimPayload.codePool, 'pvp_deathmatch');

  const finalMyCodeResponse = await fetch(`${baseUrl}/api/cdks/me`, {
    headers: {
      Cookie: sessionCookie
    }
  });

  assert.equal(finalMyCodeResponse.status, 200);
  const finalMyCodePayload = await finalMyCodeResponse.json();
  assert.equal(finalMyCodePayload.latestClaim.code, 'EEE555');
  assert.equal(finalMyCodePayload.claimCount, 4);
  assert.equal(finalMyCodePayload.claimCounts.pve, 2);
  assert.equal(finalMyCodePayload.claimCounts.pvp, 2);
  assert.equal(finalMyCodePayload.availableCounts.pve, 1);
  assert.equal(finalMyCodePayload.availableCounts.pvp, 0);
  assert.equal(finalMyCodePayload.availableCounts.pvp_duel, 0);
  assert.equal(finalMyCodePayload.availableCounts.pvp_deathmatch, 0);

  const adminListResponse = await fetch(`${baseUrl}/api/admin/cdks`, {
    headers: {
      Cookie: sessionCookie
    }
  });

  assert.equal(adminListResponse.status, 200);
  const adminListPayload = await adminListResponse.json();
  assert.equal(adminListPayload.summary.total, 5);
  assert.equal(adminListPayload.summary.byPool.pve.total, 3);
  assert.equal(adminListPayload.summary.byPool.pve.assigned, 2);
  assert.equal(adminListPayload.summary.byPool.pvp.total, 2);
  assert.equal(adminListPayload.summary.byPool.pvp.assigned, 2);
  assert.equal(adminListPayload.summary.byPool.pvp_duel.total, 1);
  assert.equal(adminListPayload.summary.byPool.pvp_duel.assigned, 1);
  assert.equal(adminListPayload.summary.byPool.pvp_deathmatch.total, 1);
  assert.equal(adminListPayload.summary.byPool.pvp_deathmatch.assigned, 1);
  assert.equal(adminListPayload.summary.byPool.pvp_legacy.total, 0);
  assert.equal(adminListPayload.matchSummary.total, 8);
  assert.equal(adminListPayload.matchSummary.claimed, 4);
  assert.equal(adminListPayload.matchSummary.eligible, 5);
  assert.equal(adminListPayload.matchSummary.byPool.pve.claimed, 2);
  assert.equal(adminListPayload.matchSummary.byPool.pvp.claimed, 2);
  assert.equal(adminListPayload.matches.length, 8);

  const claimedMatch = adminListPayload.matches.find(
    (item) => item.ticketId === startMatchPayload.activeMatch.ticketId
  );
  assert.equal(claimedMatch.rewardStatus, 'claimed');
  assert.equal(claimedMatch.assignedCode, 'AAA111');
  assert.equal(claimedMatch.summary.eligibleForAward, true);

  const nonEligibleMatch = adminListPayload.matches.find(
    (item) => item.ticketId === secondMatchPayload.activeMatch.ticketId
  );
  assert.equal(nonEligibleMatch.rewardStatus, 'not_eligible');
  assert.equal(nonEligibleMatch.summary.eligibleForAward, false);

  const easyClaimedMatch = adminListPayload.matches.find(
    (item) => item.ticketId === thirdMatchPayload.activeMatch.ticketId
  );
  assert.equal(easyClaimedMatch.rewardStatus, 'claimed');
  assert.equal(easyClaimedMatch.summary.eligibleForAward, true);
  assert.equal(easyClaimedMatch.assignedCode, 'CCC333');

  const easyLimitReachedMatch = adminListPayload.matches.find(
    (item) => item.ticketId === fourthMatchPayload.activeMatch.ticketId
  );
  assert.equal(easyLimitReachedMatch.rewardStatus, 'ready');
  assert.equal(easyLimitReachedMatch.summary.eligibleForAward, true);

  const timeoutBlockedMatch = adminListPayload.matches.find(
    (item) => item.ticketId === fifthRetryMatchPayload.activeMatch.ticketId
  );
  assert.equal(timeoutBlockedMatch.rewardStatus, 'not_eligible');
  assert.equal(timeoutBlockedMatch.summary.eligibleForAward, false);
  assert.equal(timeoutBlockedMatch.summary.awardBlockedReason, 'timeout_zero_kill');

  const pvpClaimedMatch = adminListPayload.matches.find(
    (item) => item.ticketId === sixthMatchPayload.activeMatch.ticketId
  );
  assert.equal(pvpClaimedMatch.pool, 'pvp_duel');
  assert.equal(pvpClaimedMatch.rewardStatus, 'claimed');
  assert.equal(pvpClaimedMatch.assignedCode, 'BBB222');
  assert.equal(pvpClaimedMatch.summary.eligibleForAward, true);
  assert.equal(pvpClaimedMatch.summary.rewardPool, 'pvp');
  assert.equal(pvpClaimedMatch.summary.codePool, 'pvp_duel');

  const deathmatchClaimedMatch = adminListPayload.matches.find(
    (item) => item.ticketId === seventhMatchPayload.activeMatch.ticketId
  );
  assert.equal(deathmatchClaimedMatch.pool, 'pvp_deathmatch');
  assert.equal(deathmatchClaimedMatch.rewardStatus, 'claimed');
  assert.equal(deathmatchClaimedMatch.assignedCode, 'EEE555');
  assert.equal(deathmatchClaimedMatch.summary.eligibleForAward, true);
  assert.equal(deathmatchClaimedMatch.summary.rewardPool, 'pvp');
  assert.equal(deathmatchClaimedMatch.summary.codePool, 'pvp_deathmatch');
});
