import { createReadStream, createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip, gunzipSync } from 'node:zlib';

import { createPvpService, normalizePvpConfig } from './pvp.mjs';
import { normalizePvpMapId } from '../src/pvp-map-catalog.mjs';

const SESSION_COOKIE = 'shooters_session';
const DEFAULT_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_AUTHORIZE_ENDPOINT = 'https://connect.linux.do/oauth2/authorize';
const OAUTH_TOKEN_ENDPOINT = 'https://connect.linux.do/oauth2/token';
const OAUTH_USER_ENDPOINT = 'https://connect.linux.do/api/user';
const DEFAULT_REWARD_POOL = 'pve';
const LEGACY_PVP_CODE_POOL = 'pvp';
const DEFAULT_PVP_DUEL_CODE_POOL = 'pvp_duel';
const DEFAULT_PVP_DEATHMATCH_CODE_POOL = 'pvp_deathmatch';
const DEFAULT_REWARD_LIMIT_TIME_ZONE = 'Asia/Shanghai';
const MIN_REWARDABLE_MATCH_SECONDS = 15;
const REWARD_POOLS = new Set([
  'pve',
  LEGACY_PVP_CODE_POOL,
  DEFAULT_PVP_DUEL_CODE_POOL,
  DEFAULT_PVP_DEATHMATCH_CODE_POOL
]);
const GAME_MODES = new Set(['duel', 'deathmatch']);
const DIFFICULTY_LEVELS = new Set(['novice', 'easy', 'normal', 'hard']);
const DEFAULT_DAILY_REWARD_LIMITS = Object.freeze({
  pve: Object.freeze({
    novice: 4,
    easy: 6,
    normal: 8,
    hard: 10
  }),
  pvp: Object.freeze({
    default: 10
  })
});
const DEFAULT_PVP_EVENT_SLUG = '42-cup';
const DEFAULT_PVP_EVENT_TITLE = '42杯';
const PVP_EVENT_SCORING_RULE = Object.freeze({
  version: '42-cup-v3',
  leaderboardMinMatches: 8,
  modes: Object.freeze({
    duel: Object.freeze({
      win: 12,
      mvp: 0,
      kill: 1,
      loss: -10,
      lossTransfer: 0.4
    }),
    deathmatch: Object.freeze({
      win: 42,
      mvp: 12,
      kill: 2,
      loss: -8,
      lossTransfer: 0.25
    })
  })
});
const MANAGED_AWARD_BLOCK_REASONS = new Set([
  'easy_difficulty',
  'daily_limit_disabled',
  'daily_limit_reached',
  'match_too_short',
  'pvp_rewards_disabled',
  'timeout_zero_kill',
  'server_verification_required'
]);

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8'
};

function inferRewardPoolFromValue(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();

  if (!normalized) return DEFAULT_REWARD_POOL;
  if (REWARD_POOLS.has(normalized)) return normalized;
  if (normalized.includes('deathmatch') || normalized.includes('4p') || normalized.includes('4v4')) {
    return DEFAULT_PVP_DEATHMATCH_CODE_POOL;
  }
  if (normalized.includes('duel') || normalized.includes('1v1')) {
    return DEFAULT_PVP_DUEL_CODE_POOL;
  }
  if (normalized.includes('pvp') || normalized.includes('versus') || normalized.includes('vs')) {
    return LEGACY_PVP_CODE_POOL;
  }
  return DEFAULT_REWARD_POOL;
}

function normalizeRewardPool(value, fallback = DEFAULT_REWARD_POOL) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();

  if (REWARD_POOLS.has(normalized)) {
    return normalized;
  }

  if (!normalized) {
    return fallback;
  }

  return inferRewardPoolFromValue(normalized) || fallback;
}

function getRewardPoolFamily(value, fallback = DEFAULT_REWARD_POOL) {
  const pool = normalizeRewardPool(value, fallback);
  if (
    pool === LEGACY_PVP_CODE_POOL ||
    pool === DEFAULT_PVP_DUEL_CODE_POOL ||
    pool === DEFAULT_PVP_DEATHMATCH_CODE_POOL
  ) {
    return 'pvp';
  }
  return 'pve';
}

function getCodePoolForGameMode(mode, fallback = LEGACY_PVP_CODE_POOL) {
  const normalizedMode = normalizeGameMode(mode, null);
  if (normalizedMode === 'deathmatch') {
    return DEFAULT_PVP_DEATHMATCH_CODE_POOL;
  }
  if (normalizedMode === 'duel') {
    return DEFAULT_PVP_DUEL_CODE_POOL;
  }
  return fallback;
}

function getCodePoolForSummary(summary) {
  const explicitPool = normalizeRewardPool(summary?.codePool || '', '');
  if (explicitPool) {
    return explicitPool;
  }

  const familyPool = getRewardPoolFamily(summary?.rewardPool || summary?.matchType || summary?.gameMode);
  if (familyPool === 'pvp') {
    return getCodePoolForGameMode(summary?.gameMode, LEGACY_PVP_CODE_POOL);
  }
  return 'pve';
}

function getCodePoolFallbacks(codePool) {
  const normalizedPool = normalizeRewardPool(codePool, DEFAULT_REWARD_POOL);
  if (
    normalizedPool === DEFAULT_PVP_DUEL_CODE_POOL ||
    normalizedPool === DEFAULT_PVP_DEATHMATCH_CODE_POOL
  ) {
    return [normalizedPool, LEGACY_PVP_CODE_POOL];
  }
  return [normalizedPool];
}

function resolveRequestedCodePool(input) {
  const source = input && typeof input === 'object' ? input : {};
  const explicitPool = normalizeRewardPool(source.codePool || source.rewardPool || source.matchType || '', '');

  if (explicitPool === LEGACY_PVP_CODE_POOL) {
    return getCodePoolForGameMode(source.gameMode, LEGACY_PVP_CODE_POOL);
  }

  if (explicitPool) {
    return explicitPool;
  }

  const rawMode = String(source.gameMode || '')
    .trim()
    .toLowerCase();

  if (rawMode.includes('pvp') || rawMode.includes('versus') || rawMode.includes('vs')) {
    return getCodePoolForGameMode(source.gameMode, LEGACY_PVP_CODE_POOL);
  }

  return DEFAULT_REWARD_POOL;
}

function getPvpEventModeScoring(mode) {
  const normalizedMode = normalizeGameMode(mode, 'duel');
  return PVP_EVENT_SCORING_RULE.modes[normalizedMode] || PVP_EVENT_SCORING_RULE.modes.duel;
}

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return /^(1|true|yes|on)$/iu.test(String(value).trim());
}

function normalizeGameMode(value, fallback = null) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();

  if (GAME_MODES.has(normalized)) {
    return normalized;
  }

  if (normalized.includes('deathmatch') || normalized.includes('4p') || normalized.includes('4v4')) {
    return 'deathmatch';
  }

  if (normalized.includes('duel') || normalized.includes('1v1')) {
    return 'duel';
  }

  return fallback;
}

function normalizeDifficulty(value, fallback = null) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();

  if (DIFFICULTY_LEVELS.has(normalized)) {
    return normalized;
  }

  return fallback;
}

function normalizeManagedAwardBlockReason(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();

  if (MANAGED_AWARD_BLOCK_REASONS.has(normalized)) {
    return normalized;
  }

  return null;
}

function buildAwardSecurityState(allowClientReportedAwards) {
  const enabled = Boolean(allowClientReportedAwards);

  return {
    allowClientReportedAwards: enabled,
    requiresServerVerification: !enabled,
    mode: enabled ? 'legacy_client_reported' : 'server_verification_required'
  };
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return fallback;
  }
  return Math.floor(number);
}

function normalizeOptionalIsoDateTime(value, fallback = null) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return fallback;
  }

  return date.toISOString();
}

function normalizeShortText(value, fallback = '', maxLength = 120) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const text = value.trim();
  if (!text) {
    return fallback;
  }

  return text.slice(0, maxLength);
}

function normalizeLongText(value, fallback = '', maxLength = 2000) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const text = value.trim();
  if (!text) {
    return fallback;
  }

  return text.slice(0, maxLength);
}

function normalizeSlug(value, fallback = DEFAULT_PVP_EVENT_SLUG) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48);

  return normalized || fallback;
}

function normalizePvpEventConfig(input) {
  const source = input && typeof input === 'object' ? input : {};
  const startsAt = normalizeOptionalIsoDateTime(source.startsAt, null);
  const endsAt = normalizeOptionalIsoDateTime(source.endsAt, null);
  const signupStartsAt = normalizeOptionalIsoDateTime(source.signupStartsAt, startsAt);

  return {
    enabled: Boolean(source.enabled),
    slug: normalizeSlug(source.slug, DEFAULT_PVP_EVENT_SLUG),
    title: normalizeShortText(source.title, DEFAULT_PVP_EVENT_TITLE, 80),
    description: normalizeLongText(source.description, '', 1000),
    signupStartsAt:
      signupStartsAt && startsAt && Date.parse(signupStartsAt) > Date.parse(startsAt) ? startsAt : signupStartsAt,
    startsAt,
    endsAt
  };
}

function getPvpEventScoringRule() {
  return {
    version: PVP_EVENT_SCORING_RULE.version,
    leaderboardMinMatches: PVP_EVENT_SCORING_RULE.leaderboardMinMatches,
    modes: {
      duel: { ...PVP_EVENT_SCORING_RULE.modes.duel },
      deathmatch: { ...PVP_EVENT_SCORING_RULE.modes.deathmatch }
    }
  };
}

function canSignUpForPvpEventPhase(phase) {
  return phase === 'signup' || phase === 'live';
}

function getDateMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

function isPvpEventConfigured(config) {
  const startsAtMs = getDateMs(config?.startsAt);
  const endsAtMs = getDateMs(config?.endsAt);
  return Boolean(startsAtMs !== null && endsAtMs !== null && endsAtMs > startsAtMs);
}

function getPvpEventPhase(config, nowIso = new Date().toISOString()) {
  if (!config?.enabled) {
    return 'disabled';
  }

  const startsAtMs = getDateMs(config.startsAt);
  const endsAtMs = getDateMs(config.endsAt);
  if (startsAtMs === null || endsAtMs === null || endsAtMs <= startsAtMs) {
    return 'unconfigured';
  }

  const signupStartsAtMs = getDateMs(config.signupStartsAt || config.startsAt) ?? startsAtMs;
  const nowMs = getDateMs(nowIso) ?? Date.now();
  if (nowMs < signupStartsAtMs) {
    return 'upcoming';
  }
  if (nowMs < startsAtMs) {
    return 'signup';
  }
  if (nowMs < endsAtMs) {
    return 'live';
  }
  return 'ended';
}

function getPvpEventKey(config) {
  return [
    normalizeSlug(config?.slug, DEFAULT_PVP_EVENT_SLUG),
    normalizeOptionalIsoDateTime(config?.startsAt, ''),
    normalizeOptionalIsoDateTime(config?.endsAt, ''),
    PVP_EVENT_SCORING_RULE.version
  ].join(':');
}

function normalizeRewardPolicyConfig(input) {
  const source = input && typeof input === 'object' ? input : {};
  const dailyLimits = source.dailyLimits && typeof source.dailyLimits === 'object' ? source.dailyLimits : {};
  const pve = dailyLimits.pve && typeof dailyLimits.pve === 'object' ? dailyLimits.pve : {};
  const pvp = dailyLimits.pvp && typeof dailyLimits.pvp === 'object' ? dailyLimits.pvp : {};

  return {
    timeZone:
      typeof source.timeZone === 'string' && source.timeZone.trim()
        ? source.timeZone.trim()
        : DEFAULT_REWARD_LIMIT_TIME_ZONE,
    dailyLimits: {
      pve: {
        novice: normalizeNonNegativeInteger(pve.novice, DEFAULT_DAILY_REWARD_LIMITS.pve.novice),
        easy: normalizeNonNegativeInteger(pve.easy, DEFAULT_DAILY_REWARD_LIMITS.pve.easy),
        normal: normalizeNonNegativeInteger(pve.normal, DEFAULT_DAILY_REWARD_LIMITS.pve.normal),
        hard: normalizeNonNegativeInteger(pve.hard, DEFAULT_DAILY_REWARD_LIMITS.pve.hard)
      },
      pvp: {
        default: normalizeNonNegativeInteger(pvp.default, DEFAULT_DAILY_REWARD_LIMITS.pvp.default)
      }
    }
  };
}

function getRewardDayKey(value, timeZone = DEFAULT_REWARD_LIMIT_TIME_ZONE) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const tryTimeZones = [timeZone, DEFAULT_REWARD_LIMIT_TIME_ZONE, 'UTC'];

  for (const candidate of tryTimeZones) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: candidate,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(date);
      const year = parts.find((part) => part.type === 'year')?.value;
      const month = parts.find((part) => part.type === 'month')?.value;
      const day = parts.find((part) => part.type === 'day')?.value;
      if (year && month && day) {
        return `${year}-${month}-${day}`;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function createEmptyDifficultyCounts() {
  return {
    novice: 0,
    easy: 0,
    normal: 0,
    hard: 0,
    default: 0
  };
}

function createEmptyDailyPoolSummary() {
  return {
    total: 0,
    difficulties: createEmptyDifficultyCounts()
  };
}

function createEmptyDailyClaimSummary(timeZone, dayKey) {
  return {
    timeZone,
    dayKey,
    total: 0,
    byPool: {
      pve: createEmptyDailyPoolSummary(),
      pvp: createEmptyDailyPoolSummary()
    }
  };
}

function getRewardDifficultyKey(value, fallback = 'default') {
  return normalizeDifficulty(value, fallback) || fallback;
}

function getUserDailyClaimSummary(store, userKey, rewardPolicy, nowIso = new Date().toISOString()) {
  const timeZone = rewardPolicy?.timeZone || DEFAULT_REWARD_LIMIT_TIME_ZONE;
  const dayKey = getRewardDayKey(nowIso, timeZone);
  const summary = createEmptyDailyClaimSummary(timeZone, dayKey);

  if (!dayKey) {
    return summary;
  }

  for (const entry of Array.isArray(store?.cdks) ? store.cdks : []) {
    if (entry?.claimedBy?.key !== userKey) continue;
    if (getRewardDayKey(entry?.claimedAt, timeZone) !== dayKey) continue;

    const pool = getRewardPoolFamily(entry?.pool);
    const difficultyKey = getRewardDifficultyKey(entry?.claimContext?.summary?.difficulty);
    summary.total += 1;
    summary.byPool[pool].total += 1;
    summary.byPool[pool].difficulties[difficultyKey] += 1;
  }

  return summary;
}

function getRewardLimitConfigForSummary(summary, rewardPolicy) {
  const pool = getRewardPoolFamily(summary?.rewardPool || summary?.matchType || summary?.codePool);
  const difficulty = getRewardDifficultyKey(summary?.difficulty);
  const poolLimits = rewardPolicy?.dailyLimits?.[pool] || {};

  if (pool === 'pve') {
    return {
      pool,
      difficulty,
      scope: 'difficulty',
      limit: normalizeNonNegativeInteger(poolLimits[difficulty], 0)
    };
  }

  if (Number.isFinite(Number(poolLimits[difficulty]))) {
    return {
      pool,
      difficulty,
      scope: 'difficulty',
      limit: normalizeNonNegativeInteger(poolLimits[difficulty], 0)
    };
  }

  return {
    pool,
    difficulty,
    scope: 'pool',
    limit: normalizeNonNegativeInteger(poolLimits.default, 0)
  };
}

function getRewardLimitStatus(summary, rewardPolicy, dailyClaimSummary) {
  if (!summary || typeof summary !== 'object') return null;

  const config = getRewardLimitConfigForSummary(summary, rewardPolicy);
  const poolSummary = dailyClaimSummary?.byPool?.[config.pool] || createEmptyDailyPoolSummary();
  const used =
    config.scope === 'difficulty'
      ? Number(poolSummary.difficulties?.[config.difficulty] || 0)
      : Number(poolSummary.total || 0);

  return {
    pool: config.pool,
    difficulty: config.difficulty,
    scope: config.scope,
    limit: config.limit,
    used,
    remaining: Math.max(0, config.limit - used),
    reached: used >= config.limit,
    dayKey: dailyClaimSummary?.dayKey || null,
    timeZone: rewardPolicy?.timeZone || DEFAULT_REWARD_LIMIT_TIME_ZONE
  };
}

function createEmptyPoolCounts() {
  return {
    pve: 0,
    pvp: 0,
    pvp_duel: 0,
    pvp_deathmatch: 0
  };
}

function createEmptyPoolFamilyCounts() {
  return {
    pve: 0,
    pvp: 0
  };
}

function countByRewardPool(items, predicate = null) {
  const counts = createEmptyPoolCounts();

  for (const item of Array.isArray(items) ? items : []) {
    if (predicate && !predicate(item)) continue;
    counts[normalizeRewardPool(item?.pool)] += 1;
  }

  return counts;
}

function countByRewardPoolFamily(items, predicate = null) {
  const counts = createEmptyPoolFamilyCounts();

  for (const item of Array.isArray(items) ? items : []) {
    if (predicate && !predicate(item)) continue;
    counts[getRewardPoolFamily(item?.pool)] += 1;
  }

  return counts;
}

function selectPoolCount(counts, pool, fallback = 0) {
  const normalizedPool = normalizeRewardPool(pool, DEFAULT_REWARD_POOL);
  return Number(counts?.[normalizedPool] || fallback);
}

function getTotalAvailableCodeCount(counts) {
  return Number(counts?.pve || 0) + Number(counts?.pvp || 0);
}

function getCdkSummary(store) {
  const items = Array.isArray(store?.cdks) ? store.cdks : [];
  const availableByPool = countByRewardPool(items, (entry) => entry?.status === 'available');
  const assignedByPool = countByRewardPool(items, (entry) => entry?.status === 'assigned');
  const totalByFamily = countByRewardPoolFamily(items);
  const availableByFamily = countByRewardPoolFamily(items, (entry) => entry?.status === 'available');
  const assignedByFamily = countByRewardPoolFamily(items, (entry) => entry?.status === 'assigned');

  return {
    total: items.length,
    available: Object.values(availableByPool).reduce((sum, value) => sum + value, 0),
    assigned: Object.values(assignedByPool).reduce((sum, value) => sum + value, 0),
    byPool: {
      pve: {
        total: totalByFamily.pve,
        available: availableByPool.pve,
        assigned: assignedByPool.pve
      },
      pvp: {
        total: totalByFamily.pvp,
        available: availableByFamily.pvp,
        assigned: assignedByFamily.pvp
      },
      pvp_duel: {
        total: items.filter((entry) => normalizeRewardPool(entry?.pool) === DEFAULT_PVP_DUEL_CODE_POOL).length,
        available: availableByPool.pvp_duel,
        assigned: assignedByPool.pvp_duel
      },
      pvp_deathmatch: {
        total: items.filter((entry) => normalizeRewardPool(entry?.pool) === DEFAULT_PVP_DEATHMATCH_CODE_POOL).length,
        available: availableByPool.pvp_deathmatch,
        assigned: assignedByPool.pvp_deathmatch
      },
      pvp_legacy: {
        total: items.filter((entry) => normalizeRewardPool(entry?.pool) === LEGACY_PVP_CODE_POOL).length,
        available: availableByPool.pvp,
        assigned: assignedByPool.pvp
      }
    }
  };
}

function getAvailableCounts(store) {
  const summary = getCdkSummary(store);
  return {
    pve: summary.byPool.pve.available,
    pvp: summary.byPool.pvp.available,
    pvp_duel: summary.byPool.pvp_duel.available,
    pvp_deathmatch: summary.byPool.pvp_deathmatch.available
  };
}

function getUserClaimSummary(store, userKey) {
  const items = Array.isArray(store?.cdks)
    ? store.cdks.filter((entry) => entry?.claimedBy?.key === userKey)
    : [];

  return {
    total: items.length,
    byPool: countByRewardPoolFamily(items)
  };
}

function getMatchSummary(matches) {
  const items = Array.isArray(matches) ? matches : [];
  const normalizedItems = items.map((entry) => ({
    ...entry,
    pool: getRewardPoolFamily(entry?.summary?.rewardPool || entry?.summary?.matchType || entry?.pool)
  }));
  const totalByPool = countByRewardPool(normalizedItems, () => true);
  const claimedByPool = countByRewardPool(normalizedItems, (entry) => entry?.rewardStatus === 'claimed');
  const eligibleByPool = countByRewardPool(normalizedItems, (entry) => Boolean(entry?.summary?.eligibleForAward));

  return {
    total: items.length,
    claimed: items.filter((entry) => entry.rewardStatus === 'claimed').length,
    eligible: items.filter((entry) => entry.summary?.eligibleForAward).length,
    byPool: {
      pve: {
        total: totalByPool.pve,
        claimed: claimedByPool.pve,
        eligible: eligibleByPool.pve
      },
      pvp: {
        total: totalByPool.pvp,
        claimed: claimedByPool.pvp,
        eligible: eligibleByPool.pvp
      }
    }
  };
}

function cleanBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/u, '');
}

