const ASSET_VERSION =
  document.querySelector('meta[name="shooters-asset-version"]')?.getAttribute('content') ||
  window.__SHOOTERS_ASSET_VERSION__ ||
  'dev';

void import(`./pvp-panel.js?v=${encodeURIComponent(ASSET_VERSION)}`);

const elements = {
  root: document.getElementById('accountPanel'),
  title: document.getElementById('accountStatusTitle'),
  meta: document.getElementById('accountStatusMeta'),
  loginButton: document.getElementById('accountLoginBtn'),
  claimButton: document.getElementById('accountClaimBtn'),
  logoutButton: document.getElementById('accountLogoutBtn'),
  adminLink: document.getElementById('accountAdminLink'),
  codeCard: document.getElementById('accountCodeCard'),
  codeLabel: document.getElementById('accountCodeLabel'),
  codeValue: document.getElementById('accountCodeValue'),
  copyButton: document.getElementById('accountCopyBtn'),
  feedback: document.getElementById('accountFeedback'),
  matchPanel: document.getElementById('matchAwardPanel'),
  matchTitle: document.getElementById('matchAwardTitle'),
  matchMeta: document.getElementById('matchAwardMeta'),
  matchClaimButton: document.getElementById('matchAwardClaimBtn'),
  matchCodeCard: document.getElementById('matchAwardCodeCard'),
  matchCodeValue: document.getElementById('matchAwardCodeValue'),
  matchCopyButton: document.getElementById('matchAwardCopyBtn'),
  matchFeedback: document.getElementById('matchAwardFeedback')
};

const model = {
  session: null,
  rewards: null,
  currentMatchTicket: null,
  latestMatchSummary: null,
  preparingAward: false,
  refreshInFlight: false,
  lastRefreshAt: 0
};

const PANEL_SYNC_COOLDOWN_MS = 1000;

function getReturnTo() {
  const path = `${window.location.pathname}${window.location.search}`;
  return encodeURIComponent(path || '/');
}

function resolveRewardPool(value, fallback = 'pve') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();

  if (!normalized) return fallback;
  if (normalized === 'pvp') return 'pvp';
  if (normalized === 'pve') return 'pve';
  if (normalized === 'pvp_duel' || normalized === 'pvp_deathmatch') return 'pvp';
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

function getSummaryRewardPool(summary) {
  return resolveRewardPool(summary?.rewardPool || summary?.matchType || summary?.codePool || summary?.gameMode, 'pve');
}

function getSummaryCodePool(summary) {
  const explicitPool = resolveCodePool(summary?.codePool || '', '');
  if (explicitPool) {
    return explicitPool;
  }
  const inferredModePool = resolveCodePool(summary?.gameMode || '', '');
  if (inferredModePool === 'pvp_duel' || inferredModePool === 'pvp_deathmatch') {
    return inferredModePool;
  }
  if (getSummaryRewardPool(summary) === 'pvp') {
    return summary?.gameMode === 'deathmatch' ? 'pvp_deathmatch' : 'pvp_duel';
  }
  return 'pve';
}

function getRewardPoolLabel(pool) {
  return resolveRewardPool(pool) === 'pvp' ? 'PVP' : 'PVE';
}

function getCodePoolLabel(pool) {
  const normalized = resolveCodePool(pool);
  if (normalized === 'pvp_duel') return 'PVP 1v1';
  if (normalized === 'pvp_deathmatch') return 'PVP 4人';
  if (normalized === 'pvp') return 'PVP';
  return 'PVE';
}

function getPoolLabel(pool) {
  const codePool = resolveCodePool(pool, '');
  return codePool ? getCodePoolLabel(codePool) : getRewardPoolLabel(pool);
}

function getDifficultyLabel(difficulty) {
  if (difficulty === 'hard') return '困难';
  if (difficulty === 'normal') return '普通';
  if (difficulty === 'easy') return '简单';
  if (difficulty === 'novice') return '新手';
  return '默认';
}

function getRewardPoolDescription(pool) {
  const normalizedCodePool = resolveCodePool(pool);
  if (normalizedCodePool === 'pvp_duel') return 'PVP 1v1 奖池';
  if (normalizedCodePool === 'pvp_deathmatch') return 'PVP 4人乱斗奖池';
  return resolveRewardPool(pool) === 'pvp' ? 'PVP 对战奖池' : 'PVE 奖池';
}

