import './admin-pvp-panel.js?v=20260325-pvp-balance-1';
import { createAdminReplayViewer } from './admin-replay-panel.js?v=20260326-admin-replay-1';

const elements = {
  gatePanel: document.getElementById('gatePanel'),
  gateText: document.getElementById('gateText'),
  adminApp: document.getElementById('adminApp'),
  loginLink: document.getElementById('loginLink'),
  logoutButton: document.getElementById('logoutButton'),
  refreshButton: document.getElementById('refreshButton'),
  sessionText: document.getElementById('sessionText'),
  sessionAvatar: document.getElementById('sessionAvatar'),
  awardSecurityText: document.getElementById('awardSecurityText'),
  cdkForm: document.getElementById('cdkForm'),
  cdkPool: document.getElementById('cdkPool'),
  batchNote: document.getElementById('batchNote'),
  cdkBulkText: document.getElementById('cdkBulkText'),
  clearButton: document.getElementById('clearButton'),
  formMessage: document.getElementById('formMessage'),
  rewardPolicyForm: document.getElementById('rewardPolicyForm'),
  rewardTimeZone: document.getElementById('rewardTimeZone'),
  rewardPveNovice: document.getElementById('rewardPveNovice'),
  rewardPveEasy: document.getElementById('rewardPveEasy'),
  rewardPveNormal: document.getElementById('rewardPveNormal'),
  rewardPveHard: document.getElementById('rewardPveHard'),
  rewardPvpDefault: document.getElementById('rewardPvpDefault'),
  rewardPolicySummaryText: document.getElementById('rewardPolicySummaryText'),
  rewardPolicyOverrideText: document.getElementById('rewardPolicyOverrideText'),
  rewardPolicyMessage: document.getElementById('rewardPolicyMessage'),
  rewardPolicyResetButton: document.getElementById('rewardPolicyResetButton'),
  statTotal: document.getElementById('statTotal'),
  statAvailable: document.getElementById('statAvailable'),
  statAssigned: document.getElementById('statAssigned'),
  poolSummaryText: document.getElementById('poolSummaryText'),
  cdkTableBody: document.getElementById('cdkTableBody'),
  matchSummaryText: document.getElementById('matchSummaryText'),
  matchTableBody: document.getElementById('matchTableBody')
};

const adminState = {
  storedRewardPolicy: null,
  rewardPolicy: null,
  rewardPolicyOverrides: null,
  replay: {
    openMatchId: null,
    detail: null,
    content: null,
    frameIndex: 0,
    selectedUserId: '',
    bounds: null,
    playing: false,
    timer: null
  },
  bootstrapInFlight: false,
  lastBootstrapAt: 0
};

const ADMIN_SYNC_COOLDOWN_MS = 1000;
const replayViewer = createAdminReplayViewer({ apiRequest, formatDate });

function getReturnTo() {
  return encodeURIComponent(`${window.location.pathname}${window.location.search}` || '/admin.html');
}

function resolveRewardPool(value, fallback = 'pve') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();

  if (!normalized) return fallback;
  if (normalized === 'pvp') return 'pvp';
  if (normalized === 'pve') return 'pve';
  if (normalized.includes('pvp') || normalized.includes('versus') || normalized.includes('vs')) {
    return 'pvp';
  }
  return fallback;
}

function resolveCodePool(value, fallback = 'pve') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();

  if (!normalized) return fallback;
  if (normalized === 'pve') return 'pve';
  if (normalized === 'pvp_duel') return 'pvp_duel';
  if (normalized === 'pvp_deathmatch') return 'pvp_deathmatch';
  if (normalized === 'pvp') return 'pvp';
  if (normalized.includes('deathmatch')) return 'pvp_deathmatch';
  if (normalized.includes('duel') || normalized.includes('1v1')) return 'pvp_duel';
  if (normalized.includes('pvp') || normalized.includes('versus') || normalized.includes('vs')) {
    return 'pvp';
  }
  return fallback;
}

function getRewardPoolLabel(pool) {
  return resolveRewardPool(pool) === 'pvp' ? 'PVP' : 'PVE';
}

function getCodePoolLabel(pool) {
  const normalized = resolveCodePool(pool);
  if (normalized === 'pvp_duel') return 'PVP 1v1';
  if (normalized === 'pvp_deathmatch') return 'PVP 4人';
  if (normalized === 'pvp') return 'PVP 通用';
  return 'PVE';
}

