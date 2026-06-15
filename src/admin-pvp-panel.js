const PVP_BETA_PANEL_ID = 'pvpBetaConfigPanel';
const PVP_EVENT_PANEL_ID = 'pvpEventConfigPanel';

const pvpAdminState = {
  session: null,
  stored: null,
  effective: null
};

const pvpEventAdminState = {
  stored: null,
  effective: null,
  leaderboards: {
    event: [],
    global: []
  },
  recentSignups: []
};

function parseResponse(response) {
  return response
    .json()
    .catch(() => ({}))
    .then((payload) => {
      if (!response.ok) {
        throw new Error(payload.error || payload.message || `request_failed_${response.status}`);
      }
      return payload;
    });
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

function ensurePanel() {
  const existing = document.getElementById(PVP_BETA_PANEL_ID);
  if (existing) return existing;

  const rewardPolicyPanel =
    document.getElementById('rewardPolicyForm')?.closest('.panel') || document.querySelector('#adminApp .panel');
  const adminApp = document.getElementById('adminApp');
  if (!rewardPolicyPanel || !adminApp) return null;

  const panel = document.createElement('section');
  panel.id = PVP_BETA_PANEL_ID;
  panel.className = 'panel span-2';
  panel.innerHTML = `
    <h2>PVP Beta</h2>
    <p>这里控制在线 PVP 房间、匹配、回放和服务端权威 PVP 奖励结算。</p>
    <p class="minor" id="pvpBetaSummaryText">正在加载 PVP Beta 配置...</p>
    <form id="pvpBetaForm">
      <div class="reward-policy-grid">
        <label>
          <span>PVP 总开关</span>
          <select id="pvpEnabled">
            <option value="true">开启</option>
            <option value="false">关闭</option>
          </select>
        </label>
        <label>
          <span>公开匹配</span>
          <select id="pvpMatchmakingEnabled">
            <option value="true">开启</option>
            <option value="false">关闭</option>
          </select>
        </label>
        <label>
          <span>PVP 奖励开关</span>
          <select id="pvpRewardEnabled">
            <option value="true">开启</option>
            <option value="false">关闭</option>
          </select>
        </label>
        <label>
          <span>允许 1v1 对决</span>
          <select id="pvpAllowDuel">
            <option value="true">开启</option>
            <option value="false">关闭</option>
          </select>
        </label>
        <label>
          <span>允许 4 人乱斗</span>
          <select id="pvpAllowDeathmatch">
            <option value="true">开启</option>
            <option value="false">关闭</option>
          </select>
        </label>
        <label>
          <span>活跃房间上限</span>
          <input id="pvpMaxActiveRooms" type="number" min="1" step="1" inputmode="numeric" required />
        </label>
        <label>
          <span>房间/队列超时秒数</span>
          <input id="pvpMaxRoomIdleSeconds" type="number" min="60" step="1" inputmode="numeric" required />
        </label>
        <label>
          <span>回放录制</span>
          <select id="pvpReplayEnabled">
            <option value="true">开启</option>
            <option value="false">关闭</option>
          </select>
        </label>
        <label>
          <span>赛后压缩回放</span>
          <select id="pvpReplayCompressOnComplete">
            <option value="true">开启</option>
            <option value="false">关闭</option>
          </select>
        </label>
        <label>
          <span>最多保留回放场数（0 = 不限）</span>
          <input id="pvpReplayMaxStoredMatches" type="number" min="0" step="1" inputmode="numeric" required />
        </label>
        <label>
          <span>录制 duel 回放</span>
          <select id="pvpReplayAllowDuel">
            <option value="true">开启</option>
            <option value="false">关闭</option>
          </select>
        </label>
        <label>
          <span>录制 deathmatch 回放</span>
          <select id="pvpReplayAllowDeathmatch">
            <option value="true">开启</option>
            <option value="false">关闭</option>
          </select>
        </label>
      </div>
      <div class="actions">
        <button type="submit">保存 PVP Beta 配置</button>
        <button class="secondary" id="pvpBetaResetButton" type="button">恢复当前已保存值</button>
      </div>
    </form>
    <div class="message" id="pvpBetaMessage"></div>
  `;

  rewardPolicyPanel.insertAdjacentElement('beforebegin', panel);
  return panel;
}

function getElements() {
  const panel = ensurePanel();
  if (!panel) return null;

  return {
    panel,
    summary: document.getElementById('pvpBetaSummaryText'),
    form: document.getElementById('pvpBetaForm'),
    enabled: document.getElementById('pvpEnabled'),
    matchmakingEnabled: document.getElementById('pvpMatchmakingEnabled'),
    rewardEnabled: document.getElementById('pvpRewardEnabled'),
    allowDuel: document.getElementById('pvpAllowDuel'),
    allowDeathmatch: document.getElementById('pvpAllowDeathmatch'),
    maxActiveRooms: document.getElementById('pvpMaxActiveRooms'),
    maxRoomIdleSeconds: document.getElementById('pvpMaxRoomIdleSeconds'),
    replayEnabled: document.getElementById('pvpReplayEnabled'),
    replayCompressOnComplete: document.getElementById('pvpReplayCompressOnComplete'),
    replayMaxStoredMatches: document.getElementById('pvpReplayMaxStoredMatches'),
    replayAllowDuel: document.getElementById('pvpReplayAllowDuel'),
    replayAllowDeathmatch: document.getElementById('pvpReplayAllowDeathmatch'),
    resetButton: document.getElementById('pvpBetaResetButton'),
    message: document.getElementById('pvpBetaMessage')
  };
}

function ensureEventPanel() {
  const existing = document.getElementById(PVP_EVENT_PANEL_ID);
  if (existing) return existing;

  const pvpPanel = ensurePanel();
  if (!pvpPanel) return null;

  const panel = document.createElement('section');
  panel.id = PVP_EVENT_PANEL_ID;
  panel.className = 'panel span-2';
  panel.innerHTML = `
    <h2>42 杯活动</h2>
    <p>这里配置当前一期 42 杯限时活动的报名时间、比赛时间和前台展示文案。玩家登录后可在前台自行报名，榜单只统计活动时间窗内的 PVP 战绩。</p>
    <p class="minor" id="pvpEventSummaryText">正在加载 42 杯活动配置...</p>
    <form id="pvpEventForm">
      <div class="reward-policy-grid">
        <label>
          <span>活动开关</span>
          <select id="pvpEventEnabled">
            <option value="true">开启</option>
            <option value="false">关闭</option>
          </select>
        </label>
        <label>
          <span>活动标题</span>
          <input id="pvpEventTitle" type="text" maxlength="80" required />
        </label>
        <label>
          <span>活动标识</span>
          <input id="pvpEventSlug" type="text" maxlength="48" required />
        </label>
        <label>
          <span>报名开始</span>
          <input id="pvpEventSignupStartsAt" type="datetime-local" />
        </label>
        <label>
          <span>比赛开始</span>
          <input id="pvpEventStartsAt" type="datetime-local" />
        </label>
        <label>
          <span>比赛结束</span>
          <input id="pvpEventEndsAt" type="datetime-local" />
        </label>
        <label class="span-all">
          <span>活动说明</span>
          <textarea id="pvpEventDescription"></textarea>
        </label>
      </div>
      <div class="actions">
        <button type="submit">保存 42 杯活动</button>
        <button class="secondary" id="pvpEventResetButton" type="button">恢复当前已保存值</button>
      </div>
    </form>
    <div class="policy-summary">
      <div class="minor" id="pvpEventScoringText">积分规则：正式榜至少 8 场 | 1v1: 胜+12 / 负-10 / 击杀+1 / 吸收败者 40% 败场分 | 4人: 胜+42 / MVP +12 / 击杀+2 / 负-8 / 吸收败者 25% 败场分</div>
      <div class="minor" id="pvpEventLeaderboardText">活动榜预览加载中...</div>
      <div class="minor" id="pvpEventSignupListText">最近报名用户加载中...</div>
    </div>
    <div class="message" id="pvpEventMessage"></div>
  `;

  pvpPanel.insertAdjacentElement('afterend', panel);
  return panel;
}

function getEventElements() {
  const panel = ensureEventPanel();
  if (!panel) return null;

  return {
    panel,
    summary: document.getElementById('pvpEventSummaryText'),
    form: document.getElementById('pvpEventForm'),
    enabled: document.getElementById('pvpEventEnabled'),
    title: document.getElementById('pvpEventTitle'),
    slug: document.getElementById('pvpEventSlug'),
    signupStartsAt: document.getElementById('pvpEventSignupStartsAt'),
    startsAt: document.getElementById('pvpEventStartsAt'),
    endsAt: document.getElementById('pvpEventEndsAt'),
    description: document.getElementById('pvpEventDescription'),
    resetButton: document.getElementById('pvpEventResetButton'),
    scoringText: document.getElementById('pvpEventScoringText'),
    leaderboardText: document.getElementById('pvpEventLeaderboardText'),
    signupListText: document.getElementById('pvpEventSignupListText'),
    message: document.getElementById('pvpEventMessage')
  };
}

function setMessage(message, tone = '') {
  const elements = getElements();
  if (!elements?.message) return;
  elements.message.textContent = message || '';
  elements.message.className = tone ? `message ${tone}` : 'message';
}

function asSelectValue(value) {
  return value ? 'true' : 'false';
}

function asEnabledText(value) {
  return value ? '开' : '关';
}

function toDateTimeLocalValue(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 16);
}