function joinBaseUrl(baseUrl, relativePath = '/') {
  const cleanBase = cleanBaseUrl(baseUrl);
  const cleanPath = `/${String(relativePath || '/').replace(/^\/+/u, '')}`;
  if (!cleanBase) {
    return cleanPath;
  }
  return `${cleanBase}${cleanPath}`;
}

function normalizeOrigins(values) {
  return splitCsv(values)
    .map((entry) => cleanBaseUrl(entry))
    .filter(Boolean);
}

function getRequestOrigin(req) {
  return cleanBaseUrl(req?.headers?.origin || '');
}

function getBearerToken(req) {
  const header = String(req?.headers?.authorization || '').trim();
  if (!header) return '';
  const match = header.match(/^Bearer\s+(.+)$/iu);
  return match ? match[1].trim() : '';
}

function readPvpAccessToken(req, requestUrl = null) {
  const bearerToken = getBearerToken(req);
  if (bearerToken) return bearerToken;
  return String(requestUrl?.searchParams?.get('pvp_access_token') || '').trim();
}

function signPvpEdgeTokenPayload(encodedPayload, secret) {
  return createHmac('sha256', String(secret || ''))
    .update(String(encodedPayload || ''))
    .digest('base64url');
}

function createPvpEdgeAccessToken(user, secret, issuedAtMs, ttlMs) {
  const safeIssuedAtMs = Number.isFinite(Number(issuedAtMs)) ? Number(issuedAtMs) : Date.now();
  const safeTtlMs = Math.max(60_000, Number(ttlMs) || 12 * 60 * 60 * 1000);
  const payload = {
    v: 1,
    sub: getUserKey(user),
    iat: Math.floor(safeIssuedAtMs / 1000),
    exp: Math.floor((safeIssuedAtMs + safeTtlMs) / 1000),
    user: summarizeUser(user)
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = signPvpEdgeTokenPayload(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

function verifyPvpEdgeAccessToken(token, secret, nowMs = Date.now()) {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken || !secret) return null;

  const [encodedPayload, providedSignature, ...rest] = normalizedToken.split('.');
  if (!encodedPayload || !providedSignature || rest.length) {
    return null;
  }

  const expectedSignature = signPvpEdgeTokenPayload(encodedPayload, secret);
  const providedBuffer = Buffer.from(providedSignature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  const expiresAtMs = Number(payload?.exp) * 1000;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Number(nowMs || Date.now())) {
    return null;
  }

  const user = payload?.user && typeof payload.user === 'object' ? payload.user : null;
  if (!user?.id || !user?.username) {
    return null;
  }

  return {
    expiresAt: new Date(expiresAtMs).toISOString(),
    issuedAt: Number.isFinite(Number(payload?.iat))
      ? new Date(Number(payload.iat) * 1000).toISOString()
      : null,
    user: {
      id: String(user.id),
      username: String(user.username),
      displayName: String(user.displayName || user.username),
      avatarUrl: user.avatarUrl || null
    }
  };
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseCookies(headerValue) {
  const cookies = {};

  for (const chunk of String(headerValue || '').split(';')) {
    const index = chunk.indexOf('=');
    if (index <= 0) continue;
    const key = chunk.slice(0, index).trim();
    const value = chunk.slice(index + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }

  return cookies;
}

function sendJson(res, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
    ...headers
  });
  res.end(body);
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(html),
    'Content-Type': 'text/html; charset=utf-8'
  });
  res.end(html);
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, {
    Location: location,
    ...headers
  });
  res.end();
}

function sendMethodNotAllowed(res) {
  sendJson(res, 405, { error: 'method_not_allowed' });
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      throw new Error('request_too_large');
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};

  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text);
}

async function ensureJsonFile(filePath, defaultValue) {
  try {
    await fs.access(filePath);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      throw error;
    }
    await writeJsonFile(filePath, defaultValue);
  }
}

async function readJsonFile(filePath, defaultValue) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return defaultValue;
    }
    throw error;
  }
}

async function writeJsonFile(filePath, value) {
  const tempPath = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}