function getPoolLabel(pool) {
  const codePool = resolveCodePool(pool, '');
  return codePool ? getCodePoolLabel(codePool) : getRewardPoolLabel(pool);
}

function getPoolBadgeClass(pool) {
  const codePool = resolveCodePool(pool, '');
  if (codePool === 'pvp_duel') return 'pool-pvp_duel';
  if (codePool === 'pvp_deathmatch') return 'pool-pvp_deathmatch';
  if (codePool === 'pvp') return 'pool-pvp_legacy';
  return `pool-${resolveRewardPool(pool)}`;
}

function formatAwardSecuritySummary(awardSecurity) {
  if (!awardSecurity) {
    return '当前发码模式未知。';
  }

  if (awardSecurity.requiresServerVerification) {
    return '当前发码模式：已关闭客户端战绩自动发码，未通过服务端验证的对局会被拦截。' +
      ' 如需恢复自动发码，请在线上环境设置 ALLOW_CLIENT_REPORTED_AWARDS=true 并重启服务。';
  }

  return '当前发码模式：客户端战绩自动发码已开启。' +
    ' 当前运行的是 legacy_client_reported 模式，恢复运营的同时仍需关注异常领奖记录。';
}

function formatRewardPolicySummary(policy) {
  if (!policy?.dailyLimits) {
    return '发码规则加载中...';
  }

  const pve = policy.dailyLimits.pve || {};
  const pvp = policy.dailyLimits.pvp || {};
  const timeZone = policy.timeZone || 'Asia/Shanghai';

  return [
    `时区 ${timeZone}`,
    `PVE 每日上限: novice ${Number(pve.novice || 0)} / easy ${Number(pve.easy || 0)} / normal ${Number(pve.normal || 0)} / hard ${Number(pve.hard || 0)}`,
    `PVP 每日上限: ${Number(pvp.default || 0)}`
  ].join(' | ');
}

async function parseResponse(response) {
  let payload = {};

  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const error = new Error(payload.error || payload.message || `request_failed_${response.status}`);
    error.payload = payload;
    throw error;
  }

  return payload;
}

async function apiRequest(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');

  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers
  });

  return parseResponse(response);
}

function setFormMessage(message, tone = '') {
  elements.formMessage.textContent = message || '';
  elements.formMessage.className = tone ? `message ${tone}` : 'message';
}

