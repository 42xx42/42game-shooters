import { createPvpReplayViewer } from './pvp-replay-viewer.js?v=20260326-pvp-replay-v3-1';
import { createPvpReplaySpectator } from './pvp-replay-spectator.js?v=20260326-pvp-replay-v3-1';
import {
  PVP_DEFAULT_MAP_SELECTION,
  PVP_MAP_SELECTION_OPTIONS,
  getPvpMapLabel,
  normalizePvpMapSelection
} from './pvp-map-catalog.mjs';

const STYLE_ID = 'pvpPanelStyles';
const PANEL_ID = 'pvpPanel';
const MAP_SELECTION_STORAGE_KEY = 'tinyToonDuel_mapSelection';

const state = {
  session: null,
  config: null,
  transport: {
    mode: 'same-origin',
    apiBaseUrl: '',
    accessToken: '',
    expiresAt: null
  },
  currentRoom: null,
  currentQueue: null,
  currentMatch: null,
  replays: [],
  eventData: null,
  eventBoard: 'event',
  selectedMode: 'duel',
  selectedMapSelection: normalizePvpMapSelection(
    window.localStorage?.getItem?.(MAP_SELECTION_STORAGE_KEY),
    PVP_DEFAULT_MAP_SELECTION
  ),
  wsUrl: '',
  socket: null,
  socketConnected: false,
  reconnectTimer: null,
  busy: false,
  matchInputSeq: 0,
  feedback: {
    message: '',
    tone: ''
  }
};

const replayViewer = createPvpReplayViewer({
  apiRequest,
  formatDateTime
});