function createReplayDateParts(value) {
  const date = new Date(value || Date.now());
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = String(safeDate.getUTCFullYear());
  const month = String(safeDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(safeDate.getUTCDate()).padStart(2, '0');
  const hour = String(safeDate.getUTCHours()).padStart(2, '0');
  const minute = String(safeDate.getUTCMinutes()).padStart(2, '0');
  const second = String(safeDate.getUTCSeconds()).padStart(2, '0');
  return {
    year,
    month,
    day,
    stamp: `${year}${month}${day}-${hour}${minute}${second}`
  };
}

function buildReplayRelativePath(matchId, mode, startedAt, compressed = false) {
  const safeMode = String(mode || 'pvp').replace(/[^a-z0-9_-]+/giu, '-').slice(0, 24) || 'pvp';
  const safeMatchId = String(matchId || randomUUID()).replace(/[^a-z0-9_-]+/giu, '-').slice(0, 80);
  const { year, month, day, stamp } = createReplayDateParts(startedAt);
  const fileName = `${stamp}-${safeMode}-${safeMatchId}.ndjson${compressed ? '.gz' : ''}`;
  return path.posix.join('pvp-replays', `${year}-${month}-${day}`, fileName);
}

function toReplayAbsolutePath(rootDir, relativePath) {
  const normalized = String(relativePath || '')
    .replace(/\\/gu, '/')
    .split('/')
    .filter(Boolean);
  return path.join(rootDir, ...normalized);
}

function streamWriteText(stream, text) {
  return new Promise((resolve, reject) => {
    const handleError = (error) => {
      stream.off('drain', handleDrain);
      reject(error);
    };
    const handleDrain = () => {
      stream.off('error', handleError);
      resolve();
    };

    stream.once('error', handleError);
    const ready = stream.write(text, 'utf8', () => {
      if (ready) {
        stream.off('error', handleError);
        resolve();
      }
    });

    if (!ready) {
      stream.once('drain', handleDrain);
    }
  });
}

function endWritableStream(stream) {
  return new Promise((resolve, reject) => {
    const handleError = (error) => {
      stream.off('finish', handleFinish);
      reject(error);
    };
    const handleFinish = () => {
      stream.off('error', handleError);
      resolve();
    };

    stream.once('error', handleError);
    stream.once('finish', handleFinish);
    stream.end();
  });
}

function getMimeType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function getRequestBaseUrl(req, configuredBaseUrl) {
  if (configuredBaseUrl) {
    return cleanBaseUrl(configuredBaseUrl);
  }

  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const protocol = forwardedProto || 'http';
  const host = forwardedHost || req.headers.host || '127.0.0.1';
  return `${protocol}://${host}`;
}

function getRequestWebSocketUrl(req, configuredBaseUrl, pathname) {
  const baseUrl = getRequestBaseUrl(req, configuredBaseUrl);
  const targetPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${baseUrl.replace(/^http/iu, 'ws')}${targetPath}`;
}

function getCallbackUrl(req, oauthConfig) {
  if (oauthConfig.callbackUrl) {
    return cleanBaseUrl(oauthConfig.callbackUrl);
  }
  return `${getRequestBaseUrl(req, oauthConfig.baseUrl)}/auth/linuxdo/callback`;
}

function normalizeLinuxDoProfile(profile) {
  const source = profile && typeof profile === 'object' ? profile : {};
  const nestedUser = source.user && typeof source.user === 'object' ? source.user : {};

  const rawId =
    nestedUser.id ??
    source.id ??
    source.sub ??
    source.user_id ??
    nestedUser.sub ??
    null;

  const username =
    nestedUser.username ??
    source.username ??
    source.preferred_username ??
    source.login ??
    nestedUser.login ??
    source.name ??
    null;

  if (!rawId && !username) {
    throw new Error('linuxdo_profile_missing_identifier');
  }

  const resolvedUsername = String(username || `user-${rawId}`);
  const displayName = String(
    nestedUser.name ??
      source.name ??
      nestedUser.nickname ??
      source.nickname ??
      resolvedUsername
  );

  return {
    id: String(rawId || resolvedUsername),
    username: resolvedUsername,
    displayName,
    avatarUrl:
      nestedUser.avatar_url ??
      source.avatar_url ??
      nestedUser.picture ??
      source.picture ??
      null
  };
}

function createStateToken() {
  return randomBytes(24).toString('hex');
}

function getUserKey(user) {
  return `linuxdo:${user.id}`;
}

function summarizeUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl || null
  };
}

function normalizeStoredUser(input) {
  const source = input && typeof input === 'object' ? input : {};
  const id = source.id ?? source.userId ?? null;
  if (id === null || id === undefined || id === '') {
    return null;
  }

  return summarizeUser({
    id: String(id),
    username: String(source.username || ''),
    displayName: String(source.displayName || source.username || source.id || id),
    avatarUrl: source.avatarUrl || null
  });
}

function summarizeCdk(item) {
  return {
    id: item.id,
    code: item.code,
    pool: normalizeRewardPool(item.pool),
    status: item.status,
    note: item.note || '',
    createdAt: item.createdAt,
    createdBy: item.createdBy || null,
    claimedAt: item.claimedAt || null,
    claimedBy: item.claimedBy || null,
    claimContext: item.claimContext || null
  };
}

function summarizeReplayRecord(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const relativePath =
    typeof item.relativePath === 'string' && item.relativePath.trim()
      ? item.relativePath.trim().replace(/\\/gu, '/')
      : null;
  const fileName =
    typeof item.fileName === 'string' && item.fileName.trim()
      ? item.fileName.trim()
      : relativePath
        ? path.posix.basename(relativePath)
        : null;

  return {
    available: Boolean(item.available),
    status:
      typeof item.status === 'string' && item.status.trim()
        ? item.status.trim()
        : item.available
          ? 'ready'
          : 'missing',
    matchId: item.matchId ? String(item.matchId) : null,
    mode: typeof item.mode === 'string' ? item.mode : null,
    mapId: normalizePvpMapId(item.mapId, null),
    format: typeof item.format === 'string' ? item.format : null,
    relativePath,
    fileName,
    compressed: Boolean(item.compressed),
    sizeBytes: Number.isFinite(Number(item.sizeBytes))
      ? Math.max(0, Math.floor(Number(item.sizeBytes)))
      : null,
    snapshotCount: Number.isFinite(Number(item.snapshotCount))
      ? Math.max(0, Math.floor(Number(item.snapshotCount)))
      : 0,
    eventCount: Number.isFinite(Number(item.eventCount))
      ? Math.max(0, Math.floor(Number(item.eventCount)))
      : 0,
    createdAt: item.createdAt || null,
    error:
      typeof item.error === 'string' && item.error.trim()
        ? item.error.trim().slice(0, 200)
        : null
  };
}

function calculateReplayTimelineSeconds(serverTime, startedAtMs) {
  const safeServerTime = Number(serverTime);
  const safeStartedAtMs = Number(startedAtMs);
  if (!Number.isFinite(safeServerTime) || !Number.isFinite(safeStartedAtMs)) {
    return null;
  }
  return Math.max(0, Math.round(((safeServerTime - safeStartedAtMs) / 1000) * 100) / 100);
}

function buildReplayEventSummary(event) {
  if (!event || typeof event !== 'object') {
    return 'unknown';
  }

  if (event.type === 'kill') {
    return `kill:${event.attackerUserId || '-'}->${event.targetUserId || '-'}`;
  }
  if (event.type === 'hit') {
    return `hit:${event.attackerUserId || '-'}->${event.targetUserId || '-'}(${Math.max(0, Number(event.damage || 0))})`;
  }
  if (event.type === 'respawn') {
    return `respawn:${event.userId || '-'}`;
  }
  if (event.type === 'round_start') {
    return `round_start:${Math.max(0, Number(event.round || 0))}`;
  }
  if (event.type === 'round_end') {
    return `round_end:${Math.max(0, Number(event.round || 0))}:${event.winnerTeam || '-'}`;
  }
  if (event.type === 'sudden_death') {
    return 'sudden_death';
  }
  if (event.type === 'match_end') {
    return `match_end:${event.winnerTeam || '-'}:${event.endedReason || 'completed'}`;
  }
  if (event.type === 'fire') {
    return `fire:${event.attackerUserId || '-'}:${event.weaponId || '-'}`;
  }

  return String(event.type || 'unknown');
}

function mergeReplayPlayerDirectory(metaPlayers, resultStats, matchRecords) {
  const playersById = new Map();
  const upsert = (entry) => {
    const userId = entry?.userId ?? entry?.id ?? null;
    if (userId === null || userId === undefined || userId === '') {
      return;
    }
    const key = String(userId);
    const previous = playersById.get(key) || {};
    playersById.set(key, {
      userId: key,
      username:
        entry?.username !== undefined && entry?.username !== null && entry?.username !== ''
          ? String(entry.username)
          : previous.username || '',
      displayName:
        entry?.displayName !== undefined && entry?.displayName !== null && entry?.displayName !== ''
          ? String(entry.displayName)
          : previous.displayName || previous.username || key,
      team:
        entry?.team !== undefined && entry?.team !== null && entry?.team !== ''
          ? String(entry.team)
          : previous.team || null
    });
  };

  for (const player of Array.isArray(metaPlayers) ? metaPlayers : []) {
    upsert(player);
  }
  for (const stat of Array.isArray(resultStats) ? resultStats : []) {
    upsert(stat);
  }
  for (const record of Array.isArray(matchRecords) ? matchRecords : []) {
    upsert({
      userId: record?.user?.id,
      username: record?.user?.username,
      displayName: record?.user?.displayName,
      team: record?.summary?.playerTeam
    });
  }

  return [...playersById.values()];
}

async function readReplayFileText(rootDir, replay) {
  const normalizedReplay = summarizeReplayRecord(replay);
  if (!normalizedReplay?.relativePath) {
    const error = new Error('replay_not_available');
    error.code = 'replay_not_available';
    throw error;
  }

  const absolutePath = toReplayAbsolutePath(rootDir, normalizedReplay.relativePath);
  const buffer = await fs.readFile(absolutePath);
  if (
    normalizedReplay.compressed ||
    normalizedReplay.format === 'ndjson.gz' ||
    normalizedReplay.relativePath.endsWith('.gz')
  ) {
    return gunzipSync(buffer).toString('utf8');
  }
  return buffer.toString('utf8');
}

function parseReplayText(text) {
  const records = [];
  const lines = String(text || '')
    .split(/\r?\n/iu)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = 0; index < lines.length; index += 1) {
    try {
      records.push(JSON.parse(lines[index]));
    } catch (error) {
      const parseError = new Error(`invalid_replay_line_${index + 1}`);
      parseError.code = 'invalid_replay_file';
      parseError.line = index + 1;
      parseError.cause = error;
      throw parseError;
    }
  }

  return records;
}

function buildReplayContentSummary({ meta, snapshots, events, result, records, matchRecords, replay }) {
  const startedAtMs = Date.parse(String(meta?.startedAt || ''));
  const firstServerTime =
    snapshots.find((entry) => Number.isFinite(Number(entry.serverTime)))?.serverTime ??
    events.find((entry) => Number.isFinite(Number(entry.serverTime)))?.serverTime ??
    null;
  const lastServerTime =
    [...snapshots].reverse().find((entry) => Number.isFinite(Number(entry.serverTime)))?.serverTime ??
    [...events].reverse().find((entry) => Number.isFinite(Number(entry.serverTime)))?.serverTime ??
    null;
  const eventTypes = {};

  for (const event of events) {
    eventTypes[event.type] = (eventTypes[event.type] || 0) + 1;
  }

  const mapId = normalizePvpMapId(
    meta?.mapId || result?.mapId || snapshots[0]?.mapId || replay?.mapId || null,
    null
  );

  return {
    schemaVersion: 1,
    recordCount: Array.isArray(records) ? records.length : 0,
    snapshotCount: snapshots.length,
    eventCount: events.length,
    participantCount: mergeReplayPlayerDirectory(meta?.players, result?.stats, matchRecords).length,
    startedAt: meta?.startedAt || matchRecords[0]?.startedAt || null,
    firstServerTime: Number.isFinite(Number(firstServerTime)) ? Number(firstServerTime) : null,
    lastServerTime: Number.isFinite(Number(lastServerTime)) ? Number(lastServerTime) : null,
    durationSeconds:
      Number.isFinite(startedAtMs) && Number.isFinite(Number(lastServerTime))
        ? calculateReplayTimelineSeconds(lastServerTime, startedAtMs)
        : null,
    mapId,
    winnerTeam: result?.winnerTeam || null,
    endedReason: result?.endedReason || null,
    eventTypes,
    replay: summarizeReplayRecord(replay)
  };
}

function buildReplayContentPayload(replay, records, matchRecords) {
  const meta = records.find((entry) => entry?.type === 'meta')?.payload || null;
  const result = records.findLast?.((entry) => entry?.type === 'result')?.payload ||
    [...records].reverse().find((entry) => entry?.type === 'result')?.payload ||
    null;
  const startedAtMs = Date.parse(String(meta?.startedAt || ''));

  const snapshots = records
    .filter((entry) => entry?.type === 'snapshot' && entry.payload && typeof entry.payload === 'object')
    .map((entry, index) => ({
      index,
      timelineSeconds: calculateReplayTimelineSeconds(entry.payload.serverTime, startedAtMs),
      ...entry.payload
    }));

  const events = records
    .filter((entry) => entry?.type === 'event' && entry.payload && typeof entry.payload === 'object')
    .map((entry, index) => {
      const rawEvent = entry.payload.event && typeof entry.payload.event === 'object' ? entry.payload.event : {};
      return {
        index,
        matchId: entry.payload.matchId ? String(entry.payload.matchId) : null,
        mode: typeof entry.payload.mode === 'string' ? entry.payload.mode : null,
        id: rawEvent.id || `${entry.payload.matchId || replay?.matchId || 'replay'}:${index}`,
        type: typeof rawEvent.type === 'string' ? rawEvent.type : 'unknown',
        tick: Number.isFinite(Number(rawEvent.tick)) ? Math.floor(Number(rawEvent.tick)) : null,
        serverTime: Number.isFinite(Number(rawEvent.serverTime)) ? Number(rawEvent.serverTime) : null,
        timelineSeconds: calculateReplayTimelineSeconds(rawEvent.serverTime, startedAtMs),
        summary: buildReplayEventSummary(rawEvent),
        ...rawEvent
      };
    });

  const players = mergeReplayPlayerDirectory(meta?.players, result?.stats, matchRecords);
  const summary = buildReplayContentSummary({
    meta,
    snapshots,
    events,
    result,
    records,
    matchRecords,
    replay
  });
  const mapId = normalizePvpMapId(summary.mapId || meta?.mapId || result?.mapId || replay?.mapId || null, null);

  return {
    replay: summarizeReplayRecord(replay),
    meta,
    mapId,
    players,
    snapshots,
    events,
    result,
    summary
  };
}

function findReplayMatchRecords(matchStore, matchId) {
  const normalizedMatchId = String(matchId || '').trim();
  if (!normalizedMatchId) {
    return [];
  }

  return Array.isArray(matchStore?.matches)
    ? matchStore.matches.filter((record) => {
        const replayMatchId = String(record?.replay?.matchId || '').trim();
        return replayMatchId === normalizedMatchId;
      })
    : [];
}

function buildReplayDetailPayload(replay, matchRecords) {
  const normalizedRecords = matchRecords
    .map((record) => summarizeMatchRecord(record))
    .sort((left, right) =>
      String(left.user?.displayName || left.user?.username || left.user?.id || '').localeCompare(
        String(right.user?.displayName || right.user?.username || right.user?.id || '')
      )
    );
  const replaySummary = summarizeReplayRecord(replay);
  const primaryRecord = normalizedRecords[0] || null;
  const mapId = normalizePvpMapId(replaySummary?.mapId || null, null);
  const players = mergeReplayPlayerDirectory(
    [],
    [],
    normalizedRecords
  ).map((player) => {
    const relatedRecord = normalizedRecords.find((record) => String(record.user?.id || '') === player.userId) || null;
    return {
      ...player,
      summary: relatedRecord?.summary || null,
      rewardStatus: relatedRecord?.rewardStatus || 'not_eligible'
    };
  });

  return {
    matchId: replaySummary?.matchId || null,
    mapId,
    replay: replaySummary,
    match: {
      mode: replaySummary?.mode || primaryRecord?.summary?.gameMode || null,
      mapId,
      roomCode: null,
      source: null,
      startedAt: primaryRecord?.startedAt || null,
      completedAt: primaryRecord?.completedAt || null,
      recordedAt: primaryRecord?.recordedAt || null,
      winnerTeam: primaryRecord?.summary?.winnerTeam || null,
      endedReason: null
    },
    players,
    records: normalizedRecords
  };
}

function canUserAccessReplay(matchRecords, user, isAdmin = false) {
  if (isAdmin) {
    return true;
  }
  if (!user?.id) {
    return false;
  }

  const userId = String(user.id);
  return matchRecords.some((record) => String(record?.user?.id || '') === userId);
}

function calculatePvpEventScoreDelta(summary) {
  const normalizedSummary = sanitizeAwardSummary(summary || null);
  if (getRewardPoolFamily(normalizedSummary?.rewardPool || normalizedSummary?.matchType || normalizedSummary?.codePool) !== 'pvp') {
    return 0;
  }

  const scoring = getPvpEventModeScoring(normalizedSummary?.gameMode);
  const kills = Math.max(0, Math.floor(Number(normalizedSummary?.playerStats?.kills || 0)));
  let score = normalizedSummary?.playerWon ? scoring.win : scoring.loss;
  if (normalizedSummary?.playerIsMvp) {
    score += scoring.mvp;
  }
  score += kills * scoring.kill;
  return Math.trunc(score);
}

function calculatePvpEventLossTransfer(lossScore, transferRate) {
  const normalizedLoss = Math.max(0, Math.abs(Math.trunc(Number(lossScore) || 0)));
  const normalizedRate = Math.max(0, Number(transferRate) || 0);
  if (!normalizedLoss || !normalizedRate) {
    return 0;
  }
  return Math.max(0, Math.round(normalizedLoss * normalizedRate));
}

function getPvpEventMatchKey(matchRecord) {
  if (matchRecord?.replay?.matchId) {
    return `replay:${String(matchRecord.replay.matchId)}`;
  }
  if (matchRecord?.ticketId) {
    return `ticket:${String(matchRecord.ticketId)}`;
  }
  return [
    'fallback',
    normalizeGameMode(matchRecord?.summary?.gameMode, 'duel'),
    matchRecord?.startedAt || '',
    matchRecord?.completedAt || matchRecord?.recordedAt || '',
    matchRecord?.summary?.winnerTeam || ''
  ].join(':');
}

function getPvpEventMatchAnchorMs(matchRecord) {
  return getDateMs(matchRecord?.startedAt || matchRecord?.completedAt || matchRecord?.recordedAt);
}

function groupPvpEventMatchRecords(matchRecords) {
  const groups = new Map();

  for (const entry of Array.isArray(matchRecords) ? matchRecords : []) {
    const matchRecord = summarizeMatchRecord(entry);
    if (
      getRewardPoolFamily(matchRecord.pool || matchRecord.summary?.rewardPool || matchRecord.summary?.matchType) !== 'pvp' ||
      !matchRecord.user?.id ||
      !matchRecord.summary
    ) {
      continue;
    }

    const key = getPvpEventMatchKey(matchRecord);
    const existing = groups.get(key);
    if (existing) {
      existing.records.push(matchRecord);
      continue;
    }
    groups.set(key, {
      key,
      anchorMs: getPvpEventMatchAnchorMs(matchRecord),
      completedAtMs: getDateMs(matchRecord.completedAt || matchRecord.recordedAt),
      records: [matchRecord]
    });
  }

  return [...groups.values()].sort((left, right) => {
    const leftAnchor = Number.isFinite(Number(left.anchorMs)) ? Number(left.anchorMs) : Number.MAX_SAFE_INTEGER;
    const rightAnchor = Number.isFinite(Number(right.anchorMs)) ? Number(right.anchorMs) : Number.MAX_SAFE_INTEGER;
    if (leftAnchor !== rightAnchor) {
      return leftAnchor - rightAnchor;
    }

    const leftCompleted = Number.isFinite(Number(left.completedAtMs)) ? Number(left.completedAtMs) : Number.MAX_SAFE_INTEGER;
    const rightCompleted = Number.isFinite(Number(right.completedAtMs)) ? Number(right.completedAtMs) : Number.MAX_SAFE_INTEGER;
    if (leftCompleted !== rightCompleted) {
      return leftCompleted - rightCompleted;
    }

    return String(left.key).localeCompare(String(right.key));
  });
}

function buildPvpEventMatchScoreDeltas(matchRecords) {
  const deltas = new Map();
  const records = Array.isArray(matchRecords) ? matchRecords.map((entry) => summarizeMatchRecord(entry)) : [];

  for (const record of records) {
    if (!record?.user?.id || !record.summary) continue;
    deltas.set(String(record.user.id), calculatePvpEventScoreDelta(record.summary));
  }

  const primaryRecord = records.find((record) => record?.summary) || null;
  if (!primaryRecord?.summary) {
    return deltas;
  }

  const scoring = getPvpEventModeScoring(primaryRecord.summary.gameMode);
  const transferPerLoser = calculatePvpEventLossTransfer(scoring.loss, scoring.lossTransfer);
  if (!transferPerLoser) {
    return deltas;
  }

  const winners = records
    .filter((record) => record?.user?.id && record.summary?.playerWon)
    .sort((left, right) => String(left.user.id).localeCompare(String(right.user.id)));
  const losers = records.filter((record) => record?.user?.id && record.summary && !record.summary.playerWon);

  if (!winners.length || !losers.length) {
    return deltas;
  }

  const transferPool = transferPerLoser * losers.length;
  const baseShare = Math.floor(transferPool / winners.length);
  let remainder = transferPool % winners.length;

  for (const winner of winners) {
    const userId = String(winner.user.id);
    const extra = baseShare + (remainder > 0 ? 1 : 0);
    if (remainder > 0) {
      remainder -= 1;
    }
    deltas.set(userId, Math.trunc(Number(deltas.get(userId) || 0) + extra));
  }

  return deltas;
}

function getReplayEventSignupsForConfig(signupStore, eventConfig) {
  const eventSlug = normalizeSlug(eventConfig?.slug, DEFAULT_PVP_EVENT_SLUG);
  return Array.isArray(signupStore?.signups)
    ? signupStore.signups
        .map((entry) => summarizePvpEventSignup(entry))
        .filter((entry) => entry && entry.eventSlug === eventSlug)
    : [];
}

function getReplayEventSignupForUser(signupStore, eventConfig, user) {
  if (!user?.id) {
    return null;
  }
  return (
    getReplayEventSignupsForConfig(signupStore, eventConfig).find(
      (entry) => String(entry.user?.id || '') === String(user.id)
    ) || null
  );
}

function buildReplayEventLeaderboardAtTime(matchStore, signupStore, eventConfig, cutoffMs) {
  const result = {
    byUserId: new Map(),
    items: []
  };

  if (!isPvpEventConfigured(eventConfig) || !Number.isFinite(Number(cutoffMs))) {
    return result;
  }

  const startsAtMs = getDateMs(eventConfig.startsAt);
  const endsAtMs = getDateMs(eventConfig.endsAt);
  if (startsAtMs === null || endsAtMs === null || endsAtMs <= startsAtMs) {
    return result;
  }

  const signups = getReplayEventSignupsForConfig(signupStore, eventConfig);
  const signupMap = new Map(
    signups.map((entry) => [
      String(entry.user?.id || ''),
      {
        ...entry,
        signedUpAtMs: getDateMs(entry.signedUpAt)
      }
    ])
  );
  const stats = new Map();

  for (const group of groupPvpEventMatchRecords(matchStore?.matches || [])) {
    if (
      group.completedAtMs === null ||
      group.completedAtMs < startsAtMs ||
      group.completedAtMs > endsAtMs ||
      group.completedAtMs > cutoffMs
    ) {
      continue;
    }

    const scoreDeltas = buildPvpEventMatchScoreDeltas(group.records);
    for (const matchRecord of group.records) {
      const userId = String(matchRecord.user?.id || '');
      const signup = signupMap.get(userId);
      if (!signup || signup.signedUpAtMs === null || group.anchorMs === null || signup.signedUpAtMs > group.anchorMs) {
        continue;
      }

      if (!stats.has(userId)) {
        stats.set(userId, createEmptyPvpEventStats(matchRecord.user));
      }
      applyPvpEventMatchStats(stats.get(userId), matchRecord, {
        scoreDelta: scoreDeltas.get(userId) || 0
      });
    }
  }

  const items = finalizePvpEventLeaderboard(stats, { qualifiedOnly: false });
  for (const item of items) {
    result.byUserId.set(String(item.user?.id || ''), item);
  }
  result.items = items;
  return result;
}

function buildReplayEventPanel(matchStore, signupStore, eventConfig, matchRecords) {
  const normalizedRecords = matchRecords.map((record) => summarizeMatchRecord(record));
  const primaryRecord = normalizedRecords[0] || null;
  const scoreDeltas = buildPvpEventMatchScoreDeltas(normalizedRecords);
  const cutoffMs = Math.max(
    ...normalizedRecords.map((record) => getDateMs(record.completedAt || record.recordedAt) || 0),
    0
  );
  const eventEnabled = Boolean(eventConfig?.enabled);
  const eventConfigured = isPvpEventConfigured(eventConfig);
  const leaderboard = buildReplayEventLeaderboardAtTime(matchStore, signupStore, eventConfig, cutoffMs);
  const startsAtMs = getDateMs(eventConfig?.startsAt);
  const endsAtMs = getDateMs(eventConfig?.endsAt);

  const participants = normalizedRecords.map((record) => {
    const signup = getReplayEventSignupForUser(signupStore, eventConfig, record.user);
    const signupAtMs = getDateMs(signup?.signedUpAt);
    const matchStartedAtMs = getDateMs(record.startedAt || record.completedAt || record.recordedAt);
    const matchCompletedAtMs = getDateMs(record.completedAt || record.recordedAt);
    let counted = false;
    let reason = 'event_disabled';

    if (!eventEnabled) {
      reason = 'event_disabled';
    } else if (!eventConfigured) {
      reason = 'event_not_configured';
    } else if (getRewardPoolFamily(record.pool || record.summary?.rewardPool || record.summary?.matchType) !== 'pvp') {
      reason = 'not_pvp';
    } else if (
      matchCompletedAtMs === null ||
      startsAtMs === null ||
      endsAtMs === null ||
      matchCompletedAtMs < startsAtMs ||
      matchCompletedAtMs > endsAtMs
    ) {
      reason = 'outside_event_window';
    } else if (!signup) {
      reason = 'not_signed_up';
    } else if (signupAtMs === null || matchStartedAtMs === null || signupAtMs > matchStartedAtMs) {
      reason = 'signed_up_after_match';
    } else {
      counted = true;
      reason = 'counted';
    }

    const leaderboardEntry = leaderboard.byUserId.get(String(record.user?.id || '')) || null;

    return {
      user: record.user ? summarizeUser(record.user) : null,
      counted,
      reason,
      scoreDelta: counted ? Math.trunc(Number(scoreDeltas.get(String(record.user?.id || '')) || 0)) : 0,
      rankAfterMatch: leaderboardEntry?.rank || null,
      matchesPlayedAfterMatch: leaderboardEntry?.matchesPlayed || 0,
      matchesNeededAfterMatch: leaderboardEntry?.matchesNeeded || PVP_EVENT_SCORING_RULE.leaderboardMinMatches,
      qualifiedAfterMatch: Boolean(leaderboardEntry?.qualified),
      signedUpAt: signup?.signedUpAt || null
    };
  });

  return {
    enabled: eventEnabled,
    configured: eventConfigured,
    slug: normalizeSlug(eventConfig?.slug, DEFAULT_PVP_EVENT_SLUG),
    title: eventConfig?.title || DEFAULT_PVP_EVENT_TITLE,
    description: eventConfig?.description || '',
    startsAt: eventConfig?.startsAt || null,
    endsAt: eventConfig?.endsAt || null,
    counted: participants.some((item) => item.counted),
    participantCount: participants.length,
    countedParticipantCount: participants.filter((item) => item.counted).length,
    matchCompletedAt: primaryRecord?.completedAt || primaryRecord?.recordedAt || null,
    participants
  };
}

function buildPlayerReplayListPayload(matchStore, signupStore, eventConfig, user, options = {}) {
  const safeLimit = Math.min(50, Math.max(1, Math.floor(Number(options.limit || 12))));
  const groups = new Map();
  const currentUserId = String(user?.id || '');

  for (const entry of matchStore?.matches || []) {
    const record = summarizeMatchRecord(entry);
    if (
      !record.replay?.matchId ||
      getRewardPoolFamily(record.pool || record.summary?.rewardPool || record.summary?.matchType) !== 'pvp' ||
      String(record.user?.id || '') !== currentUserId
    ) {
      continue;
    }

    const key = String(record.replay.matchId);
    if (!groups.has(key)) {
      groups.set(key, {
        matchId: key,
        replay: record.replay,
        selfRecord: record,
        sortAt: record.completedAt || record.recordedAt || record.startedAt || '',
        records: findReplayMatchRecords(matchStore, key)
      });
    }
  }

  return [...groups.values()]
    .sort((left, right) => String(right.sortAt).localeCompare(String(left.sortAt)))
    .slice(0, safeLimit)
    .map((entry) => {
      const detail = buildReplayDetailPayload(entry.replay, entry.records);
      const eventPanel = buildReplayEventPanel(matchStore, signupStore, eventConfig, entry.records);
      const selfParticipant =
        eventPanel.participants.find((item) => String(item.user?.id || '') === currentUserId) || null;

      return {
        matchId: entry.matchId,
        replay: entry.replay,
        match: detail.match,
        participants: detail.players,
        selfSummary: entry.selfRecord.summary || null,
        eventSummary: {
          enabled: eventPanel.enabled,
          configured: eventPanel.configured,
          title: eventPanel.title,
          counted: selfParticipant?.counted || false,
          reason: selfParticipant?.reason || 'event_disabled',
          scoreDelta: selfParticipant?.scoreDelta || 0,
          rankAfterMatch: selfParticipant?.rankAfterMatch || null
        }
      };
    });
}

function summarizeMatchRecord(item) {
  return {
    id: item.id,
    ticketId: item.ticketId,
    pool: normalizeRewardPool(item.pool || item.summary?.rewardPool || item.summary?.matchType),
    startedAt: item.startedAt || null,
    completedAt: item.completedAt || null,
    recordedAt: item.recordedAt || null,
    user: item.user || null,
    summary: sanitizeAwardSummary(item.summary || null),
    rewardStatus: typeof item.rewardStatus === 'string' ? item.rewardStatus : 'not_eligible',
    rewardPreparedAt: item.rewardPreparedAt || null,
    claimedAt: item.claimedAt || null,
    assignedCode: item.assignedCode || null,
    replay: summarizeReplayRecord(item.replay || null)
  };
}

function summarizePvpEventSignup(item) {
  const source = item && typeof item === 'object' ? item : {};
  const user = normalizeStoredUser(source.user || source);
  if (!user) {
    return null;
  }

  return {
    eventSlug: normalizeSlug(source.eventSlug, DEFAULT_PVP_EVENT_SLUG),
    user,
    signedUpAt: normalizeOptionalIsoDateTime(source.signedUpAt, null),
    source: normalizeShortText(source.source, 'self_signup', 40)
  };
}

function createEmptyPvpEventStats(user) {
  return {
    user: summarizeUser(user),
    score: 0,
    matchesPlayed: 0,
    wins: 0,
    losses: 0,
    mvps: 0,
    kills: 0,
    deaths: 0,
    byMode: {
      duel: {
        matchesPlayed: 0,
        wins: 0,
        losses: 0
      },
      deathmatch: {
        matchesPlayed: 0,
        wins: 0,
        losses: 0
      }
    },
    lastMatchAt: null
  };
}

function applyPvpEventMatchStats(stats, matchRecord, options = {}) {
  if (!stats || !matchRecord?.summary || !matchRecord?.user) {
    return stats;
  }

  const summary = sanitizeAwardSummary(matchRecord.summary);
  const kills = Math.max(0, Math.floor(Number(summary.playerStats?.kills || 0)));
  const deaths = Math.max(0, Math.floor(Number(summary.playerStats?.deaths || 0)));
  const mode = normalizeGameMode(summary.gameMode, 'duel');
  stats.user = summarizeUser(matchRecord.user);
  stats.matchesPlayed += 1;
  stats.kills += kills;
  stats.deaths += deaths;
  stats.byMode[mode].matchesPlayed += 1;
  if (summary.playerWon) {
    stats.wins += 1;
    stats.byMode[mode].wins += 1;
  } else {
    stats.losses += 1;
    stats.byMode[mode].losses += 1;
  }
  if (summary.playerIsMvp) {
    stats.mvps += 1;
  }
  const scoreDelta = Number.isFinite(Number(options.scoreDelta))
    ? Math.trunc(Number(options.scoreDelta))
    : calculatePvpEventScoreDelta(summary);
  stats.score += scoreDelta;

  const matchAt = matchRecord.completedAt || matchRecord.recordedAt || null;
  if (matchAt && (!stats.lastMatchAt || String(matchAt).localeCompare(String(stats.lastMatchAt)) > 0)) {
    stats.lastMatchAt = matchAt;
  }

  return stats;
}

function comparePvpEventStats(left, right) {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  if (right.wins !== left.wins) {
    return right.wins - left.wins;
  }
  if (left.losses !== right.losses) {
    return left.losses - right.losses;
  }
  if (right.mvps !== left.mvps) {
    return right.mvps - left.mvps;
  }
  if (right.kills !== left.kills) {
    return right.kills - left.kills;
  }
  if (left.deaths !== right.deaths) {
    return left.deaths - right.deaths;
  }
  const matchAtComparison = String(right.lastMatchAt || '').localeCompare(String(left.lastMatchAt || ''));
  if (matchAtComparison !== 0) {
    return matchAtComparison;
  }
  return String(left.user?.id || '').localeCompare(String(right.user?.id || ''));
}

function summarizePvpEventLeaderboardEntry(item, rankOverride = null) {
  const source = item && typeof item === 'object' ? item : {};
  const user = normalizeStoredUser(source.user || source);
  if (!user) {
    return null;
  }

  const rankValue = rankOverride ?? source.rank;

  return {
    rank:
      rankValue === null || rankValue === undefined
        ? null
        : Math.max(1, Math.floor(Number(rankValue) || 1)),
    user,
    score: Math.trunc(Number(source.score || 0)),
    matchesPlayed: Math.max(0, Math.floor(Number(source.matchesPlayed || 0))),
    wins: Math.max(0, Math.floor(Number(source.wins || 0))),
    losses: Math.max(0, Math.floor(Number(source.losses || 0))),
    mvps: Math.max(0, Math.floor(Number(source.mvps || 0))),
    kills: Math.max(0, Math.floor(Number(source.kills || 0))),
    deaths: Math.max(0, Math.floor(Number(source.deaths || 0))),
    qualified:
      Math.max(0, Math.floor(Number(source.matchesPlayed || 0))) >= PVP_EVENT_SCORING_RULE.leaderboardMinMatches,
    matchesNeeded: Math.max(
      0,
      PVP_EVENT_SCORING_RULE.leaderboardMinMatches -
        Math.max(0, Math.floor(Number(source.matchesPlayed || 0)))
    ),
    byMode:
      source.byMode && typeof source.byMode === 'object'
        ? {
            duel: {
              matchesPlayed: Math.max(0, Math.floor(Number(source.byMode?.duel?.matchesPlayed || 0))),
              wins: Math.max(0, Math.floor(Number(source.byMode?.duel?.wins || 0))),
              losses: Math.max(0, Math.floor(Number(source.byMode?.duel?.losses || 0)))
            },
            deathmatch: {
              matchesPlayed: Math.max(0, Math.floor(Number(source.byMode?.deathmatch?.matchesPlayed || 0))),
              wins: Math.max(0, Math.floor(Number(source.byMode?.deathmatch?.wins || 0))),
              losses: Math.max(0, Math.floor(Number(source.byMode?.deathmatch?.losses || 0)))
            }
          }
        : {
            duel: { matchesPlayed: 0, wins: 0, losses: 0 },
            deathmatch: { matchesPlayed: 0, wins: 0, losses: 0 }
          },
    lastMatchAt: normalizeOptionalIsoDateTime(source.lastMatchAt, null)
  };
}

function finalizePvpEventLeaderboard(statsMap, options = {}) {
  const qualifiedOnly = options.qualifiedOnly !== false;
  const items = Array.from(statsMap.values())
    .map((item) => summarizePvpEventLeaderboardEntry(item))
    .filter(Boolean)
    .sort(comparePvpEventStats);

  const rankedItems = qualifiedOnly ? items.filter((item) => item.qualified) : items;

  return rankedItems.map((item, index) => ({
    ...item,
    rank: index + 1
  }));
}

function summarizePvpEventLeaderboardSnapshot(item) {
  const source = item && typeof item === 'object' ? item : {};
  const eventItems = Array.isArray(source.event?.items)
    ? source.event.items.map((entry) => summarizePvpEventLeaderboardEntry(entry)).filter(Boolean)
    : [];
  const eventParticipants = Array.isArray(source.event?.participants)
    ? source.event.participants.map((entry) => summarizePvpEventLeaderboardEntry(entry)).filter(Boolean)
    : [];
  const globalItems = Array.isArray(source.global?.items)
    ? source.global.items.map((entry) => summarizePvpEventLeaderboardEntry(entry)).filter(Boolean)
    : [];
  const globalParticipants = Array.isArray(source.global?.participants)
    ? source.global.participants.map((entry) => summarizePvpEventLeaderboardEntry(entry)).filter(Boolean)
    : [];

  return {
    eventKey: normalizeShortText(source.eventKey, '', 200),
    eventSlug: normalizeSlug(source.eventSlug, DEFAULT_PVP_EVENT_SLUG),
    sourceMatchCount: Math.max(0, Math.floor(Number(source.sourceMatchCount || 0))),
    updatedAt: normalizeOptionalIsoDateTime(source.updatedAt, null),
    event: {
      items: eventItems,
      participants: eventParticipants
    },
    global: {
      items: globalItems,
      participants: globalParticipants
    }
  };
}

function getPvpEventPhaseLabel(phase) {
  if (phase === 'upcoming') return '报名未开始';
  if (phase === 'signup') return '报名中';
  if (phase === 'live') return '进行中';
  if (phase === 'ended') return '已结束';
  if (phase === 'unconfigured') return '未配置';
  return '未开启';
}

function buildPvpEventInfo(config, nowIso, signupCount, signup = null, user = null) {
  const phase = getPvpEventPhase(config, nowIso);

  return {
    enabled: Boolean(config?.enabled),
    configured: isPvpEventConfigured(config),
    slug: config?.slug || DEFAULT_PVP_EVENT_SLUG,
    title: config?.title || DEFAULT_PVP_EVENT_TITLE,
    description: config?.description || '',
    signupStartsAt: config?.signupStartsAt || null,
    startsAt: config?.startsAt || null,
    endsAt: config?.endsAt || null,
    phase,
    phaseLabel: getPvpEventPhaseLabel(phase),
    scoring: getPvpEventScoringRule(),
    signupCount: Math.max(0, Math.floor(Number(signupCount || 0))),
    signedUp: Boolean(signup),
    signedUpAt: signup?.signedUpAt || null,
    canSignUp: Boolean(user && canSignUpForPvpEventPhase(phase) && !signup),
    requiresLogin: !user
  };
}

function buildPvpEventCurrentUserSummary(user, leaderboardEntry, { signedUp = false, signedUpAt = null } = {}) {
  if (!user) {
    return null;
  }

  if (leaderboardEntry) {
    return {
      ...leaderboardEntry,
      signedUp,
      signedUpAt
    };
  }

  return {
    rank: null,
    user: summarizeUser(user),
    score: 0,
    matchesPlayed: 0,
    wins: 0,
    losses: 0,
    mvps: 0,
    kills: 0,
    deaths: 0,
    qualified: false,
    matchesNeeded: PVP_EVENT_SCORING_RULE.leaderboardMinMatches,
    byMode: {
      duel: { matchesPlayed: 0, wins: 0, losses: 0 },
      deathmatch: { matchesPlayed: 0, wins: 0, losses: 0 }
    },
    lastMatchAt: null,
    signedUp,
    signedUpAt
  };
}

function resolveAwardBlockReason(summary) {
  if (!summary || typeof summary !== 'object') return null;
  const rewardPool = getRewardPoolFamily(summary.rewardPool || summary.matchType || summary.codePool || summary.gameMode);

  if (rewardPool === 'pvp') {
    return null;
  }

  if (
    Number.isFinite(Number(summary.matchDurationSeconds)) &&
    Number(summary.matchDurationSeconds) < MIN_REWARDABLE_MATCH_SECONDS
  ) {
    return 'match_too_short';
  }

  const kills = Number(summary.playerStats?.kills || 0);
  if (summary.matchDurationSeconds === 105 && kills === 0) {
    return 'timeout_zero_kill';
  }

  return null;
}

function summarizePendingAward(award) {
  if (!award) return null;

  return {
    awardId: award.awardId,
    ticketId: award.ticketId,
    preparedAt: award.preparedAt,
    summary: award.summary
  };
}

function createPendingAwardFromMatchRecord(matchRecord) {
  if (!matchRecord?.ticketId || !matchRecord?.summary) {
    return null;
  }

  return {
    awardId: matchRecord.id || randomUUID(),
    ticketId: matchRecord.ticketId,
    preparedAt: matchRecord.rewardPreparedAt || matchRecord.completedAt || matchRecord.recordedAt || null,
    summary: matchRecord.summary
  };
}

function getServerObservedDurationSeconds(startedAt, completedAt = new Date().toISOString()) {
  const startedMs = Date.parse(String(startedAt || ''));
  const completedMs = Date.parse(String(completedAt || ''));

  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs)) {
    return null;
  }

  return Math.max(0, Math.round(((completedMs - startedMs) / 1000) * 100) / 100);
}

function sanitizeAwardSummary(input) {
  const source = input && typeof input === 'object' ? input : {};
  const codePool = normalizeRewardPool(source.codePool || '', '');
  const rewardPool = getRewardPoolFamily(
    source.rewardPool || source.matchType || source.codePool || source.gameMode,
    DEFAULT_REWARD_POOL
  );
  const explicitBlockReason = normalizeManagedAwardBlockReason(source.awardBlockedReason);
  const summary = {
    matchType: rewardPool,
    rewardPool,
    codePool: codePool || (rewardPool === 'pvp' ? getCodePoolForGameMode(source.gameMode, LEGACY_PVP_CODE_POOL) : 'pve'),
    gameMode: normalizeGameMode(
      source.gameMode,
      typeof source.gameMode === 'string' ? source.gameMode.slice(0, 40) : null
    ),
    difficulty: normalizeDifficulty(
      source.difficulty,
      typeof source.difficulty === 'string' ? source.difficulty.slice(0, 40) : null
    ),
    winnerTeam: typeof source.winnerTeam === 'string' ? source.winnerTeam.slice(0, 20) : null,
    playerTeam: typeof source.playerTeam === 'string' ? source.playerTeam.slice(0, 20) : null,
    playerWon: Boolean(source.playerWon),
    playerIsMvp: Boolean(source.playerIsMvp),
    eligibleForAward: Boolean(source.eligibleForAward),
    mvpTeam: typeof source.mvpTeam === 'string' ? source.mvpTeam.slice(0, 20) : null,
    mvpName: typeof source.mvpName === 'string' ? source.mvpName.slice(0, 80) : null,
    playerName: typeof source.playerName === 'string' ? source.playerName.slice(0, 80) : null,
    awardBlockedReason: explicitBlockReason,
    matchDurationSeconds: Number.isFinite(Number(source.matchDurationSeconds))
      ? Math.max(0, Math.round(Number(source.matchDurationSeconds) * 100) / 100)
      : null,
    playerStats:
      source.playerStats && typeof source.playerStats === 'object'
        ? {
            kills: Number.isFinite(Number(source.playerStats.kills)) ? Number(source.playerStats.kills) : 0,
            deaths: Number.isFinite(Number(source.playerStats.deaths)) ? Number(source.playerStats.deaths) : 0,
            damageDealt: Number.isFinite(Number(source.playerStats.damageDealt))
              ? Math.round(Number(source.playerStats.damageDealt) * 100) / 100
              : 0
          }
        : null
  };

  summary.eligibleForAward = Boolean(
    summary.playerWon &&
      summary.playerIsMvp &&
      summary.winnerTeam &&
      summary.playerTeam &&
      summary.winnerTeam === summary.playerTeam
  );

  summary.awardBlockedReason = resolveAwardBlockReason(summary) || explicitBlockReason;
  if (summary.awardBlockedReason) {
    summary.eligibleForAward = false;
  }

  return summary;
}

function normalizeCodes(payload) {
  const values = [];

  if (typeof payload.code === 'string') {
    values.push(payload.code);
  }

  if (Array.isArray(payload.codes)) {
    for (const item of payload.codes) {
      if (typeof item === 'string') {
        values.push(item);
      }
    }
  }

  if (typeof payload.bulkText === 'string') {
    values.push(...payload.bulkText.split(/\r?\n/u));
  }

  const seen = new Set();
  const normalized = [];

  for (const item of values) {
    const code = item.trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    normalized.push(code);
  }

  return normalized;
}

function safeReturnTo(value) {
  if (typeof value !== 'string') return '/';
  if (!value.startsWith('/')) return '/';
  if (value.startsWith('//')) return '/';
  return value;
}

function isSecureRequest(req, oauthConfig) {
  const baseUrl = getRequestBaseUrl(req, oauthConfig.baseUrl);
  return baseUrl.startsWith('https://');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function createErrorPage(title, message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: "Segoe UI", sans-serif;
    }

    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at top, rgba(108, 171, 255, 0.25), transparent 30%),
        linear-gradient(180deg, #0f1520, #070b12);
      color: #f5f7ff;
    }

    main {
      width: min(520px, calc(100vw - 32px));
      padding: 28px;
      border-radius: 20px;
      background: rgba(10, 14, 22, 0.84);
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.28);
    }

    a {
      color: #7edcff;
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <p><a href="/">Return to the game</a></p>
  </main>
</body>
</html>`;
}

export function createApp(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const dataDir = path.resolve(options.dataDir || path.join(rootDir, 'data'));
  const sessionTtlMs = options.sessionTtlMs || DEFAULT_SESSION_TTL_MS;
  const oauthStateTtlMs = options.oauthStateTtlMs || DEFAULT_STATE_TTL_MS;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const getNowMs = typeof options.now === 'function' ? options.now : () => Date.now();
  const getNowIso = () => new Date(getNowMs()).toISOString();
  const host = options.host || process.env.HOST || '127.0.0.1';
  const port = Number(options.port ?? process.env.PORT ?? 4173);
  const pvpSweepIntervalMs = Math.max(250, Number(options.pvpSweepIntervalMs || 15_000));
  const allowClientReportedAwards =
    options.allowClientReportedAwards ??
    parseBooleanFlag(process.env.ALLOW_CLIENT_REPORTED_AWARDS, false);
  const awardSecurity = buildAwardSecurityState(allowClientReportedAwards);

  const oauthConfig = {
    authorizeEndpoint:
      options.linuxDo?.authorizeEndpoint ||
      process.env.LINUX_DO_AUTHORIZE_URL ||
      OAUTH_AUTHORIZE_ENDPOINT,
    tokenEndpoint:
      options.linuxDo?.tokenEndpoint ||
      process.env.LINUX_DO_TOKEN_URL ||
      OAUTH_TOKEN_ENDPOINT,
    userEndpoint:
      options.linuxDo?.userEndpoint ||
      process.env.LINUX_DO_USER_URL ||
      OAUTH_USER_ENDPOINT,
    clientId: options.linuxDo?.clientId || process.env.LINUX_DO_CLIENT_ID || '',
    clientSecret: options.linuxDo?.clientSecret || process.env.LINUX_DO_CLIENT_SECRET || '',
    scope: options.linuxDo?.scope || process.env.LINUX_DO_SCOPE || 'read',
    baseUrl: options.linuxDo?.baseUrl || process.env.BASE_URL || '',
    callbackUrl: options.linuxDo?.callbackUrl || process.env.LINUX_DO_CALLBACK_URL || ''
  };
  const pvpEdgeConfig = {
    baseUrl: cleanBaseUrl(options.pvpEdge?.baseUrl || process.env.PVP_EDGE_BASE_URL || ''),
    sharedSecret: String(options.pvpEdge?.sharedSecret || process.env.PVP_EDGE_SHARED_SECRET || ''),
    tokenTtlMs:
      Math.max(
        60,
        normalizeNonNegativeInteger(
          options.pvpEdge?.tokenTtlSeconds ?? process.env.PVP_EDGE_TOKEN_TTL_SECONDS,
          12 * 60 * 60
        )
      ) * 1000,
    allowedOrigins: normalizeOrigins(
      options.pvpEdge?.allowedOrigins ||
        process.env.PVP_EDGE_ALLOWED_ORIGINS ||
        oauthConfig.baseUrl ||
        process.env.BASE_URL ||
        ''
    )
  };

  const sessions = new Map();
  const loginStates = new Map();
  const cdkFile = path.join(dataDir, 'cdks.json');
  const matchesFile = path.join(dataDir, 'matches.json');
  const appConfigFile = path.join(dataDir, 'app-config.json');
  const pvpEventSignupsFile = path.join(dataDir, 'pvp-event-signups.json');
  const pvpEventLeaderboardFile = path.join(dataDir, 'pvp-event-leaderboard.json');
  const pvpReplaysDir = path.join(dataDir, 'pvp-replays');
  let pvpSweepTimer = null;

  async function ensureDataFiles() {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(pvpReplaysDir, { recursive: true });
    await ensureJsonFile(appConfigFile, {
      adminUsernames: [],
      adminUserIds: [],
      rewardPolicy: normalizeRewardPolicyConfig(),
      pvp: normalizePvpConfig(),
      pvpEvent: normalizePvpEventConfig()
    });
    await ensureJsonFile(cdkFile, {
      version: 2,
      cdks: []
    });
    await ensureJsonFile(matchesFile, {
      version: 2,
      matches: []
    });
    await ensureJsonFile(pvpEventSignupsFile, {
      version: 1,
      signups: []
    });
    await ensureJsonFile(pvpEventLeaderboardFile, {
      version: 1,
      snapshot: null
    });
  }

  async function readStoredAppConfig() {
    const data = await readJsonFile(appConfigFile, {
      adminUsernames: [],
      adminUserIds: [],
      rewardPolicy: normalizeRewardPolicyConfig(),
      pvp: normalizePvpConfig(),
      pvpEvent: normalizePvpEventConfig()
    });

    return {
      adminUsernames: Array.isArray(data.adminUsernames) ? data.adminUsernames.map(String) : [],
      adminUserIds: Array.isArray(data.adminUserIds) ? data.adminUserIds.map(String) : [],
      rewardPolicy: normalizeRewardPolicyConfig(data.rewardPolicy),
      pvp: normalizePvpConfig(data.pvp),
      pvpEvent: normalizePvpEventConfig(data.pvpEvent)
    };
  }

  async function writeStoredAppConfig(config) {
    const source = config && typeof config === 'object' ? config : {};

    await writeJsonFile(appConfigFile, {
      adminUsernames: Array.isArray(source.adminUsernames)
        ? [...new Set(source.adminUsernames.map((item) => String(item).trim()).filter(Boolean))]
        : [],
      adminUserIds: Array.isArray(source.adminUserIds)
        ? [...new Set(source.adminUserIds.map((item) => String(item).trim()).filter(Boolean))]
        : [],
      rewardPolicy: normalizeRewardPolicyConfig(source.rewardPolicy),
      pvp: normalizePvpConfig(source.pvp),
      pvpEvent: normalizePvpEventConfig(source.pvpEvent)
    });
  }

  function readRewardPolicyOverrideSources() {
    const optionRewardPolicy = options.rewardPolicy && typeof options.rewardPolicy === 'object' ? options.rewardPolicy : {};
    const optionPve =
      optionRewardPolicy.dailyLimits && typeof optionRewardPolicy.dailyLimits.pve === 'object'
        ? optionRewardPolicy.dailyLimits.pve
        : {};
    const optionPvp =
      optionRewardPolicy.dailyLimits && typeof optionRewardPolicy.dailyLimits.pvp === 'object'
        ? optionRewardPolicy.dailyLimits.pvp
        : {};
    const getSource = (optionValue, envName) => {
      if (optionValue !== undefined && optionValue !== null) {
        return 'runtime';
      }

      const envValue = process.env[envName];
      if (envValue !== undefined && envValue !== null && String(envValue) !== '') {
        return 'env';
      }

      return null;
    };

    const sources = {
      timeZone: getSource(optionRewardPolicy.timeZone, 'REWARD_LIMIT_TIME_ZONE'),
      dailyLimits: {
        pve: {
          novice: getSource(optionPve.novice, 'REWARD_LIMIT_PVE_NOVICE'),
          easy: getSource(optionPve.easy, 'REWARD_LIMIT_PVE_EASY'),
          normal: getSource(optionPve.normal, 'REWARD_LIMIT_PVE_NORMAL'),
          hard: getSource(optionPve.hard, 'REWARD_LIMIT_PVE_HARD')
        },
        pvp: {
          default: getSource(optionPvp.default, 'REWARD_LIMIT_PVP_DEFAULT')
        }
      }
    };

    return {
      hasOverrides: Boolean(
        sources.timeZone ||
          sources.dailyLimits.pve.novice ||
          sources.dailyLimits.pve.easy ||
          sources.dailyLimits.pve.normal ||
          sources.dailyLimits.pve.hard ||
          sources.dailyLimits.pvp.default
      ),
      sources
    };
  }

  function normalizeRewardPolicyInput(input) {
    const source =
      input && typeof input === 'object' && input.rewardPolicy && typeof input.rewardPolicy === 'object'
        ? input.rewardPolicy
        : input && typeof input === 'object'
          ? input
          : {};
    const dailyLimits =
      source.dailyLimits && typeof source.dailyLimits === 'object' ? source.dailyLimits : {};
    const pve = source.pve && typeof source.pve === 'object' ? source.pve : dailyLimits.pve || {};
    const pvp = source.pvp && typeof source.pvp === 'object' ? source.pvp : dailyLimits.pvp || {};

    return normalizeRewardPolicyConfig({
      timeZone: source.timeZone,
      dailyLimits: {
        pve: {
          novice: pve.novice ?? source.pveNovice,
          easy: pve.easy ?? source.pveEasy,
          normal: pve.normal ?? source.pveNormal,
          hard: pve.hard ?? source.pveHard
        },
        pvp: {
          default: pvp.default ?? source.pvpDefault
        }
      }
    });
  }

  function normalizePvpConfigInput(input) {
    const source =
      input && typeof input === 'object' && input.pvp && typeof input.pvp === 'object'
        ? input.pvp
        : input && typeof input === 'object'
          ? input
          : {};
    const allowModes = source.allowModes && typeof source.allowModes === 'object' ? source.allowModes : {};
    const replay = source.replay && typeof source.replay === 'object' ? source.replay : {};
    const replayModes = replay.modes && typeof replay.modes === 'object' ? replay.modes : {};

    return normalizePvpConfig({
      enabled: source.enabled,
      matchmakingEnabled: source.matchmakingEnabled,
      rewardEnabled: source.rewardEnabled,
      maxActiveRooms: source.maxActiveRooms,
      maxRoomIdleSeconds: source.maxRoomIdleSeconds,
      allowModes: {
        duel: allowModes.duel ?? source.allowDuel,
        deathmatch: allowModes.deathmatch ?? source.allowDeathmatch
      },
      replay: {
        enabled: replay.enabled ?? source.replayEnabled,
        maxStoredMatches: replay.maxStoredMatches ?? source.replayMaxStoredMatches,
        compressOnComplete: replay.compressOnComplete ?? source.replayCompressOnComplete,
        modes: {
          duel: replayModes.duel ?? source.replayAllowDuel,
          deathmatch: replayModes.deathmatch ?? source.replayAllowDeathmatch
        }
      }
    });
  }

  function normalizePvpEventConfigInput(input) {
    const source =
      input && typeof input === 'object' && input.pvpEvent && typeof input.pvpEvent === 'object'
        ? input.pvpEvent
        : input && typeof input === 'object'
          ? input
          : {};

    return normalizePvpEventConfig({
      enabled: source.enabled,
      slug: source.slug,
      title: source.title,
      description: source.description,
      signupStartsAt: source.signupStartsAt,
      startsAt: source.startsAt,
      endsAt: source.endsAt
    });
  }

  async function readAppConfig() {
    const storedConfig = await readStoredAppConfig();
    const fileRewardPolicy = storedConfig.rewardPolicy;

    const optionPvpConfig =
      options.pvpConfig && typeof options.pvpConfig === 'object' ? options.pvpConfig : {};

    return {
      adminUsernames: [
        ...new Set([
          ...splitCsv(process.env.ADMIN_LINUX_DO_USERNAMES),
          ...storedConfig.adminUsernames
        ])
      ],
      adminUserIds: [
        ...new Set([
          ...splitCsv(process.env.ADMIN_LINUX_DO_USER_IDS),
          ...storedConfig.adminUserIds
        ])
      ],
      rewardPolicy: normalizeRewardPolicyConfig({
        timeZone:
          options.rewardPolicy?.timeZone ??
          process.env.REWARD_LIMIT_TIME_ZONE ??
          fileRewardPolicy.timeZone,
        dailyLimits: {
          pve: {
            novice:
              options.rewardPolicy?.dailyLimits?.pve?.novice ??
              process.env.REWARD_LIMIT_PVE_NOVICE ??
              fileRewardPolicy.dailyLimits?.pve?.novice,
            easy:
              options.rewardPolicy?.dailyLimits?.pve?.easy ??
              process.env.REWARD_LIMIT_PVE_EASY ??
              fileRewardPolicy.dailyLimits?.pve?.easy,
            normal:
              options.rewardPolicy?.dailyLimits?.pve?.normal ??
              process.env.REWARD_LIMIT_PVE_NORMAL ??
              fileRewardPolicy.dailyLimits?.pve?.normal,
            hard:
              options.rewardPolicy?.dailyLimits?.pve?.hard ??
              process.env.REWARD_LIMIT_PVE_HARD ??
              fileRewardPolicy.dailyLimits?.pve?.hard
          },
          pvp: {
            default:
              options.rewardPolicy?.dailyLimits?.pvp?.default ??
              process.env.REWARD_LIMIT_PVP_DEFAULT ??
              fileRewardPolicy.dailyLimits?.pvp?.default
          }
        }
      }),
      pvp: normalizePvpConfig({
        ...storedConfig.pvp,
        ...optionPvpConfig,
        allowModes: {
          ...(storedConfig.pvp?.allowModes || {}),
          ...(optionPvpConfig.allowModes && typeof optionPvpConfig.allowModes === 'object'
            ? optionPvpConfig.allowModes
            : {})
        },
        replay: {
          ...(storedConfig.pvp?.replay || {}),
          ...(optionPvpConfig.replay && typeof optionPvpConfig.replay === 'object'
            ? optionPvpConfig.replay
            : {}),
          modes: {
            ...(storedConfig.pvp?.replay?.modes || {}),
            ...(optionPvpConfig.replay?.modes && typeof optionPvpConfig.replay.modes === 'object'
              ? optionPvpConfig.replay.modes
              : {})
          }
        }
      }),
      pvpEvent: normalizePvpEventConfig(storedConfig.pvpEvent)
    };
  }

  function getReplayIdentityKey(replay) {
    if (!replay || typeof replay !== 'object') return null;
    if (replay.matchId) return `match:${replay.matchId}`;
    if (replay.relativePath) return `file:${replay.relativePath}`;
    return null;
  }

  async function pruneReplayArtifacts(matchStore, maxStoredMatches = 0) {
    const safeLimit = Math.max(0, Math.floor(Number(maxStoredMatches) || 0));
    if (safeLimit <= 0) {
      return false;
    }
    const replayGroups = new Map();

    for (const match of Array.isArray(matchStore?.matches) ? matchStore.matches : []) {
      const replay = summarizeReplayRecord(match.replay || null);
      const replayKey = getReplayIdentityKey(replay);
      if (!replay?.available || !replayKey || !replay.relativePath) {
        continue;
      }

      const recordedAt = String(
        match.completedAt || match.recordedAt || replay.createdAt || match.startedAt || ''
      );
      const existing = replayGroups.get(replayKey);
      if (!existing) {
        replayGroups.set(replayKey, {
          replay,
          recordedAt,
          matches: [match]
        });
        continue;
      }

      existing.matches.push(match);
      if (recordedAt.localeCompare(existing.recordedAt) > 0) {
        existing.recordedAt = recordedAt;
      }
    }

    const groups = [...replayGroups.values()].sort((left, right) =>
      right.recordedAt.localeCompare(left.recordedAt)
    );
    const staleGroups = groups.slice(safeLimit);
    let mutated = false;

    for (const group of staleGroups) {
      const absolutePath = toReplayAbsolutePath(dataDir, group.replay.relativePath);
      try {
        await fs.unlink(absolutePath);
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          continue;
        }
      }

      for (const match of group.matches) {
        match.replay = {
          ...group.replay,
          available: false,
          status: 'pruned',
          error: 'replay_pruned'
        };
      }
      mutated = true;
    }

    return mutated;
  }

  async function createPvpReplayRecorder(context = {}) {
    const replayConfig = normalizePvpConfig(context.config).replay;
    const mode = String(context.mode || '');

    if (!replayConfig?.enabled || !replayConfig?.modes?.[mode]) {
      return null;
    }

    const rawRelativePath = buildReplayRelativePath(
      context.matchId,
      mode,
      context.startedAt,
      false
    );
    const rawAbsolutePath = toReplayAbsolutePath(dataDir, rawRelativePath);
    await fs.mkdir(path.dirname(rawAbsolutePath), { recursive: true });

    const stream = createWriteStream(rawAbsolutePath, {
      flags: 'a'
    });
    let writeChain = Promise.resolve();
    let writeError = null;
    let finalized = false;
    const counters = {
      snapshotCount: 0,
      eventCount: 0
    };

    const enqueueRecord = (type, payload) => {
      if (finalized) return;
      const line = `${JSON.stringify({ type, payload })}\n`;
      writeChain = writeChain
        .then(() => streamWriteText(stream, line))
        .catch((error) => {
          writeError = error;
        });
    };

    return {
      recordMeta(payload) {
        enqueueRecord('meta', payload);
      },
      recordSnapshot(payload) {
        counters.snapshotCount += 1;
        enqueueRecord('snapshot', payload);
      },
      recordEvent(payload) {
        counters.eventCount += 1;
        enqueueRecord('event', payload);
      },
      async finalize(payload) {
        if (finalized) {
          return null;
        }
        enqueueRecord('result', payload);
        finalized = true;
        await writeChain;

        try {
          await endWritableStream(stream);
        } catch (error) {
          writeError = writeError || error;
        }

        let relativePath = rawRelativePath;
        let absolutePath = rawAbsolutePath;
        let compressed = false;
        let format = 'ndjson';
        let compressionError = null;

        if (!writeError && replayConfig.compressOnComplete) {
          const compressedRelativePath = buildReplayRelativePath(
            context.matchId,
            mode,
            context.startedAt,
            true
          );
          const compressedAbsolutePath = toReplayAbsolutePath(dataDir, compressedRelativePath);
          try {
            await fs.mkdir(path.dirname(compressedAbsolutePath), { recursive: true });
            await pipeline(
              createReadStream(rawAbsolutePath),
              createGzip({ level: 6 }),
              createWriteStream(compressedAbsolutePath)
            );
            await fs.unlink(rawAbsolutePath).catch(() => {});
            relativePath = compressedRelativePath;
            absolutePath = compressedAbsolutePath;
            compressed = true;
            format = 'ndjson.gz';
          } catch (error) {
            compressionError = error;
          }
        }

        let sizeBytes = null;
        try {
          const stat = await fs.stat(absolutePath);
          sizeBytes = stat.size;
        } catch {}

        return summarizeReplayRecord({
          available: !writeError && sizeBytes !== null,
          status: writeError ? 'failed' : 'ready',
          matchId: context.matchId,
          mode,
          mapId: context.mapId || null,
          format,
          relativePath,
          fileName: path.posix.basename(relativePath),
          compressed,
          sizeBytes,
          snapshotCount: counters.snapshotCount,
          eventCount: counters.eventCount,
          createdAt: getNowIso(),
          error: writeError?.message || compressionError?.message || null
        });
      }
    };
  }

  const pvpService = createPvpService({
    getNowMs,
    getNowIso,
    async getConfig() {
      const appConfig = await readAppConfig();
      return appConfig.pvp;
    },
    async createReplayRecorder(context) {
      return createPvpReplayRecorder(context);
    },
    async onMatchFinished(payload) {
      await recordPvpMatchResult(payload);
    }
  });

  async function readCdkStore() {
    const store = await readJsonFile(cdkFile, {
      version: 2,
      cdks: []
    });

    if (!Array.isArray(store.cdks)) {
      return { version: 2, cdks: [] };
    }

    return {
      version: Math.max(Number(store.version) || 1, 2),
      cdks: store.cdks.map((entry) => ({
        ...entry,
        pool: normalizeRewardPool(
          entry?.pool || entry?.claimContext?.summary?.rewardPool || entry?.claimContext?.summary?.matchType
        ),
        claimContext: entry?.claimContext
          ? {
              ...entry.claimContext,
              summary: entry.claimContext.summary ? sanitizeAwardSummary(entry.claimContext.summary) : null
            }
          : null
      }))
    };
  }

  async function writeCdkStore(store) {
    await writeJsonFile(cdkFile, store);
  }

  async function readMatchStore() {
    const store = await readJsonFile(matchesFile, {
      version: 2,
      matches: []
    });

    if (!Array.isArray(store.matches)) {
      return { version: 2, matches: [] };
    }

    return {
      version: Math.max(Number(store.version) || 1, 2),
      matches: store.matches.map((entry) => summarizeMatchRecord(entry))
    };
  }

  async function writeMatchStore(store) {
    await writeJsonFile(matchesFile, store);
  }

  async function readPvpEventSignupStore() {
    const store = await readJsonFile(pvpEventSignupsFile, {
      version: 1,
      signups: []
    });

    return {
      version: 1,
      signups: Array.isArray(store.signups)
        ? store.signups.map((entry) => summarizePvpEventSignup(entry)).filter(Boolean)
        : []
    };
  }

  async function writePvpEventSignupStore(store) {
    await writeJsonFile(pvpEventSignupsFile, {
      version: 1,
      signups: Array.isArray(store?.signups) ? store.signups.map((entry) => summarizePvpEventSignup(entry)).filter(Boolean) : []
    });
  }

  function getPvpEventSignupsForConfig(store, eventConfig) {
    const eventSlug = normalizeSlug(eventConfig?.slug, DEFAULT_PVP_EVENT_SLUG);
    return (Array.isArray(store?.signups) ? store.signups : [])
      .filter((entry) => entry?.eventSlug === eventSlug)
      .sort((left, right) => String(left.signedUpAt || '').localeCompare(String(right.signedUpAt || '')));
  }

  function getPvpEventSignupForUser(store, eventConfig, user) {
    if (!user?.id) {
      return null;
    }

    return (
      getPvpEventSignupsForConfig(store, eventConfig).find(
        (entry) => String(entry.user?.id || '') === String(user.id)
      ) || null
    );
  }

  async function readPvpEventLeaderboardStore() {
    const store = await readJsonFile(pvpEventLeaderboardFile, {
      version: 1,
      snapshot: null
    });

    return {
      version: 1,
      snapshot: store.snapshot ? summarizePvpEventLeaderboardSnapshot(store.snapshot) : null
    };
  }

  async function writePvpEventLeaderboardStore(store) {
    await writeJsonFile(pvpEventLeaderboardFile, {
      version: 1,
      snapshot: store?.snapshot ? summarizePvpEventLeaderboardSnapshot(store.snapshot) : null
    });
  }

  function buildPvpEventLeaderboardSnapshot(matchStore, signupStore, eventConfig, nowIso = getNowIso()) {
    const snapshot = {
      eventKey: getPvpEventKey(eventConfig),
      eventSlug: normalizeSlug(eventConfig?.slug, DEFAULT_PVP_EVENT_SLUG),
      sourceMatchCount: Math.max(0, Math.floor(Number(matchStore?.matches?.length || 0))),
      updatedAt: nowIso,
      event: {
        items: [],
        participants: []
      },
      global: {
        items: [],
        participants: []
      }
    };

    if (!isPvpEventConfigured(eventConfig)) {
      return snapshot;
    }

    const startsAtMs = getDateMs(eventConfig.startsAt);
    const endsAtMs = getDateMs(eventConfig.endsAt);
    if (startsAtMs === null || endsAtMs === null || endsAtMs <= startsAtMs) {
      return snapshot;
    }

    const signups = getPvpEventSignupsForConfig(signupStore, eventConfig);
    const signupMap = new Map(
      signups.map((entry) => [
        String(entry.user?.id || ''),
        {
          ...entry,
          signedUpAtMs: getDateMs(entry.signedUpAt)
        }
      ])
    );
    const eventStats = new Map();
    const globalStats = new Map();

    for (const group of groupPvpEventMatchRecords(matchStore?.matches || [])) {
      if (group.completedAtMs === null || group.completedAtMs < startsAtMs || group.completedAtMs > endsAtMs) {
        continue;
      }

      const scoreDeltas = buildPvpEventMatchScoreDeltas(group.records);
      for (const matchRecord of group.records) {
        const userId = String(matchRecord.user?.id || '');
        if (!userId) {
          continue;
        }

        if (!globalStats.has(userId)) {
          globalStats.set(userId, createEmptyPvpEventStats(matchRecord.user));
        }
        applyPvpEventMatchStats(globalStats.get(userId), matchRecord, {
          scoreDelta: scoreDeltas.get(userId) || 0
        });

        const signup = signupMap.get(userId);
        if (!signup || signup.signedUpAtMs === null || group.anchorMs === null || signup.signedUpAtMs > group.anchorMs) {
          continue;
        }

        if (!eventStats.has(userId)) {
          eventStats.set(userId, createEmptyPvpEventStats(matchRecord.user));
        }
        applyPvpEventMatchStats(eventStats.get(userId), matchRecord, {
          scoreDelta: scoreDeltas.get(userId) || 0
        });
      }
    }

    snapshot.event.participants = finalizePvpEventLeaderboard(eventStats, { qualifiedOnly: false });
    snapshot.event.items = finalizePvpEventLeaderboard(eventStats, { qualifiedOnly: true });
    snapshot.global.participants = finalizePvpEventLeaderboard(globalStats, { qualifiedOnly: false });
    snapshot.global.items = finalizePvpEventLeaderboard(globalStats, { qualifiedOnly: true });
    return snapshot;
  }

  async function ensurePvpEventLeaderboardSnapshot(eventConfig, options = {}) {
    const matchStore = options.matchStore || (await readMatchStore());
    const signupStore = options.signupStore || (await readPvpEventSignupStore());
    const leaderboardStore = await readPvpEventLeaderboardStore();
    const eventKey = getPvpEventKey(eventConfig);

    if (
      leaderboardStore.snapshot &&
      leaderboardStore.snapshot.eventKey === eventKey &&
      leaderboardStore.snapshot.sourceMatchCount === Math.max(0, Math.floor(Number(matchStore?.matches?.length || 0)))
    ) {
      return leaderboardStore.snapshot;
    }

    const snapshot = buildPvpEventLeaderboardSnapshot(matchStore, signupStore, eventConfig);
    await writePvpEventLeaderboardStore({
      version: 1,
      snapshot
    });
    return snapshot;
  }

  function buildPvpEventResponse({ eventConfig, signupStore, snapshot, user, nowIso = getNowIso() }) {
    const signups = getPvpEventSignupsForConfig(signupStore, eventConfig);
    const signup = getPvpEventSignupForUser(signupStore, eventConfig, user);
    const eventItems = Array.isArray(snapshot?.event?.items) ? snapshot.event.items : [];
    const eventParticipants = Array.isArray(snapshot?.event?.participants) ? snapshot.event.participants : [];
    const globalItems = Array.isArray(snapshot?.global?.items) ? snapshot.global.items : [];
    const globalParticipants = Array.isArray(snapshot?.global?.participants) ? snapshot.global.participants : [];
    const eventEntry = user
      ? eventParticipants.find((entry) => String(entry.user?.id || '') === String(user.id)) || null
      : null;
    const globalEntry = user
      ? globalParticipants.find((entry) => String(entry.user?.id || '') === String(user.id)) || null
      : null;

    return {
      serverTime: nowIso,
      event: {
        ...buildPvpEventInfo(eventConfig, nowIso, signups.length, signup, user),
        snapshotUpdatedAt: snapshot?.updatedAt || null
      },
      leaderboards: {
        event: eventItems.slice(0, 20),
        global: globalItems.slice(0, 20)
      },
      currentUser: user
        ? {
            authenticated: true,
            signedUp: Boolean(signup),
            signedUpAt: signup?.signedUpAt || null,
            event:
              signup || eventEntry
                ? buildPvpEventCurrentUserSummary(user, eventEntry, {
                    signedUp: Boolean(signup),
                    signedUpAt: signup?.signedUpAt || null
                  })
                : null,
            global: buildPvpEventCurrentUserSummary(user, globalEntry, {
              signedUp: Boolean(signup),
              signedUpAt: signup?.signedUpAt || null
            })
          }
        : {
            authenticated: false,
            signedUp: false,
            signedUpAt: null,
            event: null,
            global: null
          }
    };
  }

  function buildAdminPvpEventResponse({
    eventConfig,
    storedPvpEvent,
    signupStore,
    snapshot,
    nowIso = getNowIso()
  }) {
    const signups = getPvpEventSignupsForConfig(signupStore, eventConfig);

    return {
      pvpEvent: {
        ...buildPvpEventInfo(eventConfig, nowIso, signups.length, null, null),
        snapshotUpdatedAt: snapshot?.updatedAt || null
      },
      storedPvpEvent: normalizePvpEventConfig(storedPvpEvent),
      leaderboards: {
        event: Array.isArray(snapshot?.event?.items) ? snapshot.event.items.slice(0, 10) : [],
        global: Array.isArray(snapshot?.global?.items) ? snapshot.global.items.slice(0, 10) : []
      },
      recentSignups: signups
        .slice(-10)
        .reverse()
        .map((entry) => ({
          user: summarizeUser(entry.user),
          signedUpAt: entry.signedUpAt
        }))
    };
  }

  function backfillMatchStoreFromClaims(matchStore, cdkStore) {
    let mutated = false;

    for (const entry of cdkStore.cdks) {
      const context = entry.claimContext || null;
      const ticketId = context?.matchTicketId || null;
      if (!ticketId) continue;

      const exists = matchStore.matches.some((item) => item.ticketId === ticketId);
      if (exists) continue;

      matchStore.matches.push(
        summarizeMatchRecord({
          id: randomUUID(),
          ticketId,
          pool: normalizeRewardPool(entry.pool),
          startedAt: null,
          completedAt: entry.claimedAt || context.preparedAt || null,
          recordedAt: entry.claimedAt || context.preparedAt || null,
          user: entry.claimedBy
            ? {
                id: entry.claimedBy.id,
                username: entry.claimedBy.username,
                displayName: entry.claimedBy.displayName,
                avatarUrl: entry.claimedBy.avatarUrl || null
              }
            : null,
          summary: context.summary
            ? {
                ...context.summary,
                codePool: context.summary.codePool || entry.pool,
                rewardPool: context.summary.rewardPool || context.summary.matchType || entry.pool,
                matchType: context.summary.matchType || context.summary.rewardPool || entry.pool
              }
            : null,
          rewardStatus: 'claimed',
          rewardPreparedAt: context.preparedAt || null,
          claimedAt: entry.claimedAt || null,
          assignedCode: entry.code || null
        })
      );
      mutated = true;
    }

    return mutated;
  }

  function upsertMatchRecord(store, record) {
    const ticketId = record.ticketId;
    const index = store.matches.findIndex((item) => item.ticketId === ticketId);

    if (index >= 0) {
      const existing = summarizeMatchRecord(store.matches[index]);
      const patch = Object.fromEntries(
        Object.entries(record).filter(([, value]) => value !== undefined && value !== null && value !== '')
      );
      store.matches[index] = summarizeMatchRecord({
        ...existing,
        ...patch,
        id: existing.id || record.id || randomUUID(),
        ticketId: existing.ticketId || ticketId
      });
      return store.matches[index];
    }

    const created = summarizeMatchRecord({
      ...record,
      id: record.id || randomUUID()
    });
    store.matches.push(created);
    return created;
  }

  function findLatestReadyMatchForUser(store, user) {
    if (!store?.matches?.length || !user?.id) {
      return null;
    }

    return (
      store.matches
        .filter(
          (entry) =>
            entry?.rewardStatus === 'ready' &&
            String(entry.user?.id || '') === String(user.id) &&
            !entry.claimedAt &&
            !entry.assignedCode &&
            entry.summary
        )
        .sort((left, right) =>
          String(right.rewardPreparedAt || right.completedAt || right.recordedAt || '').localeCompare(
            String(left.rewardPreparedAt || left.completedAt || left.recordedAt || '')
          )
        )[0] || null
    );
  }

  function ensureSessionPendingAwardFromMatchStore(session, user, store) {
    if (!session || !user) {
      return null;
    }

    if (session.pendingAward?.ticketId) {
      return session.pendingAward;
    }

    const readyMatch = findLatestReadyMatchForUser(store, user);
    if (!readyMatch) {
      return null;
    }

    session.pendingAward = createPendingAwardFromMatchRecord(readyMatch);
    return session.pendingAward;
  }

  function setPendingAwardForUserSessions(userKey, pendingAward) {
    if (!userKey || !pendingAward?.ticketId) {
      return;
    }

    for (const session of sessions.values()) {
      if (!session?.user || getUserKey(session.user) !== userKey) {
        continue;
      }

      if (!session.pendingAward || session.pendingAward.ticketId === pendingAward.ticketId) {
        session.pendingAward = {
          awardId: pendingAward.awardId,
          ticketId: pendingAward.ticketId,
          preparedAt: pendingAward.preparedAt,
          summary: pendingAward.summary
        };
      }
    }
  }

  async function recordPvpMatchResult(payload) {
    const result = payload?.result;
    if (!result?.matchId || !Array.isArray(result.stats) || !result.stats.length) {
      return;
    }

    const store = await readCdkStore();
    const matchStore = await readMatchStore();
    const appConfig = await readAppConfig();
    const startedAt = payload.startedAt || null;
    const completedAt = payload.endedAt || getNowIso();
    const mvpStat = result.stats.find((entry) => String(entry.userId) === String(result.mvpUserId)) || null;
    const replayRecord = summarizeReplayRecord(payload?.replay || null);
    const pvpRewardsEnabled = Boolean(appConfig.pvp?.rewardEnabled);

    for (const stat of result.stats) {
      const userInfo =
        payload.players?.find((entry) => String(entry.userId) === String(stat.userId)) || null;
      const userKey = getUserKey({ id: stat.userId });
      const ticketId = `pvp:${result.matchId}:${stat.userId}`;
      const summary = sanitizeAwardSummary({
        matchType: 'pvp',
        rewardPool: 'pvp',
        codePool: getCodePoolForGameMode(result.mode, LEGACY_PVP_CODE_POOL),
        gameMode: result.mode,
        difficulty: null,
        winnerTeam: result.winnerTeam || null,
        playerTeam: stat.team || null,
        playerWon: Boolean(stat.won),
        playerIsMvp: String(stat.userId) === String(result.mvpUserId),
        eligibleForAward: false,
        mvpTeam: mvpStat?.team || result.winnerTeam || null,
        mvpName: mvpStat?.displayName || mvpStat?.username || null,
        playerName: userInfo?.displayName || stat.displayName || stat.username || stat.userId,
        matchDurationSeconds: getServerObservedDurationSeconds(startedAt, completedAt),
        playerStats: {
          kills: Number(stat.kills || 0),
          deaths: Number(stat.deaths || 0),
          damageDealt: Number(stat.damageDealt || 0)
        }
      });

      if (!pvpRewardsEnabled && summary.eligibleForAward && !summary.awardBlockedReason) {
        summary.awardBlockedReason = 'pvp_rewards_disabled';
        summary.eligibleForAward = false;
      }

      const dailyClaimSummary = getUserDailyClaimSummary(store, userKey, appConfig.rewardPolicy, completedAt);
      const limitStatus = getRewardLimitStatus(summary, appConfig.rewardPolicy, dailyClaimSummary);

      if (summary.eligibleForAward && limitStatus?.limit <= 0) {
        summary.awardBlockedReason = 'daily_limit_disabled';
        summary.eligibleForAward = false;
      }

      const existingClaim = store.cdks.find(
        (entry) =>
          entry.claimedBy?.key === userKey &&
          entry.claimContext?.matchTicketId === ticketId
      );

      const record = upsertMatchRecord(matchStore, {
        ticketId,
        pool: summary.codePool || LEGACY_PVP_CODE_POOL,
        startedAt,
        completedAt,
        recordedAt: completedAt,
        user: {
          id: String(stat.userId),
          username: userInfo?.username || stat.username || '',
          displayName: userInfo?.displayName || stat.displayName || stat.username || stat.userId,
          avatarUrl: null
        },
        summary,
        rewardStatus: existingClaim ? 'claimed' : summary.eligibleForAward ? 'ready' : 'not_eligible',
        rewardPreparedAt: existingClaim || summary.eligibleForAward ? completedAt : null,
        claimedAt: existingClaim?.claimedAt || null,
        assignedCode: existingClaim?.code || null,
        replay: replayRecord
      });

      if (!existingClaim && summary.eligibleForAward) {
        const pendingAward = createPendingAwardFromMatchRecord(record);
        if (pendingAward) {
          setPendingAwardForUserSessions(userKey, pendingAward);
        }
      }
    }

    const replayLimit = Number(appConfig.pvp?.replay?.maxStoredMatches || 0);
    await pruneReplayArtifacts(matchStore, replayLimit);
    await writeMatchStore(matchStore);
    const signupStore = await readPvpEventSignupStore();
    await ensurePvpEventLeaderboardSnapshot(appConfig.pvpEvent, {
      matchStore,
      signupStore
    });
  }

  function cleanupEphemeralState() {
    const now = getNowMs();

    for (const [sessionId, session] of sessions.entries()) {
      if (!session || session.expiresAt <= now) {
        sessions.delete(sessionId);
      }
    }

    for (const [stateToken, state] of loginStates.entries()) {
      if (!state || state.expiresAt <= now) {
        loginStates.delete(stateToken);
      }
    }
  }

  function getSession(req) {
    cleanupEphemeralState();
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies[SESSION_COOKIE];
    if (!sessionId) return null;
    return sessions.get(sessionId) || null;
  }

  function getPvpTransportPayload() {
    if (!pvpEdgeConfig.baseUrl || !pvpEdgeConfig.sharedSecret) {
      return {
        mode: 'same-origin',
        apiBaseUrl: ''
      };
    }

    return {
      mode: 'edge',
      apiBaseUrl: pvpEdgeConfig.baseUrl
    };
  }

  function getPvpCorsHeaders(req) {
    const origin = getRequestOrigin(req);
    if (!origin) return {};
    if (!pvpEdgeConfig.allowedOrigins.length || !pvpEdgeConfig.allowedOrigins.includes(origin)) {
      return {};
    }

    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin'
    };
  }

  function sendPvpPreflight(req, res) {
    const headers = getPvpCorsHeaders(req);
    if (!Object.keys(headers).length) {
      sendJson(res, 403, { error: 'cors_origin_not_allowed' });
      return;
    }
    res.writeHead(204, {
      ...headers,
      'Content-Length': 0
    });
    res.end();
  }

  function resolvePvpTokenUser(req, requestUrl = null) {
    const token = readPvpAccessToken(req, requestUrl);
    const verified = verifyPvpEdgeAccessToken(token, pvpEdgeConfig.sharedSecret, getNowMs());
    return verified?.user || null;
  }

  async function getSessionPayload(req) {
    const session = getSession(req);
    const appConfig = await readAppConfig();
    const user = session?.user || null;
    const isAdmin = Boolean(
      user &&
        (appConfig.adminUserIds.includes(String(user.id)) ||
          appConfig.adminUsernames.includes(String(user.username)))
    );

    return {
      session,
      user,
      isAdmin,
      oauthConfigured: Boolean(oauthConfig.clientId && oauthConfig.clientSecret),
      awardSecurity,
      rewardPolicy: appConfig.rewardPolicy,
      pvpConfig: appConfig.pvp,
      pvpEvent: appConfig.pvpEvent,
      pvpTransport: getPvpTransportPayload(),
      pendingAward: summarizePendingAward(session?.pendingAward || null),
      activeMatch: session?.activeMatch || null
    };
  }

  async function getPvpRequestPayload(req, requestUrl = null) {
    const payload = await getSessionPayload(req);
    if (payload.user) {
      return payload;
    }

    const tokenUser = resolvePvpTokenUser(req, requestUrl);
    if (!tokenUser) {
      return payload;
    }

    return {
      ...payload,
      session: null,
      user: tokenUser,
      isAdmin: false,
      pendingAward: null,
      activeMatch: null
    };
  }

  async function requireUser(req, res) {
    const payload = await getSessionPayload(req);
    if (!payload.user) {
      sendJson(res, 401, {
        error: 'not_authenticated',
        oauthConfigured: payload.oauthConfigured
      });
      return null;
    }
    return payload;
  }

  async function requirePvpUser(req, res, requestUrl = null) {
    const payload = await getPvpRequestPayload(req, requestUrl);
    if (!payload.user) {
      sendJson(
        res,
        401,
        {
          error: 'not_authenticated',
          oauthConfigured: payload.oauthConfigured
        },
        getPvpCorsHeaders(req)
      );
      return null;
    }
    return payload;
  }

  async function requireAdmin(req, res) {
    const payload = await requireUser(req, res);
    if (!payload) return null;
    if (!payload.isAdmin) {
      sendJson(res, 403, { error: 'admin_only' });
      return null;
    }
    return payload;
  }

  async function handleHealth(_req, res) {
    sendJson(res, 200, {
      ok: true,
      oauthConfigured: Boolean(oauthConfig.clientId && oauthConfig.clientSecret),
      awardSecurity
    });
  }

  async function handleSession(req, res) {
    const payload = await getSessionPayload(req);
    sendJson(res, 200, {
      authenticated: Boolean(payload.user),
      oauthConfigured: payload.oauthConfigured,
      awardSecurity: payload.awardSecurity,
      rewardPolicy: payload.rewardPolicy,
      pvpConfig: payload.pvpConfig,
      pvpEvent: payload.pvpEvent,
      pvpTransport: payload.pvpTransport,
      isAdmin: payload.isAdmin,
      user: payload.user ? summarizeUser(payload.user) : null,
      pendingAward: payload.pendingAward,
      activeMatch: payload.activeMatch
    });
  }

  async function handlePvpEvent(req, res) {
    const user = getSession(req)?.user || null;
    const appConfig = await readAppConfig();
    const signupStore = await readPvpEventSignupStore();
    const matchStore = await readMatchStore();
    const snapshot = await ensurePvpEventLeaderboardSnapshot(appConfig.pvpEvent, {
      matchStore,
      signupStore
    });

    sendJson(
      res,
      200,
      buildPvpEventResponse({
        eventConfig: appConfig.pvpEvent,
        signupStore,
        snapshot,
        user
      })
    );
  }

  async function handlePvpEventSignup(req, res) {
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res);
      return;
    }

    const payload = await requireUser(req, res);
    if (!payload) return;

    const appConfig = await readAppConfig();
    const phase = getPvpEventPhase(appConfig.pvpEvent, getNowIso());
    if (!appConfig.pvpEvent?.enabled) {
      sendJson(res, 409, { error: 'pvp_event_disabled' });
      return;
    }
    if (!isPvpEventConfigured(appConfig.pvpEvent)) {
      sendJson(res, 409, { error: 'pvp_event_not_configured' });
      return;
    }
    if (!canSignUpForPvpEventPhase(phase)) {
      sendJson(res, 409, {
        error: 'pvp_event_signup_not_open',
        phase
      });
      return;
    }

    const signupStore = await readPvpEventSignupStore();
    const existingSignup = getPvpEventSignupForUser(signupStore, appConfig.pvpEvent, payload.user);
    if (existingSignup) {
      sendJson(res, 409, { error: 'pvp_event_already_signed_up' });
      return;
    }

    const signedUpAt = getNowIso();
    signupStore.signups.push(
      summarizePvpEventSignup({
        eventSlug: appConfig.pvpEvent.slug,
        user: summarizeUser(payload.user),
        signedUpAt,
        source: 'self_signup'
      })
    );
    await writePvpEventSignupStore(signupStore);

    const matchStore = await readMatchStore();
    const snapshot = await ensurePvpEventLeaderboardSnapshot(appConfig.pvpEvent, {
      matchStore,
      signupStore
    });

    sendJson(res, 200, {
      signedUp: true,
      signedUpAt,
      ...buildPvpEventResponse({
        eventConfig: appConfig.pvpEvent,
        signupStore,
        snapshot,
        user: payload.user,
        nowIso: signedUpAt
      })
    });
  }

  async function handlePvpEdgeToken(req, res) {
    const payload = await requireUser(req, res);
    if (!payload) return;

    if (!pvpEdgeConfig.baseUrl || !pvpEdgeConfig.sharedSecret) {
      sendJson(res, 404, { error: 'pvp_edge_not_configured' });
      return;
    }

    const issuedAtMs = getNowMs();
    const accessToken = createPvpEdgeAccessToken(
      payload.user,
      pvpEdgeConfig.sharedSecret,
      issuedAtMs,
      pvpEdgeConfig.tokenTtlMs
    );

    sendJson(res, 200, {
      apiBaseUrl: pvpEdgeConfig.baseUrl,
      accessToken,
      expiresAt: new Date(issuedAtMs + pvpEdgeConfig.tokenTtlMs).toISOString()
    });
  }

  async function handleLogout(req, res) {
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res);
      return;
    }

    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies[SESSION_COOKIE];
    if (sessionId) {
      sessions.delete(sessionId);
    }

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`
    });
    res.end(JSON.stringify({ ok: true }));
  }

  async function handleOAuthStart(req, res, requestUrl) {
    if (req.method !== 'GET') {
      sendMethodNotAllowed(res);
      return;
    }

    if (!oauthConfig.clientId || !oauthConfig.clientSecret) {
      sendHtml(
        res,
        500,
        createErrorPage(
          'Linux.do login is not configured',
          'Set LINUX_DO_CLIENT_ID and LINUX_DO_CLIENT_SECRET before trying to sign in.'
        )
      );
      return;
    }

    const stateToken = createStateToken();
    const returnTo = safeReturnTo(requestUrl.searchParams.get('returnTo'));

    loginStates.set(stateToken, {
      returnTo,
      expiresAt: getNowMs() + oauthStateTtlMs
    });

    const callbackUrl = getCallbackUrl(req, oauthConfig);
    const authorizeUrl = new URL(oauthConfig.authorizeEndpoint);
    authorizeUrl.searchParams.set('client_id', oauthConfig.clientId);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('redirect_uri', callbackUrl);
    authorizeUrl.searchParams.set('scope', oauthConfig.scope);
    authorizeUrl.searchParams.set('state', stateToken);

    redirect(res, authorizeUrl.toString());
  }

  async function exchangeCodeForToken(code, callbackUrl) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl,
      client_id: oauthConfig.clientId
    });

    const basicAuth = Buffer.from(
      `${oauthConfig.clientId}:${oauthConfig.clientSecret}`,
      'utf8'
    ).toString('base64');

    const response = await fetchImpl(oauthConfig.tokenEndpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`linuxdo_token_exchange_failed:${response.status}:${text}`);
    }

    const payload = await response.json();
    if (!payload.access_token) {
      throw new Error('linuxdo_token_exchange_missing_access_token');
    }

    return payload.access_token;
  }

  async function fetchLinuxDoProfile(accessToken) {
    const response = await fetchImpl(oauthConfig.userEndpoint, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`linuxdo_profile_fetch_failed:${response.status}:${text}`);
    }

    return normalizeLinuxDoProfile(await response.json());
  }

  async function handleOAuthCallback(req, res, requestUrl) {
    if (req.method !== 'GET') {
      sendMethodNotAllowed(res);
      return;
    }

    const error = requestUrl.searchParams.get('error');
    if (error) {
      sendHtml(
        res,
        400,
        createErrorPage('Linux.do login failed', `OAuth provider returned: ${error}.`)
      );
      return;
    }

    const code = requestUrl.searchParams.get('code');
    const stateToken = requestUrl.searchParams.get('state');
    const stateRecord = stateToken ? loginStates.get(stateToken) : null;

    if (!code || !stateToken || !stateRecord) {
      sendHtml(
        res,
        400,
        createErrorPage(
          'Linux.do login failed',
          'The OAuth callback was missing a valid code or state token.'
        )
      );
      return;
    }

    loginStates.delete(stateToken);

    try {
      const callbackUrl = getCallbackUrl(req, oauthConfig);
      const accessToken = await exchangeCodeForToken(code, callbackUrl);
      const user = await fetchLinuxDoProfile(accessToken);
      const sessionId = randomUUID();

      sessions.set(sessionId, {
        user,
        createdAt: getNowMs(),
        expiresAt: getNowMs() + sessionTtlMs,
        activeMatch: null,
        pendingAward: null
      });

      const secureCookie = isSecureRequest(req, oauthConfig) ? '; Secure' : '';

      redirect(res, stateRecord.returnTo || '/', {
        'Set-Cookie': `${SESSION_COOKIE}=${encodeURIComponent(
          sessionId
        )}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
          sessionTtlMs / 1000
        )}${secureCookie}`
      });
    } catch (callbackError) {
      sendHtml(
        res,
        500,
        createErrorPage(
          'Linux.do login failed',
          `The callback completed, but token or profile retrieval failed. ${callbackError.message}`
        )
      );
    }
  }

  async function handleStartMatchAward(req, res) {
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res);
      return;
    }

    const payload = await requireUser(req, res);
    if (!payload) return;

    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, {
        error: error.message === 'request_too_large' ? 'request_too_large' : 'invalid_json'
      });
      return;
    }

    const codePool = resolveRequestedCodePool(body);
    const rewardPool = getRewardPoolFamily(codePool);
    const ticket = {
      ticketId: randomUUID(),
      startedAt: getNowIso(),
      gameMode: normalizeGameMode(
        body.gameMode,
        typeof body.gameMode === 'string' ? body.gameMode.slice(0, 40) : null
      ),
      difficulty: normalizeDifficulty(
        body.difficulty,
        typeof body.difficulty === 'string' ? body.difficulty.slice(0, 40) : null
      ),
      matchType: rewardPool,
      rewardPool,
      codePool,
      consumed: false
    };

    payload.session.activeMatch = ticket;

    sendJson(res, 200, {
      activeMatch: ticket,
      pendingAward: summarizePendingAward(payload.session.pendingAward || null)
    });
  }

  async function handlePrepareMatchAward(req, res) {
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res);
      return;
    }

    const payload = await requireUser(req, res);
    if (!payload) return;

    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, {
        error: error.message === 'request_too_large' ? 'request_too_large' : 'invalid_json'
      });
      return;
    }

    const ticketId = typeof body.ticketId === 'string' ? body.ticketId.trim() : '';
    const activeMatch = payload.session.activeMatch || null;
    const pendingAward = payload.session.pendingAward || null;

    if (!ticketId || !activeMatch || activeMatch.ticketId !== ticketId) {
      sendJson(res, 409, {
        error: 'match_ticket_missing'
      });
      return;
    }

    if (activeMatch.consumed && pendingAward?.ticketId !== ticketId) {
      sendJson(res, 409, {
        error: 'match_ticket_consumed'
      });
      return;
    }

    const rawSummary = body.summary && typeof body.summary === 'object' ? body.summary : {};
    const completedAt = getNowIso();
    const serverObservedDuration = getServerObservedDurationSeconds(activeMatch.startedAt, completedAt);
    const summary = sanitizeAwardSummary({
      ...rawSummary,
      gameMode: activeMatch.gameMode ?? null,
      difficulty: activeMatch.difficulty ?? null,
      matchType: activeMatch.matchType ?? activeMatch.rewardPool ?? DEFAULT_REWARD_POOL,
      rewardPool: activeMatch.rewardPool ?? activeMatch.matchType ?? DEFAULT_REWARD_POOL,
      codePool: activeMatch.codePool ?? rawSummary.codePool ?? rawSummary.rewardPool ?? rawSummary.matchType,
      matchDurationSeconds: serverObservedDuration
    });
    const codePool = getCodePoolForSummary(summary);

    if (!allowClientReportedAwards && !summary.awardBlockedReason) {
      summary.awardBlockedReason = 'server_verification_required';
      summary.eligibleForAward = false;
    }

    const store = await readCdkStore();
    const matchStore = await readMatchStore();
    const userKey = getUserKey(payload.user);
    const availableCounts = getAvailableCounts(store);
    const availableCount = getCodePoolFallbacks(codePool).reduce(
      (sum, pool) => sum + selectPoolCount(availableCounts, pool),
      0
    );
    const dailyClaimSummary = getUserDailyClaimSummary(store, userKey, payload.rewardPolicy, completedAt);
    const limitStatus = getRewardLimitStatus(summary, payload.rewardPolicy, dailyClaimSummary);

    if (summary.eligibleForAward && limitStatus?.limit <= 0) {
      summary.awardBlockedReason = 'daily_limit_disabled';
      summary.eligibleForAward = false;
    }

    payload.session.activeMatch = {
      ...activeMatch,
      consumed: true
    };

    upsertMatchRecord(matchStore, {
      ticketId,
      pool: codePool,
      startedAt: activeMatch.startedAt || null,
      completedAt,
      recordedAt: completedAt,
      user: summarizeUser(payload.user),
      summary,
      rewardStatus: summary.eligibleForAward ? 'ready' : 'not_eligible'
    });

    const existingClaim = store.cdks.find(
      (entry) =>
        entry.claimedBy?.key === userKey &&
        entry.claimContext?.matchTicketId === ticketId
    );

    if (existingClaim) {
      upsertMatchRecord(matchStore, {
        ticketId,
        pool: existingClaim.pool || codePool,
        startedAt: activeMatch.startedAt || null,
        completedAt,
        recordedAt: completedAt,
        user: summarizeUser(payload.user),
        summary,
        rewardStatus: 'claimed',
        rewardPreparedAt: existingClaim.claimContext?.preparedAt || null,
        claimedAt: existingClaim.claimedAt || null,
        assignedCode: existingClaim.code || null
      });
      await writeMatchStore(matchStore);
      sendJson(res, 200, {
        prepared: false,
        eligible: summary.eligibleForAward,
        alreadyClaimed: true,
        latestClaim: summarizeCdk(existingClaim),
        pendingAward: null,
        availableCount,
        availableCounts,
        limitStatus,
        rewardPool: summary.rewardPool,
        codePool: existingClaim.pool || codePool
      });
      return;
    }

    if (!summary.eligibleForAward) {
      await writeMatchStore(matchStore);
      sendJson(res, 200, {
        prepared: false,
        eligible: false,
        disqualifyReason: summary.awardBlockedReason || 'award_not_eligible',
        summary,
        pendingAward: summarizePendingAward(payload.session.pendingAward || null),
        availableCount,
        availableCounts,
        limitStatus,
        rewardPool: summary.rewardPool,
        codePool
      });
      return;
    }

    if (pendingAward?.ticketId === ticketId) {
      upsertMatchRecord(matchStore, {
        ticketId,
        pool: codePool,
        startedAt: activeMatch.startedAt || null,
        completedAt,
        recordedAt: completedAt,
        user: summarizeUser(payload.user),
        summary,
        rewardStatus: 'ready',
        rewardPreparedAt: pendingAward.preparedAt
      });
      await writeMatchStore(matchStore);
      sendJson(res, 200, {
        prepared: true,
        eligible: true,
        pendingAward: summarizePendingAward(pendingAward),
        availableCount,
        availableCounts,
        limitStatus,
        rewardPool: summary.rewardPool,
        codePool
      });
      return;
    }

    payload.session.pendingAward = {
      awardId: randomUUID(),
      ticketId,
      preparedAt: completedAt,
      summary
    };

    upsertMatchRecord(matchStore, {
      ticketId,
      pool: codePool,
      startedAt: activeMatch.startedAt || null,
      completedAt,
      recordedAt: completedAt,
      user: summarizeUser(payload.user),
      summary,
      rewardStatus: 'ready',
      rewardPreparedAt: completedAt
    });
    await writeMatchStore(matchStore);

    sendJson(res, 200, {
      prepared: true,
      eligible: true,
      pendingAward: summarizePendingAward(payload.session.pendingAward),
      availableCount,
      availableCounts,
      limitStatus,
      rewardPool: summary.rewardPool,
      codePool
    });
  }

  async function handleGetMyCdk(req, res) {
    const payload = await requireUser(req, res);
    if (!payload) return;

    const store = await readCdkStore();
    const matchStore = await readMatchStore();
    const userKey = getUserKey(payload.user);
    ensureSessionPendingAwardFromMatchStore(payload.session, payload.user, matchStore);
    const items = store.cdks
      .filter((entry) => entry.claimedBy?.key === userKey)
      .sort((left, right) => String(right.claimedAt || '').localeCompare(String(left.claimedAt || '')));
    const availableCounts = getAvailableCounts(store);
    const claimSummary = getUserClaimSummary(store, userKey);
    const dailyClaimSummary = getUserDailyClaimSummary(store, userKey, payload.rewardPolicy, getNowIso());
    const pendingAward = summarizePendingAward(payload.session.pendingAward || null);
    const pendingPool = getRewardPoolFamily(
      pendingAward?.summary?.rewardPool || pendingAward?.summary?.matchType || pendingAward?.summary?.gameMode
    );
    const pendingCodePool = pendingAward ? getCodePoolForSummary(pendingAward.summary) : null;
    const pendingAvailableCount = pendingAward
      ? getCodePoolFallbacks(pendingCodePool).reduce(
          (sum, pool) => sum + selectPoolCount(availableCounts, pool),
          0
        )
      : 0;
    const pendingLimitStatus = pendingAward
      ? getRewardLimitStatus(pendingAward.summary, payload.rewardPolicy, dailyClaimSummary)
      : null;

    sendJson(res, 200, {
      latestClaim: items.length ? summarizeCdk(items[0]) : null,
      recentClaims: items.slice(0, 5).map(summarizeCdk),
      claimCount: claimSummary.total,
      claimCounts: claimSummary.byPool,
      dailyClaims: dailyClaimSummary,
      availableCount: pendingAward
        ? pendingAvailableCount
        : getTotalAvailableCodeCount(availableCounts),
      availableCounts,
      pendingPool,
      pendingCodePool,
      pendingAvailableCount,
      pendingLimitStatus,
      pendingAward,
      rewardPolicy: payload.rewardPolicy
    });
  }

  async function handleClaimCdk(req, res) {
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res);
      return;
    }

    const payload = await requireUser(req, res);
    if (!payload) return;

    const store = await readCdkStore();
    const matchStore = await readMatchStore();
    const userKey = getUserKey(payload.user);
    const pendingAward =
      payload.session.pendingAward ||
      ensureSessionPendingAwardFromMatchStore(payload.session, payload.user, matchStore) ||
      null;

    if (!pendingAward) {
      sendJson(res, 409, {
        error: 'award_not_ready'
      });
      return;
    }

    const pendingSummary = sanitizeAwardSummary(pendingAward.summary);
    const rewardPool = getRewardPoolFamily(pendingSummary.rewardPool || pendingSummary.matchType);
    const codePool = getCodePoolForSummary(pendingSummary);
    const availableCounts = getAvailableCounts(store);
    const dailyClaimSummary = getUserDailyClaimSummary(store, userKey, payload.rewardPolicy, getNowIso());
    const limitStatus = getRewardLimitStatus(pendingSummary, payload.rewardPolicy, dailyClaimSummary);

    const existing = store.cdks.find(
      (entry) =>
        entry.claimedBy?.key === userKey &&
        entry.claimContext?.matchTicketId === pendingAward.ticketId
    );

    if (existing) {
      upsertMatchRecord(matchStore, {
        ticketId: pendingAward.ticketId,
        pool: existing.pool || codePool,
        completedAt: pendingAward.preparedAt,
        recordedAt: getNowIso(),
        user: summarizeUser(payload.user),
        summary: pendingAward.summary,
        rewardStatus: 'claimed',
        rewardPreparedAt: pendingAward.preparedAt,
        claimedAt: existing.claimedAt || null,
        assignedCode: existing.code || null
      });
      await writeMatchStore(matchStore);
      payload.session.pendingAward = null;
      const claimSummary = getUserClaimSummary(store, userKey);
      sendJson(res, 200, {
        assignedCdk: summarizeCdk(existing),
        newlyClaimed: false,
        availableCount: getCodePoolFallbacks(codePool).reduce(
          (sum, pool) => sum + selectPoolCount(availableCounts, pool),
          0
        ),
        availableCounts,
        claimCount: claimSummary.total,
        claimCounts: claimSummary.byPool,
        dailyClaims: dailyClaimSummary,
        limitStatus,
        rewardPool,
        codePool: existing.pool || codePool
      });
      return;
    }

    if (limitStatus?.limit <= 0) {
      upsertMatchRecord(matchStore, {
        ticketId: pendingAward.ticketId,
        pool: codePool,
        completedAt: pendingAward.preparedAt,
        recordedAt: getNowIso(),
        user: summarizeUser(payload.user),
        summary: {
          ...pendingSummary,
          eligibleForAward: false,
          awardBlockedReason: 'daily_limit_disabled'
        },
        rewardStatus: 'not_eligible'
      });
      await writeMatchStore(matchStore);
      payload.session.pendingAward = null;
      sendJson(res, 409, {
        error: 'award_not_eligible',
        disqualifyReason: 'daily_limit_disabled',
        summary: {
          ...pendingSummary,
          eligibleForAward: false,
          awardBlockedReason: 'daily_limit_disabled'
        },
        rewardPool,
        codePool,
        limitStatus
      });
      return;
    }

    if (!pendingSummary.eligibleForAward) {
      upsertMatchRecord(matchStore, {
        ticketId: pendingAward.ticketId,
        pool: codePool,
        completedAt: pendingAward.preparedAt,
        recordedAt: getNowIso(),
        user: summarizeUser(payload.user),
        summary: pendingSummary,
        rewardStatus: 'not_eligible'
      });
      await writeMatchStore(matchStore);
      payload.session.pendingAward = null;
      sendJson(res, 409, {
        error: 'award_not_eligible',
        disqualifyReason: pendingSummary.awardBlockedReason || 'award_not_eligible',
        summary: pendingSummary,
        rewardPool,
        codePool,
        limitStatus
      });
      return;
    }

    if (limitStatus?.reached) {
      sendJson(res, 409, {
        error: 'daily_limit_reached',
        rewardPool,
        codePool,
        limitStatus
      });
      return;
    }

    const candidatePools = getCodePoolFallbacks(codePool);
    const nextAvailable = store.cdks.find(
      (entry) => entry.status === 'available' && candidatePools.includes(normalizeRewardPool(entry.pool))
    );
    if (!nextAvailable) {
      sendJson(res, 409, {
        error: 'cdk_pool_empty',
        rewardPool,
        codePool
      });
      return;
    }

    nextAvailable.pool = normalizeRewardPool(nextAvailable.pool || codePool);
    nextAvailable.status = 'assigned';
    nextAvailable.claimedAt = getNowIso();
    nextAvailable.claimedBy = {
      key: userKey,
      ...summarizeUser(payload.user)
    };
    nextAvailable.claimContext = {
      awardId: pendingAward.awardId,
      matchTicketId: pendingAward.ticketId,
      preparedAt: pendingAward.preparedAt,
      summary: pendingAward.summary
    };

    await writeCdkStore(store);
    upsertMatchRecord(matchStore, {
      ticketId: pendingAward.ticketId,
      pool: nextAvailable.pool || codePool,
      completedAt: pendingAward.preparedAt,
      recordedAt: getNowIso(),
      user: summarizeUser(payload.user),
      summary: pendingAward.summary,
      rewardStatus: 'claimed',
      rewardPreparedAt: pendingAward.preparedAt,
      claimedAt: nextAvailable.claimedAt,
      assignedCode: nextAvailable.code
    });
    await writeMatchStore(matchStore);
    payload.session.pendingAward = null;
    const nextAvailableCounts = getAvailableCounts(store);
    const claimSummary = getUserClaimSummary(store, userKey);
    const nextDailyClaimSummary = getUserDailyClaimSummary(
      store,
      userKey,
      payload.rewardPolicy,
      nextAvailable.claimedAt
    );
    const nextLimitStatus = getRewardLimitStatus(pendingSummary, payload.rewardPolicy, nextDailyClaimSummary);

    sendJson(res, 200, {
      assignedCdk: summarizeCdk(nextAvailable),
      newlyClaimed: true,
      availableCount: candidatePools.reduce((sum, pool) => sum + selectPoolCount(nextAvailableCounts, pool), 0),
      availableCounts: nextAvailableCounts,
      claimCount: claimSummary.total,
      claimCounts: claimSummary.byPool,
      dailyClaims: nextDailyClaimSummary,
      limitStatus: nextLimitStatus,
      rewardPool,
      codePool: nextAvailable.pool || codePool
    });
  }

  async function handleAdminListCdks(req, res) {
    const payload = await requireAdmin(req, res);
    if (!payload) return;

    const store = await readCdkStore();
    const matchStore = await readMatchStore();
    const storedConfig = await readStoredAppConfig();
    if (backfillMatchStoreFromClaims(matchStore, store)) {
      await writeMatchStore(matchStore);
    }
    const items = store.cdks
      .slice()
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .map(summarizeCdk);
    const matches = matchStore.matches
      .slice()
      .sort((left, right) =>
        String(right.completedAt || right.recordedAt || '').localeCompare(
          String(left.completedAt || left.recordedAt || '')
        )
      )
      .map(summarizeMatchRecord);
    const cdkSummary = getCdkSummary(store);
    const matchSummary = getMatchSummary(matches);

    sendJson(res, 200, {
      items,
      matches,
      summary: cdkSummary,
      matchSummary,
      rewardPolicy: payload.rewardPolicy,
      storedRewardPolicy: storedConfig.rewardPolicy,
      rewardPolicyOverrides: readRewardPolicyOverrideSources()
    });
  }

  async function handleAdminGetReplayDetail(req, res, matchId) {
    const payload = await requireAdmin(req, res);
    if (!payload) return;

    const matchStore = await readMatchStore();
    const signupStore = await readPvpEventSignupStore();
    const records = findReplayMatchRecords(matchStore, matchId);
    if (!records.length) {
      sendJson(res, 404, { error: 'replay_not_found' });
      return;
    }

    const replay = summarizeReplayRecord(records.find((record) => record?.replay)?.replay || null);
    if (!replay) {
      sendJson(res, 404, { error: 'replay_not_found' });
      return;
    }

    sendJson(res, 200, {
      ...buildReplayDetailPayload(replay, records),
      eventPanel: buildReplayEventPanel(matchStore, signupStore, payload.pvpEvent, records)
    });
  }

  async function handleAdminGetReplayContent(req, res, matchId) {
    const payload = await requireAdmin(req, res);
    if (!payload) return;

    const matchStore = await readMatchStore();
    const signupStore = await readPvpEventSignupStore();
    const records = findReplayMatchRecords(matchStore, matchId);
    if (!records.length) {
      sendJson(res, 404, { error: 'replay_not_found' });
      return;
    }

    const replay = summarizeReplayRecord(records.find((record) => record?.replay)?.replay || null);
    if (!replay) {
      sendJson(res, 404, { error: 'replay_not_found' });
      return;
    }

    const detail = {
      ...buildReplayDetailPayload(replay, records),
      eventPanel: buildReplayEventPanel(matchStore, signupStore, payload.pvpEvent, records)
    };

    if (!replay.available || !replay.relativePath) {
      sendJson(res, 409, {
        error: replay.status === 'pruned' ? 'replay_pruned' : 'replay_not_available',
        replay,
        ...detail
      });
      return;
    }

    try {
      const text = await readReplayFileText(dataDir, replay);
      const content = buildReplayContentPayload(replay, parseReplayText(text), records);
      sendJson(res, 200, {
        ...detail,
        content
      });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        sendJson(res, 410, {
          error: 'replay_missing',
          replay: {
            ...replay,
            available: false,
            status: 'missing'
          },
          ...detail
        });
        return;
      }

      if (error?.code === 'invalid_replay_file') {
        sendJson(res, 500, {
          error: 'invalid_replay_file',
          line: error.line || null,
          replay,
          ...detail
        });
        return;
      }

      throw error;
    }
  }

  async function handleAdminDownloadReplay(req, res, matchId) {
    const payload = await requireAdmin(req, res);
    if (!payload) return;

    const matchStore = await readMatchStore();
    const records = findReplayMatchRecords(matchStore, matchId);
    if (!records.length) {
      sendJson(res, 404, { error: 'replay_not_found' });
      return;
    }

    const replay = summarizeReplayRecord(records.find((record) => record?.replay)?.replay || null);
    if (!replay?.relativePath || !replay.available) {
      sendJson(res, 409, {
        error: replay?.status === 'pruned' ? 'replay_pruned' : 'replay_not_available',
        replay
      });
      return;
    }

    const absolutePath = toReplayAbsolutePath(dataDir, replay.relativePath);

    try {
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) {
        sendJson(res, 404, { error: 'replay_not_found' });
        return;
      }

      res.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Length': stat.size,
        'Content-Type': replay.compressed ? 'application/gzip' : 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': `attachment; filename="${replay.fileName || path.posix.basename(replay.relativePath)}"`
      });

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      createReadStream(absolutePath).pipe(res);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        sendJson(res, 410, { error: 'replay_missing', replay });
        return;
      }
      throw error;
    }
  }

  async function handlePvpListReplays(req, res) {
    const payload = await requireUser(req, res);
    if (!payload) return;

    const matchStore = await readMatchStore();
    const signupStore = await readPvpEventSignupStore();
    const requestUrl = new URL(req.url, 'http://localhost');
    const limit = Number(requestUrl.searchParams.get('limit') || 12);

    sendJson(res, 200, {
      items: buildPlayerReplayListPayload(matchStore, signupStore, payload.pvpEvent, payload.user, { limit })
    });
  }

  async function handlePvpGetReplayDetail(req, res, matchId) {
    const payload = await requireUser(req, res);
    if (!payload) return;

    const matchStore = await readMatchStore();
    const signupStore = await readPvpEventSignupStore();
    const records = findReplayMatchRecords(matchStore, matchId);
    if (!records.length) {
      sendJson(res, 404, { error: 'replay_not_found' });
      return;
    }

    if (!canUserAccessReplay(records, payload.user, payload.isAdmin)) {
      sendJson(res, 403, { error: 'replay_forbidden' });
      return;
    }

    const replay = summarizeReplayRecord(records.find((record) => record?.replay)?.replay || null);
    if (!replay) {
      sendJson(res, 404, { error: 'replay_not_found' });
      return;
    }

    sendJson(res, 200, {
      ...buildReplayDetailPayload(replay, records),
      eventPanel: buildReplayEventPanel(matchStore, signupStore, payload.pvpEvent, records)
    });
  }

  async function handlePvpGetReplayContent(req, res, matchId) {
    const payload = await requireUser(req, res);
    if (!payload) return;

    const matchStore = await readMatchStore();
    const signupStore = await readPvpEventSignupStore();
    const records = findReplayMatchRecords(matchStore, matchId);
    if (!records.length) {
      sendJson(res, 404, { error: 'replay_not_found' });
      return;
    }

    if (!canUserAccessReplay(records, payload.user, payload.isAdmin)) {
      sendJson(res, 403, { error: 'replay_forbidden' });
      return;
    }

    const replay = summarizeReplayRecord(records.find((record) => record?.replay)?.replay || null);
    if (!replay) {
      sendJson(res, 404, { error: 'replay_not_found' });
      return;
    }

    const eventPanel = buildReplayEventPanel(matchStore, signupStore, payload.pvpEvent, records);
    const detail = {
      ...buildReplayDetailPayload(replay, records),
      eventPanel
    };

    if (!replay.available || !replay.relativePath) {
      sendJson(res, 409, {
        error: replay.status === 'pruned' ? 'replay_pruned' : 'replay_not_available',
        replay,
        ...detail
      });
      return;
    }

    try {
      const text = await readReplayFileText(dataDir, replay);
      const content = buildReplayContentPayload(replay, parseReplayText(text), records);
      sendJson(res, 200, {
        ...detail,
        content
      });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        sendJson(res, 410, {
          error: 'replay_missing',
          replay: {
            ...replay,
            available: false,
            status: 'missing'
          },
          ...detail
        });
        return;
      }

      if (error?.code === 'invalid_replay_file') {
        sendJson(res, 500, {
          error: 'invalid_replay_file',
          line: error.line || null,
          replay,
          ...detail
        });
        return;
      }

      throw error;
    }
  }

  async function handleAdminGetRewardPolicy(req, res) {
    const payload = await requireAdmin(req, res);
    if (!payload) return;

    const storedConfig = await readStoredAppConfig();

    sendJson(res, 200, {
      rewardPolicy: payload.rewardPolicy,
      storedRewardPolicy: storedConfig.rewardPolicy,
      rewardPolicyOverrides: readRewardPolicyOverrideSources()
    });
  }

  async function handleAdminSaveRewardPolicy(req, res) {
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res);
      return;
    }

    const payload = await requireAdmin(req, res);
    if (!payload) return;

    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, {
        error: error.message === 'request_too_large' ? 'request_too_large' : 'invalid_json'
      });
      return;
    }

    const storedConfig = await readStoredAppConfig();
    const storedRewardPolicy = normalizeRewardPolicyInput(body);

    await writeStoredAppConfig({
      ...storedConfig,
      rewardPolicy: storedRewardPolicy
    });

    const nextAppConfig = await readAppConfig();

    sendJson(res, 200, {
      saved: true,
      rewardPolicy: nextAppConfig.rewardPolicy,
      storedRewardPolicy,
      rewardPolicyOverrides: readRewardPolicyOverrideSources()
    });
  }

  async function handleAdminGetPvpConfig(req, res) {
    const payload = await requireAdmin(req, res);
    if (!payload) return;

    const storedConfig = await readStoredAppConfig();

    sendJson(res, 200, {
      pvpConfig: payload.pvpConfig,
      storedPvpConfig: storedConfig.pvp
    });
  }

  async function handleAdminSavePvpConfig(req, res) {
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res);
      return;
    }

    const payload = await requireAdmin(req, res);
    if (!payload) return;

    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, {
        error: error.message === 'request_too_large' ? 'request_too_large' : 'invalid_json'
      });
      return;
    }

    const storedConfig = await readStoredAppConfig();
    const storedPvpConfig = normalizePvpConfigInput(body);

    await writeStoredAppConfig({
      ...storedConfig,
      pvp: storedPvpConfig
    });

    const nextAppConfig = await readAppConfig();

    sendJson(res, 200, {
      saved: true,
      pvpConfig: nextAppConfig.pvp,
      storedPvpConfig
    });
  }

  async function handleAdminGetPvpEvent(req, res) {
    const payload = await requireAdmin(req, res);
    if (!payload) return;

    const storedConfig = await readStoredAppConfig();
    const signupStore = await readPvpEventSignupStore();
    const matchStore = await readMatchStore();
    const snapshot = await ensurePvpEventLeaderboardSnapshot(payload.pvpEvent, {
      matchStore,
      signupStore
    });

    sendJson(
      res,
      200,
      buildAdminPvpEventResponse({
        eventConfig: payload.pvpEvent,
        storedPvpEvent: storedConfig.pvpEvent,
        signupStore,
        snapshot
      })
    );
  }

  async function handleAdminSavePvpEvent(req, res) {
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res);
      return;
    }

    const payload = await requireAdmin(req, res);
    if (!payload) return;

    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, {
        error: error.message === 'request_too_large' ? 'request_too_large' : 'invalid_json'
      });
      return;
    }

    const storedConfig = await readStoredAppConfig();
    const storedPvpEvent = normalizePvpEventConfigInput(body);

    await writeStoredAppConfig({
      ...storedConfig,
      pvpEvent: storedPvpEvent
    });

    const nextAppConfig = await readAppConfig();
    const signupStore = await readPvpEventSignupStore();
    const matchStore = await readMatchStore();
    const snapshot = await ensurePvpEventLeaderboardSnapshot(nextAppConfig.pvpEvent, {
      matchStore,
      signupStore
    });

    sendJson(
      res,
      200,
      {
        saved: true,
        ...buildAdminPvpEventResponse({
          eventConfig: nextAppConfig.pvpEvent,
          storedPvpEvent,
          signupStore,
          snapshot
        })
      }
    );
  }

  async function handleAdminAddCdks(req, res) {
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res);
      return;
    }

    const payload = await requireAdmin(req, res);
    if (!payload) return;

    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, {
        error: error.message === 'request_too_large' ? 'request_too_large' : 'invalid_json'
      });
      return;
    }

    const codes = normalizeCodes(body);
    if (!codes.length) {
      sendJson(res, 400, { error: 'missing_codes' });
      return;
    }

    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : '';
    const pool = normalizeRewardPool(body.pool || body.rewardPool || body.matchType);
    const now = getNowIso();
    const store = await readCdkStore();
    const existingCodes = new Set(store.cdks.map((item) => item.code));
    const addedItems = [];
    const skippedCodes = [];

    for (const code of codes) {
      if (existingCodes.has(code)) {
        skippedCodes.push(code);
        continue;
      }

      const item = {
        id: randomUUID(),
        code,
        pool,
        status: 'available',
        note,
        createdAt: now,
        createdBy: summarizeUser(payload.user),
        claimedAt: null,
        claimedBy: null
      };

      store.cdks.push(item);
      addedItems.push(item);
      existingCodes.add(code);
    }

    await writeCdkStore(store);

    sendJson(res, 200, {
      pool,
      addedCount: addedItems.length,
      skippedCount: skippedCodes.length,
      addedItems: addedItems.map(summarizeCdk),
      skippedCodes
    });
  }

  function sendPvpError(req, res, error) {
    sendJson(
      res,
      error.status || 400,
      {
        error: error.code || error.message || 'pvp_request_failed',
        ...(error.details && typeof error.details === 'object' ? error.details : {})
      },
      getPvpCorsHeaders(req)
    );
  }

  async function readPvpBody(req, res) {
    try {
      return await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, {
        error: error.message === 'request_too_large' ? 'request_too_large' : 'invalid_json'
      });
      return null;
    }
  }

  async function handlePvpBootstrap(req, res) {
    const payload = await requirePvpUser(req, res);
    if (!payload) return;

    const userKey = getUserKey(payload.user);
    sendJson(
      res,
      200,
      pvpService.buildBootstrapPayload({
        userKey,
        wsUrl: getRequestWebSocketUrl(req, oauthConfig.baseUrl, '/ws/pvp'),
        config: payload.pvpConfig
      }),
      getPvpCorsHeaders(req)
    );
  }

  async function handlePvpCreateRoom(req, res) {
    const payload = await requirePvpUser(req, res);
    if (!payload) return;

    const body = await readPvpBody(req, res);
    if (!body) return;

    try {
      const result = await pvpService.createRoom({
        userKey: getUserKey(payload.user),
        user: summarizeUser(payload.user),
        mode: body.mode,
        mapSelection: body.mapSelection
      });
      sendJson(res, 200, result, getPvpCorsHeaders(req));
    } catch (error) {
      sendPvpError(req, res, error);
    }
  }

  async function handlePvpJoinRoom(req, res) {
    const payload = await requirePvpUser(req, res);
    if (!payload) return;

    const body = await readPvpBody(req, res);
    if (!body) return;

    try {
      const result = await pvpService.joinRoom({
        userKey: getUserKey(payload.user),
        user: summarizeUser(payload.user),
        roomCode: body.roomCode
      });
      sendJson(res, 200, result, getPvpCorsHeaders(req));
    } catch (error) {
      sendPvpError(req, res, error);
    }
  }

  async function handlePvpSpectateRoom(req, res) {
    const payload = await requirePvpUser(req, res);
    if (!payload) return;

    const body = await readPvpBody(req, res);
    if (!body) return;

    try {
      const result = await pvpService.spectateRoom({
        userKey: getUserKey(payload.user),
        user: summarizeUser(payload.user),
        roomCode: body.roomCode,
        wsUrl: getRequestWebSocketUrl(req, oauthConfig.baseUrl, '/ws/pvp')
      });
      sendJson(res, 200, result, getPvpCorsHeaders(req));
    } catch (error) {
      sendPvpError(req, res, error);
    }
  }

  async function handlePvpLeaveRoom(req, res) {
    const payload = await requirePvpUser(req, res);
    if (!payload) return;

    try {
      const result = await pvpService.leaveRoom({
        userKey: getUserKey(payload.user)
      });
      sendJson(res, 200, result, getPvpCorsHeaders(req));
    } catch (error) {
      sendPvpError(req, res, error);
    }
  }

  async function handlePvpLeaveSpectate(req, res) {
    const payload = await requirePvpUser(req, res);
    if (!payload) return;

    try {
      const result = await pvpService.leaveSpectate({
        userKey: getUserKey(payload.user),
        wsUrl: getRequestWebSocketUrl(req, oauthConfig.baseUrl, '/ws/pvp')
      });
      sendJson(res, 200, result, getPvpCorsHeaders(req));
    } catch (error) {
      sendPvpError(req, res, error);
    }
  }

  async function handlePvpSetReady(req, res) {
    const payload = await requirePvpUser(req, res);
    if (!payload) return;

    const body = await readPvpBody(req, res);
    if (!body) return;

    try {
      const result = await pvpService.setReady({
        userKey: getUserKey(payload.user),
        ready: body.ready
      });
      sendJson(res, 200, result, getPvpCorsHeaders(req));
    } catch (error) {
      sendPvpError(req, res, error);
    }
  }

  async function handlePvpStartRoom(req, res) {
    const payload = await requirePvpUser(req, res);
    if (!payload) return;

    try {
      const result = await pvpService.startRoom({
        userKey: getUserKey(payload.user),
        wsUrl: getRequestWebSocketUrl(req, oauthConfig.baseUrl, '/ws/pvp')
      });
      sendJson(res, 200, result, getPvpCorsHeaders(req));
    } catch (error) {
      sendPvpError(req, res, error);
    }
  }

  async function handlePvpEnqueue(req, res) {
    const payload = await requirePvpUser(req, res);
    if (!payload) return;

    const body = await readPvpBody(req, res);
    if (!body) return;

    try {
      const result = await pvpService.enqueue({
        userKey: getUserKey(payload.user),
        user: summarizeUser(payload.user),
        mode: body.mode,
        mapSelection: body.mapSelection
      });
      sendJson(res, 200, result, getPvpCorsHeaders(req));
    } catch (error) {
      sendPvpError(req, res, error);
    }
  }

  async function handlePvpCancelMatchmaking(req, res) {
    const payload = await requirePvpUser(req, res);
    if (!payload) return;

    try {
      const result = await pvpService.cancelQueue({
        userKey: getUserKey(payload.user)
      });
      sendJson(res, 200, result, getPvpCorsHeaders(req));
    } catch (error) {
      sendPvpError(req, res, error);
    }
  }

  async function serveStatic(req, res, requestUrl) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendMethodNotAllowed(res);
      return;
    }

    let relativePath = decodeURIComponent(requestUrl.pathname);
    if (relativePath === '/') {
      relativePath = '/index.html';
    }

    const blocked =
      relativePath.startsWith('/data/') ||
      relativePath.startsWith('/server/') ||
      relativePath.startsWith('/.git') ||
      relativePath === '/.env' ||
      relativePath === '/server.mjs' ||
      relativePath === '/package.json' ||
      relativePath === '/ecosystem.config.cjs';

    if (blocked) {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }

    const filePath = path.resolve(rootDir, `.${relativePath}`);
    if (!filePath.startsWith(rootDir)) {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }

    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }

      res.writeHead(200, {
        'Cache-Control': relativePath.endsWith('.html') ? 'no-store' : 'public, max-age=3600',
        'Content-Length': stat.size,
        'Content-Type': getMimeType(filePath)
      });

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      createReadStream(filePath).pipe(res);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      throw error;
    }
  }

  async function handleRequest(req, res) {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

    if (req.method === 'OPTIONS' && requestUrl.pathname.startsWith('/api/pvp/')) {
      sendPvpPreflight(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/health') {
      await handleHealth(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/auth/session') {
      await handleSession(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/pvp/event' && req.method === 'GET') {
      await handlePvpEvent(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/pvp/event/signup' && req.method === 'POST') {
      await handlePvpEventSignup(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/pvp/edge-token' && req.method === 'GET') {
      await handlePvpEdgeToken(req, res);
      return;
    }

    if (requestUrl.pathname === '/auth/logout') {
      await handleLogout(req, res);
      return;
    }

    if (requestUrl.pathname === '/auth/linuxdo/start') {
      await handleOAuthStart(req, res, requestUrl);
      return;
    }

    if (requestUrl.pathname === '/auth/linuxdo/callback') {
      await handleOAuthCallback(req, res, requestUrl);
      return;
    }

    if (requestUrl.pathname === '/api/cdks/me') {
      await handleGetMyCdk(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/awards/matches/start') {
      await handleStartMatchAward(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/awards/prepare') {
      await handlePrepareMatchAward(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/cdks/claim') {
      await handleClaimCdk(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/admin/cdks' && req.method === 'GET') {
      await handleAdminListCdks(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/admin/cdks' && req.method === 'POST') {
      await handleAdminAddCdks(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/admin/reward-policy' && req.method === 'GET') {
      await handleAdminGetRewardPolicy(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/admin/reward-policy' && req.method === 'POST') {
      await handleAdminSaveRewardPolicy(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/admin/pvp-config' && req.method === 'GET') {
      await handleAdminGetPvpConfig(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/admin/pvp-config' && req.method === 'POST') {
      await handleAdminSavePvpConfig(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/admin/pvp-event' && req.method === 'GET') {
      await handleAdminGetPvpEvent(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/admin/pvp-event' && req.method === 'POST') {
      await handleAdminSavePvpEvent(req, res);
      return;
    }

    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      requestUrl.pathname.startsWith('/api/admin/replays/')
    ) {
      const suffix = requestUrl.pathname.slice('/api/admin/replays/'.length);
      const [encodedMatchId, action = 'detail'] = suffix.split('/');
      const matchId = decodeURIComponent(encodedMatchId || '');

      if (!matchId) {
        sendJson(res, 400, { error: 'invalid_match_id' });
        return;
      }

      if (action === 'content' && req.method === 'GET') {
        await handleAdminGetReplayContent(req, res, matchId);
        return;
      }

      if (action === 'download') {
        await handleAdminDownloadReplay(req, res, matchId);
        return;
      }

      if (action === 'detail' && req.method === 'GET') {
        await handleAdminGetReplayDetail(req, res, matchId);
        return;
      }
    }

    if (requestUrl.pathname === '/api/pvp/bootstrap' && req.method === 'GET') {
      await handlePvpBootstrap(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/pvp/replays' && req.method === 'GET') {
      await handlePvpListReplays(req, res);
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname.startsWith('/api/pvp/replays/')) {
      const suffix = requestUrl.pathname.slice('/api/pvp/replays/'.length);
      const [encodedMatchId, action = 'detail'] = suffix.split('/');
      const matchId = decodeURIComponent(encodedMatchId || '');

      if (!matchId) {
        sendJson(res, 400, { error: 'invalid_match_id' });
        return;
      }

      if (action === 'content') {
        await handlePvpGetReplayContent(req, res, matchId);
        return;
      }

      if (action === 'detail') {
        await handlePvpGetReplayDetail(req, res, matchId);
        return;
      }
    }

    if (requestUrl.pathname === '/api/pvp/rooms' && req.method === 'POST') {
      await handlePvpCreateRoom(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/pvp/rooms/join' && req.method === 'POST') {
      await handlePvpJoinRoom(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/pvp/rooms/spectate' && req.method === 'POST') {
      await handlePvpSpectateRoom(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/pvp/rooms/leave' && req.method === 'POST') {
      await handlePvpLeaveRoom(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/pvp/rooms/ready' && req.method === 'POST') {
      await handlePvpSetReady(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/pvp/rooms/start' && req.method === 'POST') {
      await handlePvpStartRoom(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/pvp/matchmaking/enqueue' && req.method === 'POST') {
      await handlePvpEnqueue(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/pvp/matchmaking/cancel' && req.method === 'POST') {
      await handlePvpCancelMatchmaking(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/pvp/matches/leave-spectate' && req.method === 'POST') {
      await handlePvpLeaveSpectate(req, res);
      return;
    }

    await serveStatic(req, res, requestUrl);
  }

  async function handleUpgrade(req, socket, head) {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    if (requestUrl.pathname !== '/ws/pvp') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const payload = await getPvpRequestPayload(req, requestUrl);
    if (!payload?.user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    try {
      await pvpService.connectSocket({
        req,
        socket,
        head,
        userKey: getUserKey(payload.user),
        user: summarizeUser(payload.user),
        wsUrl: getRequestWebSocketUrl(req, oauthConfig.baseUrl, '/ws/pvp')
      });
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  }

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      console.error('[server] unhandled error', error);
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: 'internal_server_error',
          message: error.message
        });
        return;
      }
      res.end();
    });
  });
  server.on('upgrade', (req, socket, head) => {
    handleUpgrade(req, socket, head).catch(() => {
      socket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n');
      socket.destroy();
    });
  });

  let serverUrl = '';

  return {
    server,
    get url() {
      return serverUrl;
    },
    async start() {
      await ensureDataFiles();
      pvpSweepTimer = setInterval(() => {
        pvpService.cleanup().catch(() => {});
      }, pvpSweepIntervalMs);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });

      const address = server.address();
      const resolvedHost = host === '0.0.0.0' ? '127.0.0.1' : host;
      serverUrl = `http://${resolvedHost}:${address.port}`;
      return serverUrl;
    },
    async close() {
      if (pvpSweepTimer) {
        clearInterval(pvpSweepTimer);
        pvpSweepTimer = null;
      }
      pvpService.closeAll();
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}