function setRewardPolicyMessage(message, tone = '') {
  if (!elements.rewardPolicyMessage) return;
  elements.rewardPolicyMessage.textContent = message || '';
  elements.rewardPolicyMessage.className = tone ? `message ${tone}` : 'message';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatPoolSummary(summary) {
  const pve = summary?.byPool?.pve || {};
  const pvp = summary?.byPool?.pvp || {};
  const pvpDuel = summary?.byPool?.pvp_duel || {};
  const pvpDeathmatch = summary?.byPool?.pvp_deathmatch || {};
  const pvpLegacy = summary?.byPool?.pvp_legacy || {};

  return [
    `PVE: 总数 ${Number(pve.total || 0)} / 可派发 ${Number(pve.available || 0)} / 已派发 ${Number(pve.assigned || 0)}`,
    `PVP 总计: 总数 ${Number(pvp.total || 0)} / 可派发 ${Number(pvp.available || 0)} / 已派发 ${Number(pvp.assigned || 0)}`,
    `PVP 1v1: 总数 ${Number(pvpDuel.total || 0)} / 可派发 ${Number(pvpDuel.available || 0)} / 已派发 ${Number(pvpDuel.assigned || 0)}`,
    `PVP 4人: 总数 ${Number(pvpDeathmatch.total || 0)} / 可派发 ${Number(pvpDeathmatch.available || 0)} / 已派发 ${Number(pvpDeathmatch.assigned || 0)}`,
    `PVP 通用: 总数 ${Number(pvpLegacy.total || 0)} / 可派发 ${Number(pvpLegacy.available || 0)} / 已派发 ${Number(pvpLegacy.assigned || 0)}`
  ].join(' | ');
}

function formatMatchPoolSummary(summary) {
  const pve = summary?.byPool?.pve || {};
  const pvp = summary?.byPool?.pvp || {};

  return [
    `PVE: 总局数 ${Number(pve.total || 0)} / 可领奖 ${Number(pve.eligible || 0)} / 已领奖 ${Number(pve.claimed || 0)}`,
    `PVP: 总局数 ${Number(pvp.total || 0)} / 可领奖 ${Number(pvp.eligible || 0)} / 已领奖 ${Number(pvp.claimed || 0)}`
  ].join(' | ');
}

function getLocalizedStatus(status) {
  if (status === 'available') return '可派发';
  if (status === 'assigned') return '已派发';
  return status || '-';
}

function getRewardStatusText(status) {
  if (status === 'claimed') return '已领奖';
  if (status === 'ready') return '待领奖';
  return '不发奖';
}

function getOutcomeText(summary) {
  if (!summary) return '未知';
  if (summary.eligibleForAward) return '胜方 MVP';
  if (summary.playerWon) return '获胜但非 MVP';
  return '不在胜方';
}

function formatMode(summary) {
  if (!summary) return '-';
  const parts = [summary.gameMode, summary.difficulty].filter(Boolean);
  return parts.length ? parts.join(' / ') : '-';
}

function formatStats(summary) {
  const stats = summary?.playerStats;
  if (!stats) return '-';
  return `${Number(stats.kills || 0)}K / ${Number(stats.deaths || 0)}D / ${Number(stats.damageDealt || 0)} DMG`;
}

function formatBytes(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) return null;
  if (size < 1024) return `${Math.round(size)} B`;

  const units = ['KB', 'MB', 'GB'];
  let current = size / 1024;
  let unitIndex = 0;
  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }
  return `${current.toFixed(current >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatReplaySummary(replay) {
  if (!replay) return null;

  const statusText =
    replay.status === 'failed'
      ? '回放失败'
      : replay.available
        ? '回放就绪'
        : replay.status === 'missing'
          ? '回放缺失'
          : `回放: ${replay.status || 'unknown'}`;

  const details = [
    statusText,
    formatBytes(replay.sizeBytes),
    replay.fileName || replay.relativePath || null,
    replay.snapshotCount ? `${Number(replay.snapshotCount)} 帧` : null,
    replay.eventCount ? `${Number(replay.eventCount)} 事件` : null
  ].filter(Boolean);

  if (!replay.available && replay.error) {
    details.push(replay.error);
  }

  return details.join(' | ');
}

function renderSession(session) {
  const returnTo = `/auth/linuxdo/start?returnTo=${getReturnTo()}`;
  elements.loginLink.href = returnTo;
  if (elements.awardSecurityText) {
    elements.awardSecurityText.textContent = formatAwardSecuritySummary(session.awardSecurity);
  }

  if (!session.authenticated) {
    elements.loginLink.classList.remove('hidden');
    elements.logoutButton.classList.add('hidden');
    elements.refreshButton.classList.add('hidden');
    elements.sessionText.textContent = session.oauthConfigured ? '未登录' : 'OAuth 未配置';
    elements.sessionAvatar.classList.add('hidden');
    return;
  }

  elements.loginLink.classList.add('hidden');
  elements.logoutButton.classList.remove('hidden');
  elements.refreshButton.classList.remove('hidden');
  elements.sessionText.textContent = session.user?.username || session.user?.displayName || '已登录';

  if (session.user?.avatarUrl) {
    elements.sessionAvatar.src = session.user.avatarUrl;
    elements.sessionAvatar.alt = session.user.username || session.user.displayName || 'avatar';
    elements.sessionAvatar.classList.remove('hidden');
  } else {
    elements.sessionAvatar.classList.add('hidden');
  }
}

function renderGate(session) {
  elements.adminApp.classList.add('hidden');
  elements.gatePanel.classList.remove('hidden');
  elements.gateText.textContent = !session.authenticated
    ? '请使用已加入管理员名单的 Linux.do 账号登录后台。'
    : '当前 Linux.do 账号已登录，但不在管理员白名单中。';
}

function renderStats(summary, rewardPolicy) {
  elements.statTotal.textContent = String(summary.total || 0);
  elements.statAvailable.textContent = String(summary.available || 0);
  elements.statAssigned.textContent = String(summary.assigned || 0);

  if (elements.poolSummaryText) {
    elements.poolSummaryText.textContent = `${formatRewardPolicySummary(rewardPolicy)} | ${formatPoolSummary(summary)}`;
  }
}

function renderCdkTable(items) {
  if (!items.length) {
    elements.cdkTableBody.innerHTML = '<tr><td colspan="6">还没有导入任何兑换码。</td></tr>';
    return;
  }

  const rows = items
    .map((item) => {
      const claimedBy = item.claimedBy?.username || item.claimedBy?.displayName || '-';
      const statusText = getLocalizedStatus(item.status);
      const poolLabel = getPoolLabel(item.pool);
      const poolClass = getPoolBadgeClass(item.pool);

      return `<tr>
        <td><span class="status ${escapeHtml(item.status)}">${escapeHtml(statusText)}</span></td>
        <td><span class="status ${escapeHtml(poolClass)}">${escapeHtml(poolLabel)}</span></td>
        <td><code>${escapeHtml(item.code)}</code></td>
        <td>${escapeHtml(item.note || '-')}</td>
        <td>${escapeHtml(claimedBy)}</td>
        <td>${escapeHtml(formatDate(item.claimedAt))}</td>
      </tr>`;
    })
    .join('');

  elements.cdkTableBody.innerHTML = rows;
}

function renderMatchTable(items, summary) {
  const matchTotal = Number(summary?.total || 0);
  const claimedCount = Number(summary?.claimed || 0);
  const eligibleCount = Number(summary?.eligible || 0);

  if (elements.matchSummaryText) {
    elements.matchSummaryText.textContent =
      `共追踪 ${matchTotal} 局 | 可领奖 ${eligibleCount} 局 | 已领奖 ${claimedCount} 局 | ${formatMatchPoolSummary(summary)}`;
  }

  if (!elements.matchTableBody) return;

  if (!items.length) {
    elements.matchTableBody.innerHTML = '<tr><td colspan="7">还没有对局历史。</td></tr>';
    return;
  }

  const rows = items
    .map((item) => {
      const playerName = item.user?.username || item.user?.displayName || '-';
      const summaryData = item.summary || null;
      const rewardStatus = item.rewardStatus || 'not_eligible';
      const rewardText = item.assignedCode
        ? `${getRewardStatusText(rewardStatus)} | ${item.assignedCode}`
        : getRewardStatusText(rewardStatus);
      const poolValue = item.pool || summaryData?.codePool || summaryData?.rewardPool || summaryData?.matchType;
      const poolLabel = getPoolLabel(poolValue);
      const poolClass = getPoolBadgeClass(poolValue);
      const metaText = [
        summaryData?.mvpName ? `MVP: ${summaryData.mvpName}` : null,
        summaryData?.matchDurationSeconds != null ? `${summaryData.matchDurationSeconds}s` : null,
        formatStats(summaryData),
        formatReplaySummary(item.replay)
      ]
        .filter(Boolean)
        .join(' | ');
      const replayAction = replayViewer.getActionMarkup(item.replay);

      return `<tr>
        <td>${escapeHtml(formatDate(item.completedAt || item.recordedAt))}</td>
        <td>${escapeHtml(playerName)}</td>
        <td><span class="status ${escapeHtml(poolClass)}">${escapeHtml(poolLabel)}</span></td>
        <td>
          <div class="cell-stack">
            <strong>${escapeHtml(formatMode(summaryData))}</strong>
            <span class="minor">${escapeHtml(metaText || '-')}</span>
            ${replayAction}
          </div>
        </td>
        <td>${escapeHtml(getOutcomeText(summaryData))}</td>
        <td><span class="status ${escapeHtml(rewardStatus)}">${escapeHtml(rewardText)}</span></td>
        <td><code>${escapeHtml(item.ticketId || '-')}</code></td>
      </tr>`;
    })
    .join('');

  elements.matchTableBody.innerHTML = rows;
}

function populateRewardPolicyForm(policy) {
  if (!policy) return;

  const pve = policy.dailyLimits?.pve || {};
  const pvp = policy.dailyLimits?.pvp || {};

  if (elements.rewardTimeZone) {
    elements.rewardTimeZone.value = policy.timeZone || 'Asia/Shanghai';
  }
  if (elements.rewardPveNovice) {
    elements.rewardPveNovice.value = String(Number(pve.novice || 0));
  }
  if (elements.rewardPveEasy) {
    elements.rewardPveEasy.value = String(Number(pve.easy || 0));
  }
  if (elements.rewardPveNormal) {
    elements.rewardPveNormal.value = String(Number(pve.normal || 0));
  }
  if (elements.rewardPveHard) {
    elements.rewardPveHard.value = String(Number(pve.hard || 0));
  }
  if (elements.rewardPvpDefault) {
    elements.rewardPvpDefault.value = String(Number(pvp.default || 0));
  }
}

function getOverrideSourceLabel(source) {
  if (source === 'env') return '环境变量';
  if (source === 'runtime') return '运行时参数';
  return '运行时配置';
}

function collectRewardPolicyOverrideLabels(overrideState) {
  const sources = overrideState?.sources || {};
  const labels = [];

  if (sources.timeZone) {
    labels.push(`时区(${getOverrideSourceLabel(sources.timeZone)})`);
  }

  if (sources.dailyLimits?.pve?.novice) {
    labels.push(`PVE novice(${getOverrideSourceLabel(sources.dailyLimits.pve.novice)})`);
  }
  if (sources.dailyLimits?.pve?.easy) {
    labels.push(`PVE easy(${getOverrideSourceLabel(sources.dailyLimits.pve.easy)})`);
  }
  if (sources.dailyLimits?.pve?.normal) {
    labels.push(`PVE normal(${getOverrideSourceLabel(sources.dailyLimits.pve.normal)})`);
  }
  if (sources.dailyLimits?.pve?.hard) {
    labels.push(`PVE hard(${getOverrideSourceLabel(sources.dailyLimits.pve.hard)})`);
  }
  if (sources.dailyLimits?.pvp?.default) {
    labels.push(`PVP default(${getOverrideSourceLabel(sources.dailyLimits.pvp.default)})`);
  }

  return labels;
}

function renderRewardPolicy(storedRewardPolicy, rewardPolicy, rewardPolicyOverrides) {
  adminState.storedRewardPolicy = storedRewardPolicy || rewardPolicy || null;
  adminState.rewardPolicy = rewardPolicy || storedRewardPolicy || null;
  adminState.rewardPolicyOverrides = rewardPolicyOverrides || null;

  populateRewardPolicyForm(adminState.storedRewardPolicy || adminState.rewardPolicy);

  if (elements.rewardPolicySummaryText) {
    const storedText = adminState.storedRewardPolicy
      ? `后台保存值: ${formatRewardPolicySummary(adminState.storedRewardPolicy)}`
      : '后台保存值加载中...';
    const effectiveText = adminState.rewardPolicy
      ? `当前生效值: ${formatRewardPolicySummary(adminState.rewardPolicy)}`
      : '当前生效值加载中...';
    elements.rewardPolicySummaryText.textContent = `${storedText} | ${effectiveText}`;
  }

  if (elements.rewardPolicyOverrideText) {
    const labels = collectRewardPolicyOverrideLabels(rewardPolicyOverrides);
    elements.rewardPolicyOverrideText.textContent = labels.length
      ? `注意: 以下字段被运行时配置覆盖，后台保存会写入 data/app-config.json，但线上实际仍以覆盖值为准: ${labels.join('、')}`
      : '当前没有 REWARD_LIMIT_* 覆盖，后台保存后会立即写入 data/app-config.json 并生效。';
  }
}

function readNonNegativeIntegerInput(element) {
  const value = Number(element?.value);
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function readRewardPolicyFormValue() {
  return {
    timeZone: String(elements.rewardTimeZone?.value || '').trim() || 'Asia/Shanghai',
    dailyLimits: {
      pve: {
        novice: readNonNegativeIntegerInput(elements.rewardPveNovice),
        easy: readNonNegativeIntegerInput(elements.rewardPveEasy),
        normal: readNonNegativeIntegerInput(elements.rewardPveNormal),
        hard: readNonNegativeIntegerInput(elements.rewardPveHard)
      },
      pvp: {
        default: readNonNegativeIntegerInput(elements.rewardPvpDefault)
      }
    }
  };
}

async function refreshAdminData() {
  const [cdkResult, rewardPolicyResult] = await Promise.all([
    apiRequest('/api/admin/cdks'),
    apiRequest('/api/admin/reward-policy')
  ]);

  const rewardPolicy = rewardPolicyResult.rewardPolicy || cdkResult.rewardPolicy || null;
  renderStats(cdkResult.summary || {}, rewardPolicy);
  renderCdkTable(Array.isArray(cdkResult.items) ? cdkResult.items : []);
  renderMatchTable(Array.isArray(cdkResult.matches) ? cdkResult.matches : [], cdkResult.matchSummary || {});
  renderRewardPolicy(
    rewardPolicyResult.storedRewardPolicy || cdkResult.storedRewardPolicy || rewardPolicy,
    rewardPolicy,
    rewardPolicyResult.rewardPolicyOverrides || cdkResult.rewardPolicyOverrides || null
  );
}

async function bootstrap() {
  if (adminState.bootstrapInFlight) {
    return;
  }

  adminState.bootstrapInFlight = true;
  adminState.lastBootstrapAt = Date.now();

  try {
    const session = await apiRequest('/api/auth/session');
    renderSession(session);

    if (!session.authenticated || !session.isAdmin) {
      renderGate(session);
      return;
    }

    elements.gatePanel.classList.add('hidden');
    elements.adminApp.classList.remove('hidden');
    await refreshAdminData();
  } catch (error) {
    renderGate({ authenticated: false });
    elements.gateText.textContent = `后台暂不可用: ${error.message}`;
  } finally {
    adminState.bootstrapInFlight = false;
  }
}

function syncAdminIfStale() {
  if (document.visibilityState === 'hidden') {
    return;
  }

  if (adminState.bootstrapInFlight) {
    return;
  }

  if (Date.now() - adminState.lastBootstrapAt < ADMIN_SYNC_COOLDOWN_MS) {
    return;
  }

  void bootstrap();
}

async function importCodes(event) {
  event.preventDefault();

  const pool = resolveCodePool(elements.cdkPool?.value);
  setFormMessage(`正在导入 ${getPoolLabel(pool)} 兑换码...`);

  try {
    const result = await apiRequest('/api/admin/cdks', {
      method: 'POST',
      body: JSON.stringify({
        pool,
        note: elements.batchNote.value,
        bulkText: elements.cdkBulkText.value
      })
    });

    const message = [
      `${getPoolLabel(result.pool)} 奖池已导入 ${result.addedCount} 个兑换码。`,
      result.skippedCount ? `跳过 ${result.skippedCount} 个重复兑换码。` : ''
    ]
      .filter(Boolean)
      .join(' ');

    setFormMessage(message, 'ok');
    elements.cdkBulkText.value = '';
    await refreshAdminData();
  } catch (error) {
    const tone = error.message === 'missing_codes' ? 'warn' : 'error';
    const message =
      error.message === 'missing_codes'
        ? '请先粘贴至少一个兑换码再导入。'
        : error.message;
    setFormMessage(message, tone);
  }
}

async function saveRewardPolicy(event) {
  event.preventDefault();
  setRewardPolicyMessage('正在保存发码规则...');

  try {
    await apiRequest('/api/admin/reward-policy', {
      method: 'POST',
      body: JSON.stringify(readRewardPolicyFormValue())
    });

    await refreshAdminData();
    setRewardPolicyMessage('发码规则已保存。', 'ok');
  } catch (error) {
    setRewardPolicyMessage(error.message, 'error');
  }
}

function resetRewardPolicyForm() {
  if (adminState.storedRewardPolicy) {
    populateRewardPolicyForm(adminState.storedRewardPolicy);
    setRewardPolicyMessage('已恢复为当前已保存的配置。');
    return;
  }

  if (adminState.rewardPolicy) {
    populateRewardPolicyForm(adminState.rewardPolicy);
    setRewardPolicyMessage('已恢复为当前生效的配置。');
    return;
  }

  setRewardPolicyMessage('还没有可恢复的规则。', 'warn');
}

async function logout() {
  try {
    await apiRequest('/auth/logout', { method: 'POST' });
    window.location.reload();
  } catch (error) {
    setFormMessage(error.message, 'error');
  }
}

function bindEvents() {
  elements.cdkForm?.addEventListener('submit', importCodes);
  elements.rewardPolicyForm?.addEventListener('submit', saveRewardPolicy);
  elements.rewardPolicyResetButton?.addEventListener('click', resetRewardPolicyForm);
  elements.clearButton?.addEventListener('click', () => {
    if (elements.cdkPool) {
      elements.cdkPool.value = 'pve';
    }
    elements.batchNote.value = '';
    elements.cdkBulkText.value = '';
    setFormMessage('');
  });
  elements.refreshButton?.addEventListener('click', refreshAdminData);
  elements.logoutButton?.addEventListener('click', logout);
  elements.matchTableBody?.addEventListener('click', replayViewer.handleClick);
  window.addEventListener('pageshow', syncAdminIfStale);
  window.addEventListener('focus', syncAdminIfStale);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      syncAdminIfStale();
    }
  });
}

bindEvents();
bootstrap();