const replaySpectator = createPvpReplaySpectator({
  apiRequest,
  onOpenAnalysisMode(matchId, currentUserId, options = {}) {
    void replayViewer.open(matchId, currentUserId, options);
  }
});

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .pvp-panel {
      margin-top: 18px;
      display: grid;
      gap: 14px;
    }
    .pvp-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .pvp-subcard {
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.04);
      padding: 12px;
      display: grid;
      gap: 10px;
    }
    .pvp-subcard h4 {
      margin: 0;
      font-size: 14px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: rgba(255, 255, 255, 0.74);
    }
    .pvp-mode-buttons,
    .pvp-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .pvp-mode-btn {
      appearance: none;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.06);
      color: inherit;
      padding: 8px 12px;
      cursor: pointer;
      font: inherit;
      font-weight: 700;
    }
    .pvp-mode-btn.active {
      background: rgba(126, 220, 255, 0.18);
      border-color: rgba(126, 220, 255, 0.38);
      color: #c9f7ff;
    }
    .pvp-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .pvp-input {
      flex: 1 1 180px;
      min-width: 0;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(255, 255, 255, 0.04);
      color: inherit;
      padding: 10px 12px;
      font: inherit;
    }
    .pvp-member-list,
    .pvp-meta-list {
      display: grid;
      gap: 8px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .pvp-member {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 12px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    .pvp-member.is-self {
      border-color: rgba(126, 220, 255, 0.34);
      box-shadow: inset 0 0 0 1px rgba(126, 220, 255, 0.12);
    }
    .pvp-member.is-down {
      opacity: 0.78;
    }
    .pvp-member strong {
      display: block;
    }
    .pvp-match-stats {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 6px;
    }
    .pvp-member-tags {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 6px;
    }
    .pvp-member small,
    .pvp-caption {
      color: rgba(255, 255, 255, 0.68);
    }
    .pvp-pill {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 12px;
      font-weight: 700;
      background: rgba(255, 255, 255, 0.08);
    }
    .pvp-pill.ready {
      color: #8cf1a0;
      background: rgba(116, 226, 130, 0.14);
    }
    .pvp-pill.offline {
      color: #ffb7b7;
      background: rgba(255, 140, 140, 0.14);
    }
    .pvp-pill.live {
      color: #7edcff;
      background: rgba(126, 220, 255, 0.16);
    }
    .pvp-meta {
      display: grid;
      gap: 6px;
      color: rgba(255, 255, 255, 0.76);
    }
    .pvp-feedback {
      min-height: 22px;
      color: rgba(255, 255, 255, 0.68);
    }
    .pvp-feedback[data-tone="ok"] {
      color: #8cf1a0;
    }
    .pvp-feedback[data-tone="warn"] {
      color: #ffcf7c;
    }
    .pvp-feedback[data-tone="error"] {
      color: #ff9f9f;
    }
    .pvp-heading-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    .pvp-rank-list {
      display: grid;
      gap: 8px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .pvp-rank-row {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      padding: 10px 12px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    .pvp-rank-index {
      min-width: 32px;
      text-align: center;
      font-weight: 800;
      color: #c9f7ff;
    }
    .pvp-rank-main {
      min-width: 0;
      display: grid;
      gap: 4px;
    }
    .pvp-rank-main strong,
    .pvp-rank-main small {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .pvp-rank-stats {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 6px;
    }
    .pvp-rank-empty {
      padding: 12px;
      border-radius: 12px;
      color: rgba(255, 255, 255, 0.68);
      background: rgba(255, 255, 255, 0.04);
      border: 1px dashed rgba(255, 255, 255, 0.12);
    }
    .pvp-room-code {
      display: grid;
      gap: 8px;
      padding: 12px;
      border-radius: 14px;
      background: rgba(126, 220, 255, 0.08);
      border: 1px solid rgba(126, 220, 255, 0.18);
    }
    .pvp-room-code-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }
    .pvp-room-code-value {
      font-size: clamp(18px, 2.8vw, 24px);
      font-weight: 800;
      letter-spacing: 0.18em;
      color: #c9f7ff;
    }
    .pvp-replay-list {
      display: grid;
      gap: 8px;
    }
    .pvp-replay-row {
      display: grid;
      gap: 6px;
      padding: 10px 12px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    .pvp-replay-row strong {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }
    .pvp-replay-row small {
      color: rgba(255, 255, 255, 0.68);
      line-height: 1.5;
    }
    .pvp-replay-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .pvp-replay-empty {
      padding: 12px;
      border-radius: 12px;
      color: rgba(255, 255, 255, 0.68);
      background: rgba(255, 255, 255, 0.04);
      border: 1px dashed rgba(255, 255, 255, 0.12);
    }
    .pvp-hidden {
      display: none !important;
    }
    @media (max-width: 860px) {
      .pvp-grid {
        grid-template-columns: 1fr;
      }
      .pvp-row,
      .pvp-actions {
        flex-direction: column;
        align-items: stretch;
      }
    }
  `;
  document.head.appendChild(style);
}

function ensurePanel() {
  const existing = document.getElementById(PANEL_ID);
  if (existing) return existing;

  const menuSurface = document.querySelector('#menuOverlay .menuSurface');
  const accountPanel = document.getElementById('accountPanel');
  if (!menuSurface || !accountPanel || !accountPanel.parentNode) {
    return null;
  }

  const panel = document.createElement('section');
  panel.id = PANEL_ID;
  panel.className = 'accountCard pvp-panel';
  panel.innerHTML = `
    <div class="accountCardHead">
      <div>
        <div class="accountEyebrow">PVP Beta</div>
        <strong id="pvpPanelTitle">在线 PVP 房间</strong>
      </div>
      <div class="pvp-caption" id="pvpSocketStatus">实时未连接</div>
    </div>
    <p class="accountMeta" id="pvpPanelMeta">正在加载 PVP 状态...</p>
    <div class="pvp-mode-buttons" id="pvpModeButtons">
      <button class="pvp-mode-btn active" data-mode="duel" type="button">1v1 对决</button>
      <button class="pvp-mode-btn" data-mode="deathmatch" type="button">4人乱斗</button>
    </div>
    <div class="pvp-heading-row">
      <span class="pvp-caption">鍦板浘鍊惧ソ</span>
    </div>
    <div class="pvp-mode-buttons" id="pvpMapButtons">
      ${PVP_MAP_SELECTION_OPTIONS.map(
        (option) => `<button class="pvp-mode-btn${option.id === state.selectedMapSelection ? ' active' : ''}" data-map-selection="${option.id}" type="button">${option.label}</button>`
      ).join('')}
    </div>
    <div class="pvp-grid">
      <div class="pvp-subcard">
        <h4>私有房间</h4>
        <div class="pvp-actions">
          <button class="accountBtn" id="pvpCreateRoomBtn" type="button">创建房间</button>
        </div>
        <div class="pvp-row">
          <input class="pvp-input" id="pvpJoinRoomCode" type="text" maxlength="12" placeholder="输入房间码加入" />
          <button class="accountBtn secondary" id="pvpJoinRoomBtn" type="button">加入</button>
          <button class="accountBtn secondary" id="pvpSpectateRoomBtn" type="button">观赛</button>
        </div>
      </div>
      <div class="pvp-subcard">
        <h4>公开匹配</h4>
        <div class="pvp-actions">
          <button class="accountBtn" id="pvpQueueBtn" type="button">进入匹配</button>
          <button class="accountBtn secondary" id="pvpCancelQueueBtn" type="button">取消匹配</button>
        </div>
        <div class="pvp-meta" id="pvpQueueMeta">当前未在匹配队列中。</div>
      </div>
    </div>
    <div class="pvp-subcard" id="pvpRoomCard">
      <h4>当前房间</h4>
      <div class="pvp-meta" id="pvpRoomMeta">当前不在任何 PVP 房间中。</div>
      <div class="pvp-room-code pvp-hidden" id="pvpRoomCodeWrap">
        <span class="pvp-caption">房间码</span>
        <div class="pvp-room-code-row">
          <strong class="pvp-room-code-value" id="pvpRoomCodeValue">-</strong>
          <button class="accountBtn secondary small" id="pvpCopyRoomCodeBtn" type="button">复制房间码</button>
        </div>
      </div>
      <ul class="pvp-member-list" id="pvpRoomMembers"></ul>
      <div class="pvp-actions">
        <button class="accountBtn" id="pvpReadyBtn" type="button">准备</button>
        <button class="accountBtn secondary" id="pvpStartBtn" type="button">开始对局</button>
        <button class="accountBtn secondary" id="pvpLeaveBtn" type="button">离开房间</button>
      </div>
    </div>
    <div class="pvp-subcard" id="pvpMatchCard">
      <h4>当前对局</h4>
      <div class="pvp-meta" id="pvpMatchMeta">当前没有进行中的在线 PVP 对局。</div>
      <ul class="pvp-meta-list" id="pvpMatchDetails"></ul>
      <div class="pvp-actions">
        <button class="accountBtn secondary" id="pvpSurrenderBtn" type="button">投降并退出本局</button>
      </div>
    </div>
    <div class="pvp-subcard" id="pvpReplayCard">
      <div class="pvp-heading-row">
        <h4>最近回放</h4>
        <span class="pvp-caption" id="pvpReplayMeta">登录后可查看你参与的 PVP 回放。</span>
      </div>
      <div class="pvp-replay-list" id="pvpReplayList"></div>
    </div>
    <div class="pvp-subcard" id="pvpEventCard">
      <div class="pvp-heading-row">
        <h4>42 杯限时活动</h4>
        <span class="pvp-pill" id="pvpEventPhase">未开启</span>
      </div>
      <div class="pvp-meta" id="pvpEventMeta">正在加载 42 杯活动状态...</div>
      <div class="pvp-actions">
        <button class="accountBtn" id="pvpEventSignupBtn" type="button">报名参加 42 杯</button>
      </div>
      <div class="pvp-mode-buttons" id="pvpEventBoardTabs">
        <button class="pvp-mode-btn active" data-board="event" type="button">42 杯活动榜</button>
        <button class="pvp-mode-btn" data-board="global" type="button">活动期全服榜</button>
      </div>
      <div class="pvp-caption" id="pvpEventPersonal">登录后可查看我的 42 杯状态。</div>
      <ol class="pvp-rank-list" id="pvpEventRanking"></ol>
      <div class="pvp-feedback" id="pvpEventFeedback"></div>
    </div>
    <div class="pvp-actions">
      <a class="accountBtn pvp-hidden" id="pvpLoginBtn" href="/auth/linuxdo/start?returnTo=%2F">登录后使用 PVP</a>
      <button class="accountBtn secondary" id="pvpRefreshBtn" type="button">刷新 PVP 状态</button>
    </div>
    <div class="pvp-feedback" id="pvpFeedback"></div>
  `;

  accountPanel.insertAdjacentElement('beforebegin', panel);
  return panel;
}

function getElements() {
  const panel = ensurePanel();
  if (!panel) return null;

  return {
    panel,
    title: document.getElementById('pvpPanelTitle'),
    meta: document.getElementById('pvpPanelMeta'),
    socketStatus: document.getElementById('pvpSocketStatus'),
    modeButtons: Array.from(document.querySelectorAll('#pvpModeButtons [data-mode]')),
    mapButtons: Array.from(document.querySelectorAll('#pvpMapButtons [data-map-selection]')),
    createRoomButton: document.getElementById('pvpCreateRoomBtn'),
    joinRoomCode: document.getElementById('pvpJoinRoomCode'),
    joinRoomButton: document.getElementById('pvpJoinRoomBtn'),
    spectateRoomButton: document.getElementById('pvpSpectateRoomBtn'),
    queueButton: document.getElementById('pvpQueueBtn'),
    cancelQueueButton: document.getElementById('pvpCancelQueueBtn'),
    queueMeta: document.getElementById('pvpQueueMeta'),
    roomCard: document.getElementById('pvpRoomCard'),
    roomMeta: document.getElementById('pvpRoomMeta'),
    roomCodeWrap: document.getElementById('pvpRoomCodeWrap'),
    roomCodeValue: document.getElementById('pvpRoomCodeValue'),
    copyRoomCodeButton: document.getElementById('pvpCopyRoomCodeBtn'),
    roomMembers: document.getElementById('pvpRoomMembers'),
    readyButton: document.getElementById('pvpReadyBtn'),
    startButton: document.getElementById('pvpStartBtn'),
    leaveButton: document.getElementById('pvpLeaveBtn'),
    matchCard: document.getElementById('pvpMatchCard'),
    matchMeta: document.getElementById('pvpMatchMeta'),
    matchDetails: document.getElementById('pvpMatchDetails'),
    surrenderButton: document.getElementById('pvpSurrenderBtn'),
    replayCard: document.getElementById('pvpReplayCard'),
    replayMeta: document.getElementById('pvpReplayMeta'),
    replayList: document.getElementById('pvpReplayList'),
    loginButton: document.getElementById('pvpLoginBtn'),
    refreshButton: document.getElementById('pvpRefreshBtn'),
    feedback: document.getElementById('pvpFeedback'),
    eventCard: document.getElementById('pvpEventCard'),
    eventPhase: document.getElementById('pvpEventPhase'),
    eventMeta: document.getElementById('pvpEventMeta'),
    eventSignupButton: document.getElementById('pvpEventSignupBtn'),
    eventBoardButtons: Array.from(document.querySelectorAll('#pvpEventBoardTabs [data-board]')),
    eventPersonal: document.getElementById('pvpEventPersonal'),
    eventRanking: document.getElementById('pvpEventRanking'),
    eventFeedback: document.getElementById('pvpEventFeedback')
  };
}

function getReturnTo() {
  const path = `${window.location.pathname}${window.location.search}`;
  return encodeURIComponent(path || '/');
}

function getModeLabel(mode) {
  return mode === 'deathmatch' ? '4人乱斗' : '1v1 对决';
}

function getMapSelectionLabel(mapSelection) {
  return getPvpMapLabel(normalizePvpMapSelection(mapSelection, PVP_DEFAULT_MAP_SELECTION));
}

function persistSelectedMapSelection(mapSelection) {
  const normalizedSelection = normalizePvpMapSelection(mapSelection, PVP_DEFAULT_MAP_SELECTION);
  state.selectedMapSelection = normalizedSelection;
  try {
    window.localStorage?.setItem?.(MAP_SELECTION_STORAGE_KEY, normalizedSelection);
  } catch {}
}

function syncSelectedMapSelection(...sources) {
  for (const source of sources) {
    const normalized = normalizePvpMapSelection(
      source?.mapSelection ?? source?.mapId ?? null,
      null
    );
    if (normalized) {
      persistSelectedMapSelection(normalized);
      return normalized;
    }
  }
  return state.selectedMapSelection;
}

function getRoomStatusLabel(status) {
  if (status === 'idle') return '等待加入';
  if (status === 'full') return '人数已满';
  if (status === 'ready') return '全员就绪';
  if (status === 'starting') return '正在开战';
  if (status === 'in_match') return '对局进行中';
  return status || '未知';
}

function getMatchStatusLabel(status) {
  if (status === 'active') return '进行中';
  if (status === 'ended') return '已结束';
  return status || '未知';
}

function getEventPhaseTone(phase) {
  if (phase === 'signup') return 'ready';
  if (phase === 'live') return 'live';
  if (phase === 'ended') return 'offline';
  return '';
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatEventWindow(event) {
  if (!event?.startsAt || !event?.endsAt) {
    return '活动时间未配置。';
  }

  return `报名开始 ${formatDateTime(event.signupStartsAt || event.startsAt)} · 开赛 ${formatDateTime(
    event.startsAt
  )} · 截止 ${formatDateTime(event.endsAt)}`;
}

function formatSignedScore(value) {
  const score = Number(value || 0);
  return score > 0 ? `+${score}` : `${score}`;
}

function formatEventScoringSummary(scoring) {
  if (!scoring?.modes) {
    return '';
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
    `1v1 胜${formatSignedScore(duel.win)} / 负${formatSignedScore(duel.loss)} / 击杀${formatSignedScore(duel.kill)}${duelTransferText}`,
    `4人 胜${formatSignedScore(deathmatch.win)} / MVP ${formatSignedScore(deathmatch.mvp)} / 击杀${formatSignedScore(deathmatch.kill)} / 负${formatSignedScore(deathmatch.loss)}${deathmatchTransferText}`
  ]
    .filter(Boolean)
    .join(' · ');
}

function formatLeaderboardSummary(entry) {
  if (!entry) {
    return '暂无成绩';
  }

  const duelMatches = Number(entry.byMode?.duel?.matchesPlayed || 0);
  const deathmatchMatches = Number(entry.byMode?.deathmatch?.matchesPlayed || 0);
  const qualificationText = entry.qualified
    ? ''
    : Number(entry.matchesNeeded || 0) > 0
      ? ` · 还差 ${Number(entry.matchesNeeded || 0)} 场进正式榜`
      : ' · 未进正式榜';
  const rankText = entry.qualified ? (entry.rank ? `第 ${entry.rank} 名` : '已达正式榜资格') : '未上榜';
  return `${rankText} · ${Number(entry.score || 0)} 杯 · ${Number(entry.wins || 0)}W/${Number(
    entry.losses || 0
  )}L · 共 ${Number(entry.matchesPlayed || 0)} 场 · 1v1 ${duelMatches} / 4人 ${deathmatchMatches}${qualificationText}`;
}

function getReconnectLabel(deadline) {
  if (!deadline) return '在线中';
  const remainingMs = new Date(deadline).getTime() - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return '重连宽限已到';
  }
  return `重连剩余 ${Math.max(0, remainingMs / 1000).toFixed(1)}s`;
}

function getSortedMatchPlayers(match) {
  const players = Array.isArray(match?.snapshot?.players) ? [...match.snapshot.players] : [];
  const mode = match?.mode || 'duel';
  return players.sort((left, right) => {
    if (mode === 'deathmatch') {
      const eliminationDiff = Number(Boolean(left.eliminated)) - Number(Boolean(right.eliminated));
      if (eliminationDiff !== 0) return eliminationDiff;
      const livesDiff = (right.lives ?? 0) - (left.lives ?? 0);
      if (livesDiff !== 0) return livesDiff;
      const killDiff = (right.kills ?? 0) - (left.kills ?? 0);
      if (killDiff !== 0) return killDiff;
      const hpDiff = (right.hp ?? 0) - (left.hp ?? 0);
      if (hpDiff !== 0) return hpDiff;
      return (left.deaths ?? 0) - (right.deaths ?? 0);
    }

    const aliveDiff = Number(Boolean(right.alive)) - Number(Boolean(left.alive));
    if (aliveDiff !== 0) return aliveDiff;
    const hpDiff = (right.hp ?? 0) - (left.hp ?? 0);
    if (hpDiff !== 0) return hpDiff;
    const killDiff = (right.kills ?? 0) - (left.kills ?? 0);
    if (killDiff !== 0) return killDiff;
    return (left.deaths ?? 0) - (right.deaths ?? 0);
  });
}

function createMatchPlayerRow(player, mode, localUserId) {
  const item = document.createElement('li');
  item.className = 'pvp-member';
  item.classList.toggle('is-self', String(player.userId) === String(localUserId));
  item.classList.toggle('is-down', Boolean(player.eliminated || !player.alive));

  const identity = document.createElement('div');
  const name = document.createElement('strong');
  name.textContent = player.displayName || player.username || player.userId || 'Player';
  const subline = document.createElement('small');
  subline.textContent = player.username || player.userId || '-';
  identity.append(name, subline);

  const stats = document.createElement('div');
  stats.className = 'pvp-match-stats';
  if (String(player.userId) === String(localUserId)) stats.appendChild(createPill('你', 'live'));
  if (player.connected === false) stats.appendChild(createPill('离线', 'offline'));
  if (player.eliminated) {
    stats.appendChild(createPill('已淘汰', 'offline'));
  } else if (!player.alive) {
    const respawnSeconds = Number(player.respawnSeconds || 0);
    stats.appendChild(createPill(respawnSeconds > 0 ? `复活 ${respawnSeconds.toFixed(1)}s` : '待复活'));
  } else {
    stats.appendChild(createPill('存活', 'ready'));
  }
  if (mode === 'deathmatch') {
    stats.appendChild(createPill(`命 ${Math.max(0, Number(player.lives ?? 0))}`));
  }
  stats.appendChild(createPill(`K ${Math.max(0, Number(player.kills ?? 0))}`));
  stats.appendChild(createPill(`D ${Math.max(0, Number(player.deaths ?? 0))}`));

  item.append(identity, stats);
  return item;
}

function mapErrorMessage(code) {
  const messages = {
    pvp_disabled: 'PVP Beta 当前未开放。',
    matchmaking_disabled: '公开匹配当前已关闭。',
    pvp_mode_disabled: '当前模式已被后台关闭。',
    already_in_room: '你已经在房间里了。',
    already_in_queue: '你已经在匹配队列中了。',
    already_in_match: '你已经在一场在线 PVP 对局里了。',
    room_not_found: '没有找到对应房间。',
    room_full: '房间已满，无法加入。',
    room_not_ready: '人数不足，或者还有玩家未准备。',
    not_room_host: '只有房主才能开始。',
    queue_not_found: '当前不在匹配队列中。',
    room_limit_reached: '当前活跃房间数已达上限，请稍后再试。',
    room_expired: '房间长时间未开始，已自动失效。',
    room_empty: '房间已清空。',
    matchmaking_expired: '匹配等待超时，已自动取消。',
    room_already_started: '这个房间已经进入在线对局。',
    match_not_found: '没有找到当前在线对局。',
    match_not_live: '这个房间还没有可观赛的正在进行对局。',
    disconnect_timeout: '重连宽限已超时，这局已按掉线处理。',
    spectator_read_only: '观赛模式是只读的，不能控制玩家或投降。',
    invalid_ws_message: '实时消息格式不正确。',
    pvp_event_disabled: '42 杯活动当前未开启。',
    pvp_event_not_configured: '42 杯活动时间还没有配置完成。',
    pvp_event_signup_not_open: '当前不在 42 杯报名时间内。',
    pvp_event_already_signed_up: '你已经报过名了。'
  };

  return messages[code] || code || '请求失败';
}

function setFeedback(message, tone = '') {
  state.feedback = {
    message: message || '',
    tone: tone || ''
  };

  const elements = getElements();
  if (!elements?.feedback) return;
  elements.feedback.textContent = state.feedback.message;
  elements.feedback.dataset.tone = state.feedback.tone;
}

function setEventFeedback(message, tone = '') {
  const elements = getElements();
  if (!elements?.eventFeedback) return;
  elements.eventFeedback.textContent = message || '';
  elements.eventFeedback.dataset.tone = tone;
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

function createDefaultTransport() {
  return {
    mode: 'same-origin',
    apiBaseUrl: '',
    accessToken: '',
    expiresAt: null
  };
}

function buildApiUrl(url, baseUrl = '') {
  if (!baseUrl) {
    return url;
  }
  return new URL(String(url || '/'), `${String(baseUrl).replace(/\/+$/u, '')}/`).toString();
}

async function apiRequest(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');

  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  if (options.authToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${options.authToken}`);
  }

  const requestUrl = buildApiUrl(url, options.baseUrl || '');

  const response = await fetch(requestUrl, {
    credentials: options.credentials || (options.authToken ? 'omit' : 'same-origin'),
    ...options,
    headers
  });

  return parseResponse(response);
}

function buildAuthorizedWsUrl(url, accessToken = '') {
  if (!url) return '';
  if (!accessToken) return url;
  const target = new URL(url, window.location.origin);
  target.searchParams.set('pvp_access_token', accessToken);
  return target.toString();
}

async function requestPvpApi(url, options = {}) {
  return apiRequest(url, {
    ...options,
    baseUrl: state.transport?.apiBaseUrl || '',
    authToken: state.transport?.accessToken || '',
    credentials: state.transport?.accessToken ? 'omit' : 'same-origin'
  });
}

function emitExternalState() {
  window.dispatchEvent(new CustomEvent('shooters-pvp-state-changed', {
    detail: {
      session: state.session,
      config: state.config,
      currentRoom: state.currentRoom,
      currentQueue: state.currentQueue,
      currentMatch: state.currentMatch
    }
  }));
}

function getSelfMember() {
  if (!state.session?.user || !state.currentRoom?.members) return null;
  return state.currentRoom.members.find((member) => String(member.userId) === String(state.session.user.id)) || null;
}

function clearReconnectTimer() {
  if (!state.reconnectTimer) return;
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
}

function closeSocket(manual = false) {
  clearReconnectTimer();
  if (!state.socket) return;
  const socket = state.socket;
  state.socket = null;
  state.socketConnected = false;
  if (manual) socket.__manualClose = true;
  try {
    socket.close();
  } catch {}
}

function scheduleReconnect() {
  if (!state.session?.authenticated || !state.wsUrl) return;
  if (state.reconnectTimer) return;
  state.reconnectTimer = window.setTimeout(() => {
    state.reconnectTimer = null;
    connectSocket();
  }, 1500);
}

function subscribeToCurrentMatch() {
  if (!state.socketConnected || !state.socket || !state.currentMatch?.matchId) return;
  state.socket.send(JSON.stringify({
    type: 'pvp.match.subscribe',
    matchId: state.currentMatch.matchId
  }));
}

function updateMatchStateFromPayload(payload) {
  if (!payload) return;
  state.currentMatch = {
    ...(state.currentMatch || {}),
    matchId: payload.matchId || state.currentMatch?.matchId || null,
    roomCode: payload.roomCode || state.currentMatch?.roomCode || null,
    mode: payload.mode || state.currentMatch?.mode || null,
    status: payload.status || state.currentMatch?.status || 'active',
    role: payload.role || state.currentMatch?.role || 'player',
    seat: payload.seat ?? state.currentMatch?.seat ?? null,
    team: payload.team ?? state.currentMatch?.team ?? null,
    reconnectDeadline: payload.reconnectDeadline || null,
    startedAt: payload.startedAt || state.currentMatch?.startedAt || null,
    mapSelection: payload.mapSelection || state.currentMatch?.mapSelection || null,
    mapId: payload.mapId || payload.snapshot?.mapId || state.currentMatch?.mapId || null,
    snapshot: payload.snapshot || state.currentMatch?.snapshot || null,
    scoreboard: payload.scoreboard || state.currentMatch?.scoreboard || null,
    spectatorCount: payload.spectatorCount ?? state.currentMatch?.spectatorCount ?? 0
  };
  syncSelectedMapSelection(state.currentMatch);
}

function handleSocketMessage(payload) {
  if (!payload || typeof payload !== 'object') return;

  if (payload.type === 'pvp.session.synced') {
    state.config = payload.config || state.config;
    state.currentRoom = payload.currentRoom || null;
    state.currentQueue = payload.currentQueue || null;
    state.currentMatch = payload.currentMatch || null;
    state.wsUrl = payload.wsUrl || state.wsUrl;
    if (payload.currentRoom?.mode) {
      state.selectedMode = payload.currentRoom.mode;
    } else if (payload.currentQueue?.mode) {
      state.selectedMode = payload.currentQueue.mode;
    } else if (payload.currentMatch?.mode) {
      state.selectedMode = payload.currentMatch.mode;
    }
    syncSelectedMapSelection(payload.currentRoom, payload.currentQueue, payload.currentMatch);
    render();
    if (state.currentMatch?.matchId) {
      subscribeToCurrentMatch();
    }
    return;
  }

  if (payload.type === 'pvp.room.updated') {
    state.currentRoom = payload.room || null;
    syncSelectedMapSelection(state.currentRoom, state.currentQueue, state.currentMatch);
    render();
    return;
  }

  if (payload.type === 'pvp.queue.updated') {
    state.currentQueue = payload.queue || null;
    syncSelectedMapSelection(state.currentQueue, state.currentRoom, state.currentMatch);
    render();
    return;
  }

  if (payload.type === 'pvp.match.found') {
    state.currentRoom = payload.room || null;
    state.currentQueue = null;
    setFeedback(`已匹配到 ${getModeLabel(payload.room?.mode)} 房间，等待全员准备。`, 'ok');
    render();
    return;
  }

  if (payload.type === 'pvp.room.starting') {
    setFeedback('房主已发起开战，正在建立实时对局。', 'ok');
    render();
    return;
  }

  if (payload.type === 'pvp.match.started') {
    updateMatchStateFromPayload(payload);
    window.dispatchEvent(new CustomEvent('shooters-pvp-match-started', {
      detail: payload
    }));
    setFeedback(
      payload.role === 'spectator'
        ? `已进入 ${getModeLabel(payload.mode)} 观赛。`
        : `实时 ${getModeLabel(payload.mode)} 对局已开始。`,
      'ok'
    );
    render();
    return;
  }

  if (payload.type === 'pvp.match.snapshot') {
    updateMatchStateFromPayload({
      ...payload,
      status: payload.status || 'active',
      snapshot: payload,
      scoreboard: payload.scoreboard || null
    });
    window.dispatchEvent(new CustomEvent('shooters-pvp-match-snapshot', {
      detail: payload
    }));
    render();
    return;
  }

  if (payload.type === 'pvp.match.event') {
    window.dispatchEvent(new CustomEvent('shooters-pvp-match-event', {
      detail: payload
    }));
    return;
  }

  if (payload.type === 'pvp.match.ended') {
    const role = state.currentMatch?.role || payload.role || 'player';
    const detail = payload.result ? { ...payload.result, mode: payload.mode, role } : { ...payload, role };
    state.currentMatch = null;
    window.dispatchEvent(new CustomEvent('shooters-pvp-match-ended', {
      detail
    }));
    setFeedback(role === 'spectator' ? '本场观赛已结束。' : '在线 PVP 对局已结束。', 'ok');
    refreshState({ preserveFeedback: true }).catch(() => {});
    render();
    return;
  }

  if (payload.type === 'pvp.match.aborted') {
    const role = state.currentMatch?.role || payload.role || 'player';
    state.currentMatch = null;
    window.dispatchEvent(new CustomEvent('shooters-pvp-match-aborted', {
      detail: {
        ...payload,
        role
      }
    }));
    setFeedback(role === 'spectator' ? '观赛已被中断。' : '当前在线 PVP 对局已中断。', 'warn');
    refreshState({ preserveFeedback: true }).catch(() => {});
    render();
    return;
  }

  if (payload.type === 'pvp.error') {
    setFeedback(mapErrorMessage(payload.error), payload.error?.includes?.('disabled') ? 'warn' : 'error');
    render();
  }
}

function connectSocket() {
  if (!state.session?.authenticated || !state.wsUrl) return;
  if (state.socket && (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  clearReconnectTimer();

  const socketUrl = buildAuthorizedWsUrl(state.wsUrl, state.transport?.accessToken || '');
  if (!socketUrl) return;
  const socket = new WebSocket(socketUrl);
  state.socket = socket;
  render();

  socket.addEventListener('open', () => {
    state.socketConnected = true;
    socket.send(JSON.stringify({ type: 'pvp.hello' }));
    if (state.currentMatch?.matchId) {
      subscribeToCurrentMatch();
    }
    render();
  });

  socket.addEventListener('message', (event) => {
    try {
      handleSocketMessage(JSON.parse(String(event.data || '{}')));
    } catch {
      setFeedback('PVP 实时消息解析失败。', 'error');
    }
  });

  socket.addEventListener('close', () => {
    const manual = Boolean(socket.__manualClose);
    if (state.socket === socket) {
      state.socket = null;
    }
    state.socketConnected = false;
    render();
    if (!manual) {
      scheduleReconnect();
    }
  });

  socket.addEventListener('error', () => {
    setFeedback('PVP 实时连接异常，正在自动重连。', 'warn');
  });
}

function createEventRankingRow(entry, currentUserId) {
  const item = document.createElement('li');
  item.className = 'pvp-rank-row';

  const index = document.createElement('span');
  index.className = 'pvp-rank-index';
  index.textContent = `#${Number(entry.rank || 0)}`;

  const main = document.createElement('div');
  main.className = 'pvp-rank-main';
  const name = document.createElement('strong');
  name.textContent = entry.user?.displayName || entry.user?.username || entry.user?.id || '玩家';
  const subline = document.createElement('small');
  subline.textContent = entry.user?.username || entry.user?.id || '-';
  main.append(name, subline);

  const stats = document.createElement('div');
  stats.className = 'pvp-rank-stats';
  if (String(entry.user?.id || '') === String(currentUserId || '')) {
    stats.appendChild(createPill('我', 'live'));
  }
  stats.appendChild(createPill(`${Number(entry.score || 0)} 杯`, 'ready'));
  stats.appendChild(createPill(`${Number(entry.wins || 0)}W/${Number(entry.losses || 0)}L`));
  stats.appendChild(createPill(`场 ${Number(entry.matchesPlayed || 0)}`));
  stats.appendChild(createPill(`MVP ${Number(entry.mvps || 0)}`));
  stats.appendChild(createPill(`K ${Number(entry.kills || 0)}`));

  item.append(index, main, stats);
  return item;
}

function renderEventCard(elements) {
  if (!elements?.eventCard) return;

  const payload = state.eventData || null;
  const event = payload?.event || null;
  const currentUser = payload?.currentUser || null;
  const activeBoard = state.eventBoard === 'global' ? 'global' : 'event';
  const items = Array.isArray(payload?.leaderboards?.[activeBoard]) ? payload.leaderboards[activeBoard] : [];
  const scoring = event?.scoring || null;
  const minMatches = Math.max(0, Math.floor(Number(scoring?.leaderboardMinMatches || 0)));
  const scoringText = formatEventScoringSummary(scoring);

  for (const button of elements.eventBoardButtons) {
    const active = button.dataset.board === activeBoard;
    button.classList.toggle('active', active);
  }

  elements.eventRanking.replaceChildren();

  if (!event) {
    elements.eventPhase.textContent = '未开启';
    elements.eventPhase.className = 'pvp-pill';
    elements.eventMeta.textContent = '当前没有可用的 42 杯活动信息。';
    elements.eventPersonal.textContent = '42 杯活动信息加载失败。';
    elements.eventSignupButton.disabled = true;
    elements.eventSignupButton.textContent = '42 杯未开放';
    return;
  }

  elements.eventPhase.textContent = event.phaseLabel || '未开启';
  elements.eventPhase.className = `pvp-pill${getEventPhaseTone(event.phase) ? ` ${getEventPhaseTone(event.phase)}` : ''}`;
  elements.eventMeta.textContent = `${event.description || '42 杯为单独报名参加的限时 PVP 活动。'} · ${formatEventWindow(
    event
  )} · 已报名 ${Number(event.signupCount || 0)} 人${scoringText ? ` · ${scoringText}` : ''}`;

  if (!state.session?.authenticated) {
    const canSignUp = event.phase === 'signup' || event.phase === 'live';
    elements.eventSignupButton.disabled = !canSignUp;
    elements.eventSignupButton.textContent = canSignUp ? '登录后报名 42 杯' : '42 杯未开放报名';
    elements.eventPersonal.textContent = canSignUp
      ? '登录后可立即报名。只统计你报名成功后开始的 PVP 对局。'
      : '登录后可查看报名状态、个人排名和当前积分。';
  } else if (event.signedUp) {
    elements.eventSignupButton.disabled = true;
    elements.eventSignupButton.textContent = '已报名 42 杯';
    elements.eventPersonal.textContent = `我的活动成绩：${formatLeaderboardSummary(currentUser?.event)}${
      currentUser?.event?.signedUpAt ? ` · 报名于 ${formatDateTime(currentUser.event.signedUpAt)}` : ''
    }`;
  } else if (event.canSignUp) {
    elements.eventSignupButton.disabled = state.busy;
    elements.eventSignupButton.textContent = event.phase === 'live' ? '开赛后加入 42 杯' : '报名参加 42 杯';
    elements.eventPersonal.textContent =
      event.phase === 'live'
        ? '比赛已开始，但仍可加入。本次只统计你报名成功后开始的 PVP 对局。'
        : '当前处于报名阶段，报名成功后只统计你报名后的 PVP 战绩。';
  } else {
    elements.eventSignupButton.disabled = true;
    elements.eventSignupButton.textContent = event.phase === 'live' ? '比赛已开赛' : '报名未开放';
    elements.eventPersonal.textContent =
      event.phase === 'live'
        ? '当前已开赛，你未报名本期 42 杯。'
        : event.phase === 'ended'
          ? currentUser?.signedUp
            ? `活动已结束。我的活动成绩：${formatLeaderboardSummary(currentUser?.event)}`
            : '活动已结束，你未报名本期 42 杯。'
          : '当前还未到 42 杯报名时间。';
  }

  if (!items.length) {
    const empty = document.createElement('li');
    empty.className = 'pvp-rank-empty';
    empty.textContent =
      activeBoard === 'event'
        ? minMatches > 0
          ? `活动正式榜至少需要 ${minMatches} 场，目前还没有达标战绩。`
          : '活动榜暂时还没有有效战绩。'
        : minMatches > 0
          ? `全服正式榜至少需要 ${minMatches} 场，目前还没有达标战绩。`
          : '活动时间窗内的全服榜暂时还没有有效战绩。';
    elements.eventRanking.appendChild(empty);
    return;
  }

  for (const entry of items) {
    elements.eventRanking.appendChild(createEventRankingRow(entry, state.session?.user?.id));
  }
}

function renderReplayCard(elements) {
  if (!elements?.replayCard || !elements.replayList || !elements.replayMeta) return;

  const items = Array.isArray(state.replays) ? state.replays : [];
  elements.replayList.replaceChildren();

  if (!state.session?.authenticated) {
    elements.replayMeta.textContent = '登录后可查看你参与的 PVP 回放。';
    const empty = document.createElement('div');
    empty.className = 'pvp-replay-empty';
    empty.textContent = '当前未登录。';
    elements.replayList.appendChild(empty);
    return;
  }

  elements.replayMeta.textContent = items.length
    ? `最近 ${items.length} 场你参与的 PVP 对局回放。`
    : '当前还没有可查看的 PVP 回放。';

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'pvp-replay-empty';
    empty.textContent = '当前还没有可查看的 PVP 回放。';
    elements.replayList.appendChild(empty);
    return;
  }

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'pvp-replay-row';

    const head = document.createElement('strong');
    head.textContent = `${getModeLabel(item.match?.mode)} · ${formatDateTime(item.match?.completedAt || item.match?.recordedAt || item.match?.startedAt)}`;
    head.appendChild(createPill(item.replay?.available ? '可播放' : '仅摘要', item.replay?.available ? 'live' : ''));

    const detail = document.createElement('small');
    const participants = Array.isArray(item.participants)
      ? item.participants.map((player) => player.displayName || player.username || player.userId).join(' / ')
      : '-';
    const eventSummary = item.eventSummary?.enabled
      ? `42杯 ${item.eventSummary.counted ? '计入' : '未计入'} · 积分 ${Number(item.eventSummary.scoreDelta || 0)}${item.eventSummary.rankAfterMatch != null ? ` · 排名 #${Number(item.eventSummary.rankAfterMatch)}` : ''}`
      : '42杯未开启';
    detail.textContent = `${participants} | ${eventSummary}`;

    const actions = document.createElement('div');
    actions.className = 'pvp-replay-actions';

    if (item.replay?.available) {
      const spectateButton = document.createElement('button');
      spectateButton.className = 'accountBtn';
      spectateButton.type = 'button';
      spectateButton.dataset.pvpReplaySpectate = '1';
      spectateButton.dataset.matchId = item.matchId;
      spectateButton.textContent = '直播式回放';
      actions.appendChild(spectateButton);

      const analysisButton = document.createElement('button');
      analysisButton.className = 'accountBtn secondary';
      analysisButton.type = 'button';
      analysisButton.dataset.pvpReplayOpen = '1';
      analysisButton.dataset.matchId = item.matchId;
      analysisButton.textContent = '分析回放';
      actions.appendChild(analysisButton);
    } else {
      const summaryButton = document.createElement('button');
      summaryButton.className = 'accountBtn secondary';
      summaryButton.type = 'button';
      summaryButton.dataset.pvpReplayOpen = '1';
      summaryButton.dataset.matchId = item.matchId;
      summaryButton.textContent = '查看摘要';
      actions.appendChild(summaryButton);
    }

    row.append(head, detail, actions);
    elements.replayList.appendChild(row);
  }
}

function render() {
  const elements = getElements();
  if (!elements) return;

  const loginHref = `/auth/linuxdo/start?returnTo=${getReturnTo()}`;
  elements.loginButton.href = loginHref;
  elements.socketStatus.textContent = state.socketConnected ? '实时已连接' : '实时未连接';

  const selfMember = getSelfMember();
  const pvpEnabled = Boolean(state.config?.enabled);
  const matchmakingEnabled = Boolean(state.config?.matchmakingEnabled);
  const hasLiveMatch = Boolean(state.currentMatch?.matchId);
  const isSpectating = state.currentMatch?.role === 'spectator';

  for (const button of elements.modeButtons) {
    const active = button.dataset.mode === state.selectedMode;
    button.classList.toggle('active', active);
    button.disabled = state.busy || Boolean(state.currentRoom) || Boolean(state.currentQueue) || hasLiveMatch;
  }

  for (const button of elements.mapButtons) {
    const active = button.dataset.mapSelection === state.selectedMapSelection;
    button.classList.toggle('active', active);
    button.disabled = state.busy || Boolean(state.currentRoom) || Boolean(state.currentQueue) || hasLiveMatch;
  }

  if (!state.session?.authenticated) {
    elements.title.textContent = '在线 PVP 房间';
    elements.meta.textContent = '登录后才能创建房间、加入房间或进入匹配。';
    elements.loginButton.classList.remove('pvp-hidden');
    elements.createRoomButton.disabled = true;
    elements.joinRoomButton.disabled = true;
    elements.spectateRoomButton.disabled = true;
    elements.joinRoomCode.disabled = true;
    elements.queueButton.disabled = true;
    elements.cancelQueueButton.disabled = true;
    elements.readyButton.disabled = true;
    elements.startButton.disabled = true;
    elements.leaveButton.disabled = true;
    elements.surrenderButton.disabled = true;
    elements.queueMeta.textContent = '当前未登录。';
    elements.roomMeta.textContent = '登录后可查看和管理你的 PVP 房间。';
    elements.matchMeta.textContent = '登录并进入实时对局后，这里会显示当前 matchId、模式和重连状态。';
    elements.matchDetails.replaceChildren();
    elements.roomCodeWrap.classList.add('pvp-hidden');
    elements.roomCodeValue.textContent = '-';
    elements.roomMembers.replaceChildren();
    renderReplayCard(elements);
    renderEventCard(elements);
    setFeedback(state.feedback.message, state.feedback.tone);
    emitExternalState();
    return;
  }

  elements.loginButton.classList.add('pvp-hidden');

  elements.title.textContent = pvpEnabled ? '在线 PVP 房间' : 'PVP Beta 未开放';
  elements.meta.textContent = !pvpEnabled
    ? '管理员还没有开启 PVP Beta。'
    : state.config?.rewardEnabled
      ? 'PVP Beta 已开放。当前已启用服务端权威 PVP 奖励结算，胜方 MVP 可领取 PVP CDK。'
      : 'PVP Beta 已开放，PVP 奖励当前默认关闭，只保留实时对战与历史记录。';

  elements.createRoomButton.disabled = state.busy || !pvpEnabled || Boolean(state.currentRoom) || Boolean(state.currentQueue) || hasLiveMatch;
  elements.joinRoomButton.disabled = state.busy || !pvpEnabled || Boolean(state.currentRoom) || Boolean(state.currentQueue) || hasLiveMatch;
  elements.spectateRoomButton.disabled = state.busy || !pvpEnabled || Boolean(state.currentRoom) || Boolean(state.currentQueue) || hasLiveMatch;
  elements.joinRoomCode.disabled = elements.joinRoomButton.disabled;
  elements.queueButton.disabled = state.busy || !pvpEnabled || !matchmakingEnabled || Boolean(state.currentRoom) || Boolean(state.currentQueue) || hasLiveMatch;
  elements.cancelQueueButton.disabled = state.busy || !state.currentQueue;
  elements.readyButton.disabled = state.busy || !state.currentRoom || hasLiveMatch;
  elements.leaveButton.disabled = state.busy || !state.currentRoom || hasLiveMatch;
  elements.startButton.disabled = state.busy || !state.currentRoom || !selfMember?.isHost || !state.currentRoom.canStart || hasLiveMatch;
  elements.surrenderButton.disabled = state.busy || !hasLiveMatch;
  elements.surrenderButton.textContent = isSpectating ? '退出观赛' : '投降并退出本局';

  elements.queueMeta.textContent = state.currentQueue
    ? `正在排队 ${getModeLabel(state.currentQueue.mode)}，当前队列约 ${Number(state.currentQueue.estimatedSize || 0)} 人。`
    : !matchmakingEnabled
      ? '公开匹配当前已关闭，只能使用房间码约战。'
      : `当前未在匹配队列中。可按所选模式进入 ${getModeLabel(state.selectedMode)}。`;

  if (state.currentQueue) {
    elements.queueMeta.textContent += ` | Map ${getMapSelectionLabel(state.currentQueue.mapSelection)}`;
  } else if (!state.currentRoom && !hasLiveMatch) {
    elements.queueMeta.textContent += ` | Map ${getMapSelectionLabel(state.selectedMapSelection)}`;
  }

  elements.roomMeta.textContent = state.currentRoom
    ? `房间码 ${state.currentRoom.roomCode} · ${getModeLabel(state.currentRoom.mode)} · ${state.currentRoom.members.length}/${state.currentRoom.capacity} 人 · ${getRoomStatusLabel(state.currentRoom.status)}`
    : '当前不在任何 PVP 房间中。';

  if (state.currentRoom) {
    elements.roomMeta.textContent += ` | Map ${getMapSelectionLabel(state.currentRoom.mapSelection)}`;
  }

  if (state.currentRoom?.roomCode) {
    elements.roomCodeWrap.classList.remove('pvp-hidden');
    elements.roomCodeValue.textContent = state.currentRoom.roomCode;
  } else {
    elements.roomCodeWrap.classList.add('pvp-hidden');
    elements.roomCodeValue.textContent = '-';
  }

  elements.roomMembers.replaceChildren();
  for (const member of state.currentRoom?.members || []) {
    const item = document.createElement('li');
    item.className = 'pvp-member';

    const identity = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = member.displayName || member.username || member.userId || 'Player';
    const subline = document.createElement('small');
    subline.textContent = member.username || member.userId || '-';
    identity.append(name, subline);

    const tags = document.createElement('div');
    tags.className = 'pvp-member-tags';
    if (member.isHost) tags.appendChild(createPill('房主'));
    tags.appendChild(createPill(member.isReady ? '已准备' : '未准备', member.isReady ? 'ready' : ''));
    tags.appendChild(createPill(member.presence === 'offline' ? '离线' : '在线', member.presence === 'offline' ? 'offline' : ''));

    item.append(identity, tags);
    elements.roomMembers.appendChild(item);
  }

  if (selfMember) {
    elements.readyButton.textContent = selfMember.isReady ? '取消准备' : '准备';
  } else {
    elements.readyButton.textContent = '准备';
  }

  elements.matchDetails.replaceChildren();
  if (hasLiveMatch) {
    elements.matchMeta.textContent = `${getModeLabel(state.currentMatch.mode)} · matchId ${state.currentMatch.matchId} · 当前状态 ${state.currentMatch.status || 'active'}`;
    appendMatchLine(elements.matchDetails, `阵营：${state.currentMatch.team || '-'}`);
    appendMatchLine(elements.matchDetails, `席位：${state.currentMatch.seat ?? '-'}`);
    appendMatchLine(elements.matchDetails, `重连截止：${state.currentMatch.reconnectDeadline ? new Date(state.currentMatch.reconnectDeadline).toLocaleTimeString() : '在线中'}`);
  } else {
    elements.matchMeta.textContent = '当前没有进行中的在线 PVP 对局。';
  }

  if (hasLiveMatch) {
    const sortedPlayers = getSortedMatchPlayers(state.currentMatch);
    const leader = sortedPlayers[0] || null;
    const alivePlayers = sortedPlayers.filter((player) => !player.eliminated).length;
    const roleLabel = isSpectating ? '观赛中' : '对局中';

    elements.matchDetails.replaceChildren();
    elements.matchMeta.textContent = `${getModeLabel(state.currentMatch.mode)} · ${roleLabel} · matchId ${state.currentMatch.matchId} · 当前状态 ${getMatchStatusLabel(state.currentMatch.status || 'active')}`;
    appendMatchLine(elements.matchDetails, `身份：${isSpectating ? '观众' : '玩家'}`);
    appendMatchLine(elements.matchDetails, `房间码：${state.currentMatch.roomCode || '-'}`);
    appendMatchLine(elements.matchDetails, `观赛人数：${Math.max(0, Number(state.currentMatch.spectatorCount || 0))}`);
    if (!isSpectating) {
      appendMatchLine(elements.matchDetails, `阵营：${state.currentMatch.team || '-'}`);
      appendMatchLine(elements.matchDetails, `席位：${state.currentMatch.seat ?? '-'}`);
      appendMatchLine(elements.matchDetails, `重连：${getReconnectLabel(state.currentMatch.reconnectDeadline)}`);
    }
    appendMatchLine(elements.matchDetails, `Map: ${getMapSelectionLabel(state.currentMatch.mapId || state.currentMatch.mapSelection)}`);
    if (state.currentMatch.mode === 'deathmatch') {
      appendMatchLine(elements.matchDetails, `仍在场上：${alivePlayers}/${sortedPlayers.length}`);
      if (leader) {
        appendMatchLine(
          elements.matchDetails,
          `当前领跑：${leader.displayName || leader.username || leader.userId} · 命 ${Math.max(0, Number(leader.lives ?? 0))} · K ${Math.max(0, Number(leader.kills ?? 0))}`
        );
      }
    }

    for (const player of sortedPlayers) {
      elements.matchDetails.appendChild(
        createMatchPlayerRow(player, state.currentMatch.mode, state.session?.user?.id)
      );
    }
  }

  renderReplayCard(elements);
  renderEventCard(elements);
  setFeedback(state.feedback.message, state.feedback.tone);
  emitExternalState();
}

function createPill(label, className = '') {
  const pill = document.createElement('span');
  pill.className = `pvp-pill${className ? ` ${className}` : ''}`;
  pill.textContent = label;
  return pill;
}

function appendMatchLine(container, text) {
  if (!container) return;
  const item = document.createElement('li');
  item.textContent = text;
  container.appendChild(item);
}

function revealElement(element) {
  if (!element) return;
  window.requestAnimationFrame(() => {
    element.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest'
    });
  });
}