function buildPvpSummaryForSession(detail, session) {
  if (!detail || detail.role === 'spectator' || !session?.user?.id) {
    return null;
  }

  const stats = Array.isArray(detail.stats) ? detail.stats : [];
  const playerStat = stats.find((entry) => String(entry.userId) === String(session.user.id)) || null;
  if (!playerStat) {
    return null;
  }

  const mvpStat = stats.find((entry) => String(entry.userId) === String(detail.mvpUserId)) || null;
  const summary = {
    matchType: 'pvp',
    rewardPool: 'pvp',
    codePool: detail.mode === 'deathmatch' ? 'pvp_deathmatch' : 'pvp_duel',
    gameMode: detail.mode || null,
    difficulty: null,
    winnerTeam: detail.winnerTeam || null,
    playerTeam: playerStat.team || null,
    playerWon: Boolean(playerStat.won),
    playerIsMvp: String(playerStat.userId) === String(detail.mvpUserId),
    eligibleForAward: false,
    mvpTeam: mvpStat?.team || detail.winnerTeam || null,
    mvpName: mvpStat?.username || mvpStat?.displayName || null,
    playerName:
      session.user?.username ||
      session.user?.displayName ||
      playerStat.username ||
      playerStat.displayName ||
      'Linux.do 用户',
    awardBlockedReason: null,
    matchDurationSeconds: null,
    playerStats: {
      kills: Number(playerStat.kills || 0),
      deaths: Number(playerStat.deaths || 0),
      damageDealt: Number(playerStat.damageDealt || 0)
    }
  };

  summary.eligibleForAward = Boolean(
    summary.playerWon &&
      summary.playerIsMvp &&
      summary.winnerTeam &&
      summary.playerTeam &&
      summary.winnerTeam === summary.playerTeam
  );

  if (!session.pvpConfig?.rewardEnabled && summary.eligibleForAward) {
    summary.awardBlockedReason = 'pvp_rewards_disabled';
    summary.eligibleForAward = false;
  }

  return summary;
}

function getRewardPolicy(session, rewards) {
  return rewards?.rewardPolicy || session?.rewardPolicy || null;
}

function formatRewardPolicySummary(policy) {
  if (!policy?.dailyLimits) {
    return 'PVE 按难度递减发码，PVP 共用每日额度并按 1v1 / 4人分池发码。';
  }

  const pve = policy.dailyLimits.pve || {};
  const pvp = policy.dailyLimits.pvp || {};
  return (
    `PVE 每日限额：新手 ${Number(pve.novice || 0)} / 简单 ${Number(pve.easy || 0)} / ` +
    `普通 ${Number(pve.normal || 0)} / 困难 ${Number(pve.hard || 0)}。` +
    ` PVP 每日限额：${Number(pvp.default || 0)}。`
  );
}

function formatLimitStatus(limitStatus) {
  if (!limitStatus) return '';

  const poolLabel = getRewardPoolLabel(limitStatus.pool);
  const scopeLabel =
    limitStatus.scope === 'difficulty'
      ? `${poolLabel} ${getDifficultyLabel(limitStatus.difficulty)}`
      : poolLabel;

  return `${scopeLabel} 今日已领 ${Number(limitStatus.used || 0)}/${Number(limitStatus.limit || 0)}，剩余 ${Number(limitStatus.remaining || 0)}。`;
}

function requiresServerVerification(session) {
  return Boolean(session?.awardSecurity?.requiresServerVerification);
}

function getAvailableCountForPool(rewards, pool) {
  const normalizedPool = resolveCodePool(pool);
  const counts = rewards?.availableCounts || null;
  return Number(counts?.[normalizedPool] || 0);
}