function fromDateTimeLocalValue(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function setEventMessage(message, tone = '') {
  const elements = getEventElements();
  if (!elements?.message) return;
  elements.message.textContent = message || '';
  elements.message.className = tone ? `message ${tone}` : 'message';
}

function populateForm(config) {
  const elements = getElements();
  if (!elements || !config) return;

  const replay = config.replay || {};

  elements.enabled.value = asSelectValue(config.enabled);
  elements.matchmakingEnabled.value = asSelectValue(config.matchmakingEnabled);
  elements.rewardEnabled.value = asSelectValue(config.rewardEnabled);
  elements.allowDuel.value = asSelectValue(config.allowModes?.duel !== false);
  elements.allowDeathmatch.value = asSelectValue(config.allowModes?.deathmatch !== false);
  elements.maxActiveRooms.value = String(Number(config.maxActiveRooms || 20));
  elements.maxRoomIdleSeconds.value = String(Number(config.maxRoomIdleSeconds || 600));
  elements.replayEnabled.value = asSelectValue(replay.enabled === true);
  elements.replayCompressOnComplete.value = asSelectValue(replay.compressOnComplete !== false);
  elements.replayMaxStoredMatches.value = String(Number(replay.maxStoredMatches || 0));
  elements.replayAllowDuel.value = asSelectValue(replay.modes?.duel === true);
  elements.replayAllowDeathmatch.value = asSelectValue(replay.modes?.deathmatch !== false);
}

function readFormValue() {
  const elements = getElements();
  if (!elements) return null;

  return {
    enabled: elements.enabled.value === 'true',
    matchmakingEnabled: elements.matchmakingEnabled.value === 'true',
    rewardEnabled: elements.rewardEnabled.value === 'true',
    maxActiveRooms: Math.max(1, Math.floor(Number(elements.maxActiveRooms.value || 20))),
    maxRoomIdleSeconds: Math.max(60, Math.floor(Number(elements.maxRoomIdleSeconds.value || 600))),
    allowModes: {
      duel: elements.allowDuel.value === 'true',
      deathmatch: elements.allowDeathmatch.value === 'true'
    },
    replay: {
      enabled: elements.replayEnabled.value === 'true',
      compressOnComplete: elements.replayCompressOnComplete.value === 'true',
      maxStoredMatches: Math.max(0, Math.floor(Number(elements.replayMaxStoredMatches.value || 0))),
      modes: {
        duel: elements.replayAllowDuel.value === 'true',
        deathmatch: elements.replayAllowDeathmatch.value === 'true'
      }
    }
  };
}

function summarizeConfig(config) {
  if (!config) {
    return '未配置';
  }

  const replayLimit = Number(config.replay?.maxStoredMatches || 0);

  return [
    `总开关 ${asEnabledText(config.enabled)}`,
    `匹配 ${asEnabledText(config.matchmakingEnabled)}`,
    `奖励 ${asEnabledText(config.rewardEnabled)}`,
    `模式 duel=${asEnabledText(config.allowModes?.duel !== false)} / deathmatch=${asEnabledText(
      config.allowModes?.deathmatch !== false
    )}`,
    `活跃房间上限 ${Number(config.maxActiveRooms || 0)}`,
    `超时 ${Number(config.maxRoomIdleSeconds || 0)}s`,
    `回放 ${asEnabledText(config.replay?.enabled === true)}`,
    `压缩 ${asEnabledText(config.replay?.compressOnComplete !== false)}`,
    `保留 ${replayLimit > 0 ? `${replayLimit} 场` : '不限'}`,
    `录制 duel=${asEnabledText(config.replay?.modes?.duel === true)} / deathmatch=${asEnabledText(
      config.replay?.modes?.deathmatch !== false
    )}`
  ].join(' | ');
}

function renderSummary(storedConfig, effectiveConfig) {
  const elements = getElements();
  if (!elements?.summary) return;

  const stored = storedConfig || effectiveConfig;
  const effective = effectiveConfig || storedConfig;
  if (!stored && !effective) {
    elements.summary.textContent = '正在加载 PVP Beta 配置...';
    return;
  }

  elements.summary.textContent = `后台保存值: ${summarizeConfig(stored)} | 当前生效值: ${summarizeConfig(
    effective
  )}`;
}

function populateEventForm(config) {
  const elements = getEventElements();
  if (!elements || !config) return;

  elements.enabled.value = asSelectValue(config.enabled);
  elements.title.value = config.title || '42杯';
  elements.slug.value = config.slug || '42-cup';
  elements.signupStartsAt.value = toDateTimeLocalValue(config.signupStartsAt);
  elements.startsAt.value = toDateTimeLocalValue(config.startsAt);
  elements.endsAt.value = toDateTimeLocalValue(config.endsAt);
  elements.description.value = config.description || '';
}

function formatSignedScore(value) {
  const score = Number(value || 0);
  return score > 0 ? `+${score}` : `${score}`;
}

function formatEventScoringSummary(scoring) {
  if (!scoring?.modes) {
    return '积分规则加载中...';
  }

  const duel = scoring.modes.duel || {};
  const deathmatch = scoring.modes.deathmatch || {};
  const minMatches = Math.max(0, Math.floor(Number(scoring.leaderboardMinMatches || 0)));
  const duelTransfer = Number(duel.lossTransfer || 0);
  const deathmatchTransfer = Number(deathmatch.lossTransfer || 0);
  const duelTransferText = duelTransfer > 0 ? ` / 吸收败者 ${Math.round(duelTransfer * 100)}% 败场分` : '';
  const deathmatchTransferText =
    deathmatchTransfer > 0 ? ` / 吸收败者 ${Math.round(deathmatchTransfer * 100)}% 败场分` : '';

  return [
    minMatches > 0 ? `正式榜至少 ${minMatches} 场` : null,
    `1v1: 胜${formatSignedScore(duel.win)} / 负${formatSignedScore(duel.loss)} / 击杀${formatSignedScore(duel.kill)}${duelTransferText}`,
    `4人: 胜${formatSignedScore(deathmatch.win)} / MVP ${formatSignedScore(deathmatch.mvp)} / 击杀${formatSignedScore(deathmatch.kill)} / 负${formatSignedScore(deathmatch.loss)}${deathmatchTransferText}`
  ]
    .filter(Boolean)
    .join(' | ');
}

function readEventFormValue() {
  const elements = getEventElements();
  if (!elements) return null;

  return {
    enabled: elements.enabled.value === 'true',
    title: String(elements.title.value || '').trim(),
    slug: String(elements.slug.value || '').trim(),
    signupStartsAt: fromDateTimeLocalValue(elements.signupStartsAt.value),
    startsAt: fromDateTimeLocalValue(elements.startsAt.value),
    endsAt: fromDateTimeLocalValue(elements.endsAt.value),
    description: String(elements.description.value || '').trim()
  };
}

function summarizeEventConfig(config) {
  if (!config) {
    return '未配置';
  }

  return [
    `开关 ${asEnabledText(config.enabled)}`,
    `标题 ${config.title || '-'}`,
    `标识 ${config.slug || '-'}`,
    `报名 ${config.signupStartsAt ? new Date(config.signupStartsAt).toLocaleString() : '-'}`,
    `开始 ${config.startsAt ? new Date(config.startsAt).toLocaleString() : '-'}`,
    `结束 ${config.endsAt ? new Date(config.endsAt).toLocaleString() : '-'}`
  ].join(' | ');
}

function summarizeLeaderboardPreview(items) {
  if (!Array.isArray(items) || !items.length) {
    return '暂无战绩';
  }

  return items
    .slice(0, 3)
    .map(
      (entry) =>
        `#${Number(entry.rank || 0)} ${entry.user?.username || entry.user?.displayName || entry.user?.id} ${Number(
          entry.score || 0
        )}杯`
    )
    .join(' | ');
}

function summarizeRecentSignups(items) {
  if (!Array.isArray(items) || !items.length) {
    return '最近暂无报名记录';
  }

  return items
    .slice(0, 5)
    .map(
      (entry) =>
        `${entry.user?.username || entry.user?.displayName || entry.user?.id} @ ${new Date(
          entry.signedUpAt
        ).toLocaleString()}`
    )
    .join(' | ');
}

function renderEventSummary(storedConfig, effectiveConfig) {
  const elements = getEventElements();
  if (!elements?.summary) return;

  const stored = storedConfig || effectiveConfig;
  const effective = effectiveConfig || storedConfig;
  if (!stored && !effective) {
    elements.summary.textContent = '正在加载 42 杯活动配置...';
    return;
  }

  const signupsCount = Number(pvpEventAdminState.effective?.signupCount || 0);
  const phaseText = pvpEventAdminState.effective?.phaseLabel || '未开启';
  const scoring = effective?.scoring || stored?.scoring || null;
  const minMatches = Math.max(0, Math.floor(Number(scoring?.leaderboardMinMatches || 0)));
  elements.summary.textContent = `后台保存值: ${summarizeEventConfig(stored)} | 当前生效值: ${summarizeEventConfig(
    effective
  )} | 当前阶段: ${phaseText} | 已报名 ${signupsCount} 人`;
  elements.scoringText.textContent = `积分规则: ${formatEventScoringSummary(scoring)}`;
  elements.leaderboardText.textContent = `活动正式榜预览${minMatches > 0 ? ` (至少 ${minMatches} 场)` : ''}: ${summarizeLeaderboardPreview(
    pvpEventAdminState.leaderboards.event
  )} | 全服正式榜预览: ${summarizeLeaderboardPreview(pvpEventAdminState.leaderboards.global)}`;
  elements.signupListText.textContent = `最近报名: ${summarizeRecentSignups(pvpEventAdminState.recentSignups)}`;
}

async function refreshPvpConfig() {
  const session = await apiRequest('/api/auth/session');
  pvpAdminState.session = session;

  if (!session.authenticated || !session.isAdmin) {
    return;
  }

  const result = await apiRequest('/api/admin/pvp-config');
  pvpAdminState.stored = result.storedPvpConfig || result.pvpConfig || null;
  pvpAdminState.effective = result.pvpConfig || result.storedPvpConfig || null;
  populateForm(pvpAdminState.stored || pvpAdminState.effective);
  renderSummary(pvpAdminState.stored, pvpAdminState.effective);
}

async function refreshPvpEvent() {
  const session = pvpAdminState.session || (await apiRequest('/api/auth/session'));
  pvpAdminState.session = session;

  if (!session.authenticated || !session.isAdmin) {
    return;
  }

  const result = await apiRequest('/api/admin/pvp-event');
  pvpEventAdminState.stored = result.storedPvpEvent || result.pvpEvent || null;
  pvpEventAdminState.effective = result.pvpEvent || result.storedPvpEvent || null;
  pvpEventAdminState.leaderboards = result.leaderboards || {
    event: [],
    global: []
  };
  pvpEventAdminState.recentSignups = result.recentSignups || [];
  populateEventForm(pvpEventAdminState.stored || pvpEventAdminState.effective);
  renderEventSummary(pvpEventAdminState.stored, pvpEventAdminState.effective);
}

async function saveConfig(event) {
  event.preventDefault();
  setMessage('正在保存 PVP Beta 配置...');

  try {
    await apiRequest('/api/admin/pvp-config', {
      method: 'POST',
      body: JSON.stringify(readFormValue())
    });
    await refreshPvpConfig();
    setMessage('PVP Beta 配置已保存。', 'ok');
  } catch (error) {
    setMessage(error.message, 'error');
  }
}

async function saveEventConfig(event) {
  event.preventDefault();
  setEventMessage('正在保存 42 杯活动配置...');

  try {
    await apiRequest('/api/admin/pvp-event', {
      method: 'POST',
      body: JSON.stringify(readEventFormValue())
    });
    await refreshPvpEvent();
    setEventMessage('42 杯活动配置已保存。', 'ok');
  } catch (error) {
    setEventMessage(error.message, 'error');
  }
}

function resetForm() {
  if (pvpAdminState.stored) {
    populateForm(pvpAdminState.stored);
    setMessage('已恢复为当前已保存的 PVP Beta 配置。');
    return;
  }

  if (pvpAdminState.effective) {
    populateForm(pvpAdminState.effective);
    setMessage('已恢复为当前生效的 PVP Beta 配置。');
    return;
  }

  setMessage('当前没有可恢复的 PVP Beta 配置。', 'warn');
}

function resetEventForm() {
  if (pvpEventAdminState.stored) {
    populateEventForm(pvpEventAdminState.stored);
    setEventMessage('已恢复为当前已保存的 42 杯活动配置。');
    return;
  }

  if (pvpEventAdminState.effective) {
    populateEventForm(pvpEventAdminState.effective);
    setEventMessage('已恢复为当前生效的 42 杯活动配置。');
    return;
  }

  setEventMessage('当前没有可恢复的 42 杯活动配置。', 'warn');
}

function mount() {
  const elements = getElements();
  if (!elements || elements.panel.dataset.bound === 'true') return;

  elements.panel.dataset.bound = 'true';
  elements.form?.addEventListener('submit', saveConfig);
  elements.resetButton?.addEventListener('click', resetForm);
  const eventElements = getEventElements();
  if (eventElements && eventElements.panel.dataset.bound !== 'true') {
    eventElements.panel.dataset.bound = 'true';
    eventElements.form?.addEventListener('submit', saveEventConfig);
    eventElements.resetButton?.addEventListener('click', resetEventForm);
  }
  refreshPvpConfig()
    .then(() => refreshPvpEvent())
    .catch(() => {});
}

mount();