async function copyTextToClipboard(text) {
  const value = String(text || '').trim();
  if (!value) return false;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {}

  const fallback = document.createElement('input');
  fallback.value = value;
  fallback.setAttribute('readonly', 'readonly');
  fallback.style.position = 'absolute';
  fallback.style.left = '-9999px';
  document.body.appendChild(fallback);
  fallback.select();
  fallback.setSelectionRange(0, fallback.value.length);

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }

  fallback.remove();
  return copied;
}

async function refreshState(options = {}) {
  const preserveFeedback = Boolean(options.preserveFeedback);

  try {
    const [session, eventPayload] = await Promise.all([
      apiRequest('/api/auth/session'),
      apiRequest('/api/pvp/event').catch(() => null)
    ]);
    state.session = session;
    state.eventData = eventPayload;

    if (!session.authenticated) {
      state.transport = createDefaultTransport();
      state.config = session.pvpConfig || null;
      state.currentRoom = null;
      state.currentQueue = null;
      state.currentMatch = null;
      state.replays = [];
      state.wsUrl = '';
      closeSocket(true);
      if (!preserveFeedback) setFeedback('');
      setEventFeedback('');
      render();
      return;
    }

    try {
      await refreshTransport(session);
    } catch (error) {
      state.transport = createDefaultTransport();
      if (!preserveFeedback) {
        setFeedback('PVP 加速节点暂时不可用，已回退主站。', 'warn');
      }
    }

    const replayPayload = await apiRequest('/api/pvp/replays?limit=12').catch(() => ({ items: [] }));
    state.replays = Array.isArray(replayPayload?.items) ? replayPayload.items : [];

    let bootstrap;
    try {
      bootstrap = await requestPvpApi('/api/pvp/bootstrap');
    } catch (error) {
      if (state.transport.mode === 'edge') {
        state.transport = createDefaultTransport();
        bootstrap = await requestPvpApi('/api/pvp/bootstrap');
        if (!preserveFeedback) {
          setFeedback('PVP 加速节点暂时不可用，已回退主站。', 'warn');
        }
      } else {
        throw error;
      }
    }

    state.config = bootstrap.config || null;
    state.currentRoom = bootstrap.currentRoom || null;
    state.currentQueue = bootstrap.currentQueue || null;
    state.currentMatch = bootstrap.currentMatch || null;
    state.wsUrl = bootstrap.wsUrl || '';

    if (state.currentRoom?.mode) {
      state.selectedMode = state.currentRoom.mode;
    } else if (state.currentQueue?.mode) {
      state.selectedMode = state.currentQueue.mode;
    } else if (state.currentMatch?.mode) {
      state.selectedMode = state.currentMatch.mode;
    }
    syncSelectedMapSelection(state.currentRoom, state.currentQueue, state.currentMatch);

    if (!preserveFeedback) setFeedback('');
    setEventFeedback('');

    render();
    connectSocket();
  } catch (error) {
    setFeedback(mapErrorMessage(error.message), 'error');
    render();
  }
}