async function parseResponse(response) {
  let payload = {};

  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const message = payload.error || payload.message || `request_failed_${response.status}`;
    const error = new Error(message);
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

function setFeedback(message, tone = '') {
  if (!elements.feedback) return;
  elements.feedback.textContent = message || '';
  elements.feedback.dataset.tone = tone;
}

function setMatchFeedback(message, tone = '') {
  if (!elements.matchFeedback) return;
  elements.matchFeedback.textContent = message || '';
  elements.matchFeedback.dataset.tone = tone;
}

function setLoadingState(isLoading) {
  if (elements.claimButton) {
    elements.claimButton.disabled = isLoading;
  }
  if (elements.logoutButton) {
    elements.logoutButton.disabled = isLoading;
  }
  if (elements.copyButton) {
    elements.copyButton.disabled = isLoading;
  }
  if (elements.matchClaimButton) {
    elements.matchClaimButton.disabled = isLoading;
  }
  if (elements.matchCopyButton) {
    elements.matchCopyButton.disabled = isLoading;
  }
}

function renderLatestClaim(latestClaim) {
  const hasCode = Boolean(latestClaim?.code);
  const poolLabel = getPoolLabel(latestClaim?.claimContext?.summary?.codePool || latestClaim?.pool);

  elements.codeCard.hidden = !hasCode;
  elements.copyButton.hidden = !hasCode;

  if (elements.codeLabel) {
    elements.codeLabel.textContent = hasCode ? `最近领取的 ${poolLabel} CDK` : '最近领取的 CDK';
  }

  elements.codeValue.textContent = hasCode ? latestClaim.code : '-';
}

function renderMatchCode(code) {
  const hasCode = Boolean(code);
  elements.matchCodeCard.hidden = !hasCode;
  elements.matchCopyButton.hidden = !hasCode;
  elements.matchCodeValue.textContent = hasCode ? code : '-';
}

function renderSignedOut(session) {
  const oauthConfigured = Boolean(session?.oauthConfigured);
  const hardenedAwards = requiresServerVerification(session);
  const rewardPolicy = getRewardPolicy(session, null);

  elements.title.textContent = 'Linux.do 登录';
  elements.meta.textContent = oauthConfigured
    ? hardenedAwards
      ? '请在开局前先登录。当前已暂停基于客户端战绩的自动发码，需等待服务端验证能力上线。'
      : `请在开局前先登录。${formatRewardPolicySummary(rewardPolicy)}`
    : 'OAuth 尚未配置，请先设置 LINUX_DO_CLIENT_ID 和 LINUX_DO_CLIENT_SECRET。';
  elements.loginButton.hidden = false;
  elements.loginButton.href = `/auth/linuxdo/start?returnTo=${getReturnTo()}`;
  elements.loginButton.classList.toggle('is-disabled', !oauthConfigured);
  elements.claimButton.hidden = true;
  elements.logoutButton.hidden = true;
  elements.adminLink.hidden = true;
  renderLatestClaim(null);
}

function renderSignedIn(session, rewards) {
  const userName = session.user?.username || session.user?.displayName || 'Linux.do 用户';
  const pendingAward = rewards?.pendingAward || session.pendingAward || null;
  const pendingLimitStatus = rewards?.pendingLimitStatus || null;
  const claimCount = Number(rewards?.claimCount || 0);
  const claimCounts = rewards?.claimCounts || { pve: 0, pvp: 0 };
  const hardenedAwards = requiresServerVerification(session);
  const rewardPolicy = getRewardPolicy(session, rewards);

  if (pendingAward) {
    const codePool = rewards?.pendingCodePool || getSummaryCodePool(pendingAward.summary);
    const poolLabel = getCodePoolLabel(codePool);
    const availableCount = Number(rewards?.pendingAvailableCount ?? getAvailableCountForPool(rewards, codePool));
    const remainingClaims = Number(pendingLimitStatus?.remaining ?? 0);

    elements.title.textContent = `${userName} 的 ${poolLabel} 奖励已就绪`;
    elements.meta.textContent =
      availableCount <= 0
        ? `这局已经满足 ${getRewardPoolDescription(codePool)} 的发码条件，但当前该奖励暂时无可领取兑换码。`
        : remainingClaims <= 0
          ? `这局已经满足 ${getRewardPoolDescription(codePool)} 的发码条件，但你今天的领取额度已经用完。${formatLimitStatus(pendingLimitStatus)}`
          : `这局已经满足 ${getRewardPoolDescription(codePool)} 的发码条件，当前该奖励还剩 ${availableCount} 个可领取兑换码。${formatLimitStatus(pendingLimitStatus)}`;

    elements.claimButton.textContent = `领取 ${poolLabel} CDK`;
    elements.claimButton.hidden = false;
    elements.claimButton.disabled = availableCount <= 0 || remainingClaims <= 0;
  } else {
    elements.title.textContent = `当前已登录：${userName}`;
    elements.meta.textContent =
      hardenedAwards
        ? `当前已暂停基于客户端战绩的自动发码，需等待服务端验证能力上线。` +
          ` 你当前累计已领取 ${claimCount} 个兑换码（PVE ${Number(claimCounts.pve || 0)} / PVP ${Number(claimCounts.pvp || 0)}）。`
        : `${formatRewardPolicySummary(rewardPolicy)}` +
          ` 你当前累计已领取 ${claimCount} 个兑换码（PVE ${Number(claimCounts.pve || 0)} / PVP ${Number(claimCounts.pvp || 0)}）。`;
    elements.claimButton.hidden = true;
  }

  elements.loginButton.hidden = true;
  elements.logoutButton.hidden = false;
  elements.adminLink.hidden = !session.isAdmin;
  renderLatestClaim(rewards?.latestClaim || null);
}

function renderMatchOutcomePanel() {
  const summary = model.latestMatchSummary;
  const rewards = model.rewards;
  const session = model.session;
  const pendingAward = rewards?.pendingAward || session?.pendingAward || null;
  const pendingLimitStatus = rewards?.pendingLimitStatus || null;
  const latestClaim = rewards?.latestClaim || null;
  const hardenedAwards = requiresServerVerification(session);

  if (!elements.matchPanel) return;

  if (!summary && !pendingAward) {
    elements.matchPanel.hidden = true;
    renderMatchCode(null);
    return;
  }

  elements.matchPanel.hidden = false;
  renderMatchCode(null);

  if (pendingAward) {
    const codePool = rewards?.pendingCodePool || getSummaryCodePool(pendingAward.summary);
    const poolLabel = getCodePoolLabel(codePool);
    const availableCount = Number(rewards?.pendingAvailableCount ?? getAvailableCountForPool(rewards, codePool));
    const remainingClaims = Number(pendingLimitStatus?.remaining ?? 0);

    elements.matchTitle.textContent = `本局 ${poolLabel} 奖励已准备好`;
    elements.matchMeta.textContent =
      availableCount <= 0
        ? `本局胜方 MVP：${pendingAward.summary?.mvpName || '未知'}。当前 ${poolLabel} 码池为空，请等管理员补码。`
        : remainingClaims <= 0
          ? `本局胜方 MVP：${pendingAward.summary?.mvpName || '未知'}。奖励已为你保留，但你今天的额度已用完。${formatLimitStatus(pendingLimitStatus)}`
          : `本局胜方 MVP：${pendingAward.summary?.mvpName || '未知'}。当前可领取 1 个 ${poolLabel} CDK，${poolLabel} 码池剩余 ${availableCount} 个。${formatLimitStatus(pendingLimitStatus)}`;
    elements.matchClaimButton.textContent = `领取 ${poolLabel} CDK`;
    elements.matchClaimButton.hidden = false;
    elements.matchClaimButton.disabled = availableCount <= 0 || remainingClaims <= 0;
    return;
  }

  elements.matchClaimButton.hidden = true;

  if (!summary) {
    elements.matchTitle.textContent = latestClaim?.code
      ? '你最近领取的 CDK 已显示在下方'
      : hardenedAwards
        ? '当前已暂停自动发码'
        : '当前没有可领取的 MVP 奖励';
    elements.matchMeta.textContent = latestClaim?.code
      ? '你仍然可以在账号卡片里复制最近一次领取到的兑换码。'
      : hardenedAwards
        ? '当前环境要求服务端验证战斗结果；在验证能力上线前，不会根据客户端上报战绩自动派发 CDK。'
        : '开始一局比赛，获胜并拿到 MVP 后，就会按对局类型从对应奖池发出 1 个 CDK。';
    return;
  }

  const rewardPool = getSummaryRewardPool(summary);
  const codePool = getSummaryCodePool(summary);
  const poolLabel = getCodePoolLabel(codePool);

  if (summary.awardBlockedReason) {
    elements.matchTitle.textContent = `这局不符合 ${poolLabel} 发码条件`;
    elements.matchMeta.textContent = getAwardBlockedMessage(summary.awardBlockedReason, codePool);
    return;
  }

  if (!summary.playerWon) {
    elements.matchTitle.textContent = '这局没有获得领奖资格';
    elements.matchMeta.textContent =
      `本局胜方 MVP：${summary.mvpName || '未知'}。只有胜方 MVP 才能领取 ${poolLabel} CDK。`;
    return;
  }

  if (!summary.playerIsMvp) {
    elements.matchTitle.textContent = '这局赢了，但你不是 MVP';
    elements.matchMeta.textContent =
      `本局胜方 MVP：${summary.mvpName || '未知'}。只有胜方 MVP 才能领取 ${poolLabel} CDK。`;
    return;
  }

  if (!session?.authenticated) {
    elements.matchTitle.textContent = `你拿到了 MVP，但本局未登录，无法领取 ${poolLabel} CDK`;
    elements.matchMeta.textContent = '请在下一局开始前先登录，这样服务端才能为该局建立领奖记录。';
    return;
  }

  if (rewardPool === 'pvp') {
    elements.matchTitle.textContent = `本局 ${poolLabel} 奖励结算中`;
    elements.matchMeta.textContent = session.pvpConfig?.rewardEnabled
      ? `如果你是胜方 MVP，服务端会直接准备 ${poolLabel} 奖励；如未立即显示，稍后刷新账号面板即可。`
      : `当前 ${poolLabel} 奖励开关仍然关闭，因此即使你是胜方 MVP，本局也不会自动派发 ${poolLabel} CDK。`;
    return;
  }

  if (!model.currentMatchTicket?.ticketId) {
    elements.matchTitle.textContent = `你拿到了 MVP，但本局 ${poolLabel} 奖励票据缺失`;
    elements.matchMeta.textContent = '请在开局前先登录，CDK 派发依赖每局开始时生成的票据。';
    return;
  }

  elements.matchTitle.textContent = `正在准备本局 ${poolLabel} 奖励...`;
  elements.matchMeta.textContent =
    `本局胜方 MVP：${summary.mvpName || '未知'}。服务端正在为这局准备 1 个 ${poolLabel} CDK。`;
}

async function refreshPanel() {
  if (model.refreshInFlight) {
    return;
  }

  model.refreshInFlight = true;
  model.lastRefreshAt = Date.now();
  setLoadingState(true);

  try {
    const session = await apiRequest('/api/auth/session');
    model.session = session;

    if (!session.authenticated) {
      model.rewards = null;
      renderSignedOut(session);
      renderMatchOutcomePanel();
      setFeedback('');
      return;
    }

    const rewards = await apiRequest('/api/cdks/me');
    model.rewards = rewards;
    renderSignedIn(session, rewards);
    renderMatchOutcomePanel();
    setFeedback('');
  } catch (error) {
    renderLatestClaim(null);
    elements.loginButton.hidden = false;
    elements.claimButton.hidden = true;
    elements.logoutButton.hidden = true;
    elements.adminLink.hidden = true;
    elements.title.textContent = '登录面板暂时不可用';
    elements.meta.textContent = '账号服务当前没有响应，请确认 Node 服务仍在运行。';
    setFeedback(error.message, 'error');
  } finally {
    model.refreshInFlight = false;
    setLoadingState(false);
  }
}

function syncPanelIfStale() {
  if (!elements.root || document.visibilityState === 'hidden') {
    return;
  }

  if (model.refreshInFlight) {
    return;
  }

  if (Date.now() - model.lastRefreshAt < PANEL_SYNC_COOLDOWN_MS) {
    return;
  }

  void refreshPanel();
}

async function claimCode() {
  setLoadingState(true);
  setFeedback('正在领取本局奖励...');
  setMatchFeedback('正在领取本局奖励...');

  try {
    const result = await apiRequest('/api/cdks/claim', {
      method: 'POST'
    });

    const poolLabel = getPoolLabel(
      result.assignedCdk?.claimContext?.summary?.codePool || result.codePool || result.assignedCdk?.pool || result.rewardPool
    );
    model.rewards = await apiRequest('/api/cdks/me');
    renderLatestClaim(result.assignedCdk);
    renderSignedIn(model.session, model.rewards);
    renderMatchCode(result.assignedCdk?.code || null);
    elements.matchTitle.textContent = `本局 ${poolLabel} CDK 已派发`;
    elements.matchMeta.textContent = result.newlyClaimed
      ? `${poolLabel} 奖池已成功扣减并发出 1 个兑换码。`
      : '当前账号已经领过这局奖励了。';
    setFeedback(result.newlyClaimed ? `${poolLabel} CDK 领取成功。` : '这局奖励已经领过了。', 'ok');
    setMatchFeedback(result.newlyClaimed ? `${poolLabel} CDK 领取成功。` : '这局奖励已经领过了。', 'ok');
    model.latestMatchSummary = null;
  } catch (error) {
    const tone =
      error.message === 'cdk_pool_empty' ||
      error.message === 'daily_limit_reached' ||
      error.message === 'award_not_ready' ||
      error.message === 'award_not_eligible'
        ? 'warn'
        : 'error';
    const codePool = resolveCodePool(error.payload?.codePool || error.payload?.assignedCdk?.pool || '', '');
    const rewardPool = resolveRewardPool(error.payload?.rewardPool || codePool);
    const poolLabel = getPoolLabel(codePool || rewardPool);

    let message = error.message;
    if (error.message === 'cdk_pool_empty') {
      message = `${poolLabel} 码池已空，请先去后台补充 ${poolLabel} 兑换码。`;
    } else if (error.message === 'daily_limit_reached') {
      message = getAwardBlockedMessage('daily_limit_reached', codePool || rewardPool, error.payload?.limitStatus || null);
    } else if (error.message === 'award_not_ready') {
      message = '这局奖励还没有准备好，请稍后再试。';
    } else if (error.message === 'award_not_eligible') {
      message = getAwardBlockedMessage(
        error.payload?.disqualifyReason,
        codePool || rewardPool,
        error.payload?.limitStatus || null
      );
    }

    setFeedback(message, tone);
    setMatchFeedback(message, tone);
  } finally {
    setLoadingState(false);
  }
}

async function logout() {
  setLoadingState(true);
  setFeedback('正在退出登录...');

  try {
    await apiRequest('/auth/logout', { method: 'POST' });
    model.session = null;
    model.rewards = null;
    model.currentMatchTicket = null;
    setFeedback('已退出登录。', 'ok');
    await refreshPanel();
  } catch (error) {
    setFeedback(error.message, 'error');
  } finally {
    setLoadingState(false);
  }
}

async function copyValue(value, target = 'menu') {
  if (!value || value === '-') return;

  try {
    await navigator.clipboard.writeText(value);
    if (target === 'match') {
      setMatchFeedback('兑换码已复制到剪贴板。', 'ok');
    } else {
      setFeedback('兑换码已复制到剪贴板。', 'ok');
    }
  } catch {
    if (target === 'match') {
      setMatchFeedback('复制失败，你也可以手动选中兑换码后复制。', 'warn');
    } else {
      setFeedback('复制失败，你也可以手动选中兑换码后复制。', 'warn');
    }
  }
}

function setMatchOutcomeFeedbackFromSummary(summary) {
  if (!summary) {
    setMatchFeedback('');
    return;
  }

  const codePool = getSummaryCodePool(summary);
  const poolLabel = getCodePoolLabel(codePool);

  if (summary.awardBlockedReason) {
    setMatchFeedback(getAwardBlockedMessage(summary.awardBlockedReason, codePool), 'warn');
    return;
  }

  if (!summary.playerWon) {
    setMatchFeedback(`这局没有派发 ${poolLabel} CDK，因为当前玩家不在胜方阵营。`, 'warn');
    return;
  }

  if (!summary.playerIsMvp) {
    setMatchFeedback(`这局没有派发 ${poolLabel} CDK，因为当前玩家不是胜方 MVP。`, 'warn');
    return;
  }

  setMatchFeedback('');
}

function getAwardBlockedMessage(reason, pool = 'pve', limitStatus = null) {
  if (reason === 'easy_difficulty') {
    return '这是旧规则留下的历史记录：当时 PVE 的 easy/novice 不发 CDK。';
  }

  if (reason === 'daily_limit_disabled') {
    return '当前这档难度的每日发码额度被设为 0，暂时不会派发 CDK。';
  }

  if (reason === 'daily_limit_reached') {
    return limitStatus
      ? `你今天的领取额度已经用完。${formatLimitStatus(limitStatus)}`
      : `${getPoolLabel(pool)} 这档奖励今天已经领满了，请明天再来。`;
  }

  if (reason === 'match_too_short') {
    return '这局结束得过快，服务端未通过奖励校验。请正常完成一局后再领取 CDK。';
  }

  if (reason === 'pvp_rewards_disabled') {
    return `当前在线 ${getPoolLabel(pool)} 奖励开关仍然关闭，本局不会自动派发 ${getPoolLabel(pool)} CDK。`;
  }

  if (reason === 'timeout_zero_kill') {
    return '这局被判定为无效局：105 秒结束且 0 击杀，不会派发 CDK。';
  }

  if (reason === 'server_verification_required') {
    return '当前已关闭基于客户端上报战绩的自动发码。需要等服务端验证能力上线后，才会恢复自动派发 CDK。';
  }

  return `${getPoolLabel(pool)} 这局不符合发码条件。`;
}

async function prepareAwardForSummary(summary) {
  if (!summary) {
    renderMatchOutcomePanel();
    setMatchFeedback('');
    return;
  }

  if (!model.session?.authenticated) {
    renderMatchOutcomePanel();
    if (requiresServerVerification(model.session)) {
      setMatchFeedback(getAwardBlockedMessage('server_verification_required', getSummaryCodePool(summary)), 'warn');
      return;
    }
    if (!summary.eligibleForAward) {
      setMatchOutcomeFeedbackFromSummary(summary);
      return;
    }
    setMatchFeedback('请在下一局开始前先登录，这样才能参与 MVP 派码。', 'warn');
    return;
  }

  if (!model.currentMatchTicket?.ticketId) {
    renderMatchOutcomePanel();
    if (requiresServerVerification(model.session)) {
      setMatchFeedback(getAwardBlockedMessage('server_verification_required', getSummaryCodePool(summary)), 'warn');
      return;
    }
    if (!summary.eligibleForAward) {
      setMatchOutcomeFeedbackFromSummary(summary);
      return;
    }
    setMatchFeedback('这局开始时没有生成领奖票据，请在开局前先登录。', 'warn');
    return;
  }

  model.preparingAward = true;
  setLoadingState(true);

  try {
    const result = await apiRequest('/api/awards/prepare', {
      method: 'POST',
      body: JSON.stringify({
        ticketId: model.currentMatchTicket.ticketId,
        summary
      })
    });

    model.rewards = await apiRequest('/api/cdks/me');
    renderSignedIn(model.session, model.rewards);
    renderMatchOutcomePanel();

    if (!result.prepared && !result.alreadyClaimed) {
      model.latestMatchSummary = {
        ...summary,
        eligibleForAward: false,
        awardBlockedReason: result.disqualifyReason || null
      };
      renderMatchOutcomePanel();
      setMatchFeedback(
        getAwardBlockedMessage(
          result.disqualifyReason,
          getSummaryCodePool(model.latestMatchSummary),
          result.limitStatus || null
        ),
        'warn'
      );
      return;
    }

    if (result.alreadyClaimed && result.latestClaim?.code) {
      const poolLabel = getPoolLabel(result.latestClaim.claimContext?.summary?.codePool || result.latestClaim.pool);
      renderMatchCode(result.latestClaim.code);
      elements.matchTitle.textContent = `这局 ${poolLabel} 奖励已经派发过了`;
      elements.matchMeta.textContent = '同一局比赛对当前账号不会重复发多个兑换码。';
      setMatchFeedback('这局奖励已经领取过了。', 'ok');
      return;
    }

    const poolLabel = getPoolLabel(result.codePool || getSummaryCodePool(summary));
    if (result.limitStatus && Number(result.limitStatus.remaining || 0) <= 0) {
      setMatchFeedback(`这局 ${poolLabel} 奖励已锁定，但你今天的额度已用完。${formatLimitStatus(result.limitStatus)}`, 'warn');
      return;
    }

    setMatchFeedback(`${poolLabel} 奖励已准备完成，现在可以领取 1 个兑换码。${formatLimitStatus(result.limitStatus)}`, 'ok');
  } catch (error) {
    const tone = error.message === 'award_not_eligible' ||
      error.message === 'match_ticket_missing' ||
      error.message === 'match_ticket_consumed'
      ? 'warn'
      : 'error';
    let message = error.message;

    if (error.message === 'award_not_eligible') {
      message = '只有胜方 MVP 才能领取这局奖励。';
    } else if (error.message === 'match_ticket_missing') {
      message = '这局领奖票据缺失，请在开局前先登录。';
    } else if (error.message === 'match_ticket_consumed') {
      message = '这局领奖票据已经使用过了，不能重复提交领奖准备请求。';
    }

    renderMatchOutcomePanel();
    setMatchFeedback(message, tone);
  } finally {
    model.preparingAward = false;
    setLoadingState(false);
  }
}

async function handleMatchStarted(event) {
  model.latestMatchSummary = null;
  model.currentMatchTicket = null;
  renderMatchCode(null);
  setMatchFeedback('');

  const detail = event?.detail || {};

  if (!model.session?.authenticated) {
    renderMatchOutcomePanel();
    return;
  }

  try {
    const result = await apiRequest('/api/awards/matches/start', {
      method: 'POST',
      body: JSON.stringify({
        gameMode: detail.gameMode,
        difficulty: detail.difficulty,
        matchType: detail.matchType
      })
    });
    model.currentMatchTicket = result.activeMatch || null;
    model.rewards = await apiRequest('/api/cdks/me');
    renderSignedIn(model.session, model.rewards);
  } catch (error) {
    model.currentMatchTicket = null;
    setFeedback(`本局奖励跟踪启动失败：${error.message}`, 'warn');
  }
}

function handleMatchEnded(event) {
  model.latestMatchSummary = event?.detail || null;
  renderMatchOutcomePanel();

  if (model.latestMatchSummary) {
    prepareAwardForSummary(model.latestMatchSummary);
    return;
  }

  setMatchFeedback('');
}

async function handlePvpMatchStarted() {
  model.currentMatchTicket = null;
  model.latestMatchSummary = null;
  renderMatchCode(null);
  setMatchFeedback('');
  renderMatchOutcomePanel();

  try {
    await refreshPanel();
  } catch {}
}

async function handlePvpMatchEnded(event) {
  model.currentMatchTicket = null;
  model.latestMatchSummary = buildPvpSummaryForSession(event?.detail || null, model.session);
  renderMatchOutcomePanel();

  try {
    await refreshPanel();
  } catch {}
}

async function handlePvpMatchAborted() {
  model.currentMatchTicket = null;
  model.latestMatchSummary = null;
  renderMatchOutcomePanel();

  try {
    await refreshPanel();
  } catch {}
}

function bindEvents() {
  elements.claimButton?.addEventListener('click', claimCode);
  elements.matchClaimButton?.addEventListener('click', claimCode);
  elements.logoutButton?.addEventListener('click', logout);
  elements.copyButton?.addEventListener('click', () => copyValue(elements.codeValue.textContent.trim(), 'menu'));
  elements.matchCopyButton?.addEventListener('click', () => copyValue(elements.matchCodeValue.textContent.trim(), 'match'));
  elements.loginButton?.addEventListener('click', (event) => {
    if (elements.loginButton.classList.contains('is-disabled')) {
      event.preventDefault();
    }
  });
  window.addEventListener('shooters-match-started', handleMatchStarted);
  window.addEventListener('shooters-match-ended', handleMatchEnded);
  window.addEventListener('shooters-pvp-match-started', handlePvpMatchStarted);
  window.addEventListener('shooters-pvp-match-ended', handlePvpMatchEnded);
  window.addEventListener('shooters-pvp-match-aborted', handlePvpMatchAborted);
  window.addEventListener('pageshow', syncPanelIfStale);
  window.addEventListener('focus', syncPanelIfStale);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      syncPanelIfStale();
    }
  });
}

if (elements.root) {
  bindEvents();
  refreshPanel();
}