async function submitAction(requestFactory, successMessage) {
  state.busy = true;
  render();

  try {
    const result = await requestFactory();
    const resolvedSuccessMessage = typeof successMessage === 'function'
      ? successMessage(result)
      : successMessage;
    if (result.room !== undefined) state.currentRoom = result.room || null;
    if (result.queue !== undefined) state.currentQueue = result.queue || null;
    if (result.match !== undefined) state.currentMatch = result.match || null;
    await refreshState({ preserveFeedback: true });
    if (state.currentRoom) {
      const elements = getElements();
      revealElement(elements?.roomCard);
    } else if (state.currentMatch) {
      const elements = getElements();
      revealElement(elements?.matchCard);
    }
    if (resolvedSuccessMessage) setFeedback(resolvedSuccessMessage, 'ok');
  } catch (error) {
    setFeedback(mapErrorMessage(error.message), error.message?.includes?.('disabled') ? 'warn' : 'error');
  } finally {
    state.busy = false;
    render();
  }
}

function bindEvents() {
  const elements = getElements();
  if (!elements || elements.panel.dataset.bound === 'true') return;
  elements.panel.dataset.bound = 'true';

  for (const button of elements.modeButtons) {
    button.addEventListener('click', () => {
      state.selectedMode = button.dataset.mode === 'deathmatch' ? 'deathmatch' : 'duel';
      render();
    });
  }

  for (const button of elements.mapButtons) {
    button.addEventListener('click', () => {
      persistSelectedMapSelection(button.dataset.mapSelection);
      render();
    });
  }

  for (const button of elements.eventBoardButtons) {
    button.addEventListener('click', () => {
      state.eventBoard = button.dataset.board === 'global' ? 'global' : 'event';
      render();
    });
  }

  elements.replayList?.addEventListener('click', (event) => {
    const spectateButton = event.target instanceof Element ? event.target.closest('[data-pvp-replay-spectate]') : null;
    if (spectateButton) {
      const matchId = spectateButton.getAttribute('data-match-id') || '';
      void replaySpectator
        .open({
          matchId,
          currentUserId: state.session?.user?.id || ''
        })
        .then(() => {
          setFeedback('已进入直播式回放。', 'ok');
          render();
        })
        .catch((error) => {
          const message = error?.message === 'live_match_active'
            ? '当前正在真实在线对局或观赛，请先退出后再打开回放。'
            : (error?.payload?.error === 'replay_not_available'
              ? '这场回放文件当前不可用，只能查看摘要。'
              : (error?.payload?.error === 'replay_pruned'
                ? '这场回放文件已清理，只能查看摘要。'
                : '打开直播式回放失败。'));
          setFeedback(message, 'warn');
          render();
        });
      return;
    }
    replayViewer.handleListClick(event, state.session?.user?.id || '');
  });

  elements.createRoomButton.addEventListener('click', () => {
    submitAction(
      () => requestPvpApi('/api/pvp/rooms', {
        method: 'POST',
        body: JSON.stringify({
          mode: state.selectedMode,
          mapSelection: state.selectedMapSelection
        })
      }),
      `已创建 ${getModeLabel(state.selectedMode)} 房间。`
    );
  });

  elements.joinRoomButton.addEventListener('click', () => {
    const roomCode = String(elements.joinRoomCode.value || '').trim().toUpperCase();
    submitAction(
      () => requestPvpApi('/api/pvp/rooms/join', {
        method: 'POST',
        body: JSON.stringify({ roomCode })
      }),
      `已加入房间 ${roomCode || ''}。`
    );
  });

  elements.spectateRoomButton.addEventListener('click', () => {
    const roomCode = String(elements.joinRoomCode.value || '').trim().toUpperCase();
    submitAction(
      () => requestPvpApi('/api/pvp/rooms/spectate', {
        method: 'POST',
        body: JSON.stringify({ roomCode })
      }),
      `已进入房间 ${roomCode || ''} 观赛。`
    );
  });

  elements.queueButton.addEventListener('click', () => {
    submitAction(
      () => requestPvpApi('/api/pvp/matchmaking/enqueue', {
        method: 'POST',
        body: JSON.stringify({
          mode: state.selectedMode,
          mapSelection: state.selectedMapSelection
        })
      }),
      `已进入 ${getModeLabel(state.selectedMode)} 匹配队列。`
    );
  });

  elements.cancelQueueButton.addEventListener('click', () => {
    submitAction(
      () => requestPvpApi('/api/pvp/matchmaking/cancel', { method: 'POST' }),
      '已取消匹配。'
    );
  });

  elements.readyButton.addEventListener('click', () => {
    const selfMember = getSelfMember();
    submitAction(
      () => requestPvpApi('/api/pvp/rooms/ready', {
        method: 'POST',
        body: JSON.stringify({ ready: !selfMember?.isReady })
      }),
      selfMember?.isReady ? '已取消准备。' : '已准备。'
    );
  });

  elements.startButton.addEventListener('click', () => {
    submitAction(
      () => requestPvpApi('/api/pvp/rooms/start', { method: 'POST' }),
      '正在建立实时对局。'
    );
  });

  elements.leaveButton.addEventListener('click', () => {
    submitAction(
      () => requestPvpApi('/api/pvp/rooms/leave', { method: 'POST' }),
      '已离开房间。'
    );
  });

  elements.surrenderButton.addEventListener('click', async () => {
    if (!state.currentMatch?.matchId) return;
    if (state.currentMatch.role === 'spectator') {
      submitAction(
        () => requestPvpApi('/api/pvp/matches/leave-spectate', { method: 'POST' }),
        '已退出观赛。'
      );
      return;
    }
    const ok = sendSocketMessage({
      type: 'pvp.match.surrender',
      matchId: state.currentMatch.matchId
    });
    if (ok) {
      setFeedback('已向服务端提交投降请求。', 'warn');
    } else {
      setFeedback('实时连接未就绪，暂时无法投降。', 'warn');
    }
  });

  elements.refreshButton.addEventListener('click', () => {
    refreshState();
  });

  elements.eventSignupButton.addEventListener('click', async () => {
    if (!state.session?.authenticated) {
      window.location.href = `/auth/linuxdo/start?returnTo=${getReturnTo()}`;
      return;
    }

    state.busy = true;
    render();

    try {
      await apiRequest('/api/pvp/event/signup', {
        method: 'POST'
      });
      await refreshState({ preserveFeedback: true });
      setEventFeedback('42 杯报名成功，后续只统计你报名成功后开始的 PVP 对局。', 'ok');
      const refreshedElements = getElements();
      revealElement(refreshedElements?.eventCard);
    } catch (error) {
      setEventFeedback(mapErrorMessage(error.message), error.message?.includes?.('not_open') ? 'warn' : 'error');
    } finally {
      state.busy = false;
      render();
    }
  });

  window.addEventListener('beforeunload', () => {
    closeSocket(true);
  });
}

function sendSocketMessage(payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  state.socket.send(JSON.stringify(payload));
  return true;
}

async function refreshTransport(session) {
  state.transport = createDefaultTransport();
  if (!session?.authenticated) return;

  const transport = session.pvpTransport || null;
  if (transport?.mode !== 'edge' || !transport.apiBaseUrl) {
    return;
  }

  const edgeTicket = await apiRequest('/api/pvp/edge-token');
  state.transport = {
    mode: 'edge',
    apiBaseUrl: edgeTicket.apiBaseUrl || transport.apiBaseUrl,
    accessToken: edgeTicket.accessToken || '',
    expiresAt: edgeTicket.expiresAt || null
  };
}

function mount() {
  ensureStyles();
  const panel = ensurePanel();
  if (!panel) return;

  bindEvents();
  const copyRoomCodeButton = document.getElementById('pvpCopyRoomCodeBtn');
  if (copyRoomCodeButton && copyRoomCodeButton.dataset.bound !== 'true') {
    copyRoomCodeButton.dataset.bound = 'true';
    copyRoomCodeButton.addEventListener('click', async () => {
      const roomCode = state.currentRoom?.roomCode || '';
      const copied = await copyTextToClipboard(roomCode);
      if (copied) {
        setFeedback(`房间码 ${roomCode} 已复制。`, 'ok');
      } else {
        setFeedback('复制失败，请手动长按或选中文本复制。', 'warn');
      }
      render();
    });
  }
  render();
  refreshState();

  window.shootersPvp = {
    getCurrentRoom() {
      return state.currentRoom;
    },
    getCurrentMatch() {
      return state.currentMatch;
    },
    refresh() {
      return refreshState({ preserveFeedback: true });
    },
    async leaveRoom() {
      if (!state.currentRoom || state.currentMatch?.matchId) {
        await refreshState({ preserveFeedback: true });
        return { room: state.currentRoom };
      }
      const result = await apiRequest('/api/pvp/rooms/leave', { method: 'POST' });
      state.currentRoom = result.room || null;
      await refreshState({ preserveFeedback: true });
      render();
      return result;
    },
    async leaveSpectate() {
      if (state.currentMatch?.role !== 'spectator') {
        await refreshState({ preserveFeedback: true });
        return { match: state.currentMatch };
      }
      const result = await requestPvpApi('/api/pvp/matches/leave-spectate', { method: 'POST' });
      state.currentMatch = result.match || null;
      await refreshState({ preserveFeedback: true });
      render();
      return result;
    },
    isSpectating() {
      return state.currentMatch?.role === 'spectator';
    },
    sendMatchInput(input) {
      if (!state.currentMatch?.matchId || state.currentMatch?.role === 'spectator') return false;
      state.matchInputSeq += 1;
      return sendSocketMessage({
        type: 'pvp.match.input',
        matchId: state.currentMatch.matchId,
        inputSeq: state.matchInputSeq,
        ...input
      });
    },
    surrenderMatch() {
      if (!state.currentMatch?.matchId || state.currentMatch?.role === 'spectator') return false;
      return sendSocketMessage({
        type: 'pvp.match.surrender',
        matchId: state.currentMatch.matchId
      });
    }
  };
  window.shootersReplaySpectate = replaySpectator;
}

mount();
