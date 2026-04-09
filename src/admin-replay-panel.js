import { getPvpMapDefinition, getPvpMapLabel, normalizePvpMapId } from './pvp-map-catalog.mjs';

export function createAdminReplayViewer({ apiRequest, formatDate }) {
  const state = {
    matchId: '',
    detail: null,
    content: null,
    frameIndex: 0,
    selectedUserId: '',
    bounds: null,
    loading: false,
    error: '',
    playing: false,
    timer: null,
    ui: null
  };

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function formatBytes(value) {
    const size = Number(value);
    if (!Number.isFinite(size) || size < 0) return '';
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

  function getReplayStatus(replay) {
    if (!replay) return '无回放';
    if (replay.status === 'failed') return '回放失败';
    if (replay.status === 'pruned') return '已清理';
    if (replay.status === 'missing') return '回放缺失';
    if (replay.available) return '回放就绪';
    return `回放: ${replay.status || 'unknown'}`;
  }

  function getErrorText(error) {
    const payload = error?.payload || {};
    if (payload.error === 'replay_pruned') return '回放文件已被清理，目前只能查看摘要。';
    if (payload.error === 'replay_missing') return '回放文件缺失，目前只能查看摘要。';
    if (payload.error === 'invalid_replay_file') return payload.line ? `回放解析失败，第 ${payload.line} 行无效。` : '回放解析失败。';
    if (payload.error === 'replay_not_found') return '没有找到对应回放。';
    return error?.message || '加载回放失败。';
  }

  function getPlayers() {
    if (Array.isArray(state.content?.players) && state.content.players.length) return state.content.players;
    if (Array.isArray(state.detail?.players) && state.detail.players.length) return state.detail.players;
    return [];
  }

  function getPlayerMap() {
    return new Map(getPlayers().filter((item) => item?.userId).map((item) => [String(item.userId), item]));
  }

  function getPlayerName(playerMap, userId) {
    const player = playerMap.get(String(userId || ''));
    return player?.displayName || player?.username || String(userId || '-');
  }

  function getReplayMapId() {
    return normalizePvpMapId(
      state.content?.mapId ||
        state.content?.summary?.mapId ||
        state.detail?.mapId ||
        state.detail?.match?.mapId ||
        null,
      null
    );
  }

  function stopPlayback() {
    state.playing = false;
    if (state.timer) {
      window.clearInterval(state.timer);
      state.timer = null;
    }
  }

  function clampFrame(index) {
    const snapshots = Array.isArray(state.content?.snapshots) ? state.content.snapshots : [];
    if (!snapshots.length) return 0;
    return Math.min(Math.max(Math.floor(index), 0), snapshots.length - 1);
  }

  function getSnapshot() {
    const snapshots = Array.isArray(state.content?.snapshots) ? state.content.snapshots : [];
    return snapshots[clampFrame(state.frameIndex)] || null;
  }

  function calculateBounds() {
    const mapId = getReplayMapId();
    if (mapId) {
      return { ...getPvpMapDefinition(mapId).arena.bounds };
    }
    const snapshots = Array.isArray(state.content?.snapshots) ? state.content.snapshots : [];
    const points = snapshots.flatMap((snapshot) => Array.isArray(snapshot?.players) ? snapshot.players : []);
    const xs = points.map((player) => Number(player?.x)).filter(Number.isFinite);
    const zs = points.map((player) => Number(player?.z)).filter(Number.isFinite);
    if (!xs.length || !zs.length) {
      return { minX: -24, maxX: 24, minZ: -24, maxZ: 24 };
    }
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    return {
      minX: minX - Math.max((maxX - minX) * 0.08, 4),
      maxX: maxX + Math.max((maxX - minX) * 0.08, 4),
      minZ: minZ - Math.max((maxZ - minZ) * 0.08, 4),
      maxZ: maxZ + Math.max((maxZ - minZ) * 0.08, 4)
    };
  }

  function drawMap(snapshot, playerMap) {
    const canvas = state.ui?.canvas;
    if (!(canvas instanceof HTMLCanvasElement)) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#08111b';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = 'rgba(255,255,255,0.08)';
    context.strokeRect(14, 14, canvas.width - 28, canvas.height - 28);
    if (!snapshot) return;
    const bounds = state.bounds || { minX: -24, maxX: 24, minZ: -24, maxZ: 24 };
    const rangeX = Math.max(1, bounds.maxX - bounds.minX);
    const rangeZ = Math.max(1, bounds.maxZ - bounds.minZ);
    for (const player of Array.isArray(snapshot.players) ? snapshot.players : []) {
      const x = Number(player?.x);
      const z = Number(player?.z);
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      const px = 18 + ((x - bounds.minX) / rangeX) * (canvas.width - 36);
      const py = 18 + (1 - (z - bounds.minZ) / rangeZ) * (canvas.height - 36);
      const selected = state.selectedUserId && String(player.userId || '') === String(state.selectedUserId);
      context.beginPath();
      context.fillStyle = player.alive === false ? 'rgba(255,255,255,0.35)' : selected ? '#ffffff' : '#7edcff';
      context.arc(px, py, selected ? 9 : 6, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = '#f4f7ff';
      context.font = '12px "Segoe UI", sans-serif';
      context.fillText(getPlayerName(playerMap, player.userId).slice(0, 10), px + 10, py - 8);
    }
  }

  function formatEvent(event, playerMap) {
    const at = Number.isFinite(Number(event?.timelineSeconds)) ? `${Number(event.timelineSeconds).toFixed(1)}s` : '-';
    switch (event?.type) {
      case 'kill':
        return `${at} ${getPlayerName(playerMap, event.attackerUserId)} 淘汰 ${getPlayerName(playerMap, event.targetUserId)}`;
      case 'hit':
        return `${at} ${getPlayerName(playerMap, event.attackerUserId)} 命中 ${getPlayerName(playerMap, event.targetUserId)} -${Math.max(0, Number(event.damage || 0))}`;
      case 'fire':
        return `${at} ${getPlayerName(playerMap, event.attackerUserId)} 开火 ${event.weaponId || ''}`.trim();
      case 'respawn':
        return `${at} ${getPlayerName(playerMap, event.userId)} 复活`;
      case 'round_end':
        return `${at} 第 ${Math.max(1, Number(event.round || 1))} 回合结束`;
      case 'match_end':
        return `${at} 对局结束`;
      default:
        return `${at} ${event?.type || 'unknown'}`;
    }
  }

  function render() {
    installUi();
    if (!state.matchId) {
      state.ui.overlay.classList.add('hidden');
      return;
    }
    state.ui.overlay.classList.remove('hidden');
    const replay = state.detail?.replay || state.content?.replay || null;
    const players = getPlayers();
    const playerMap = getPlayerMap();
    const snapshots = Array.isArray(state.content?.snapshots) ? state.content.snapshots : [];
    const snapshot = getSnapshot();
    const events = (Array.isArray(state.content?.events) ? state.content.events : [])
      .filter((event) => !state.selectedUserId || [event.userId, event.attackerUserId, event.targetUserId].some((value) => String(value || '') === String(state.selectedUserId)))
      .slice(-16);

    state.ui.title.textContent = `回放 ${state.matchId.slice(0, 8)}`;
    const replayMapId = getReplayMapId();
    state.ui.subtitle.textContent = [
      state.detail?.match?.mode || replay?.mode || '-',
      replayMapId ? getPvpMapLabel(replayMapId) : null,
      getReplayStatus(replay)
    ]
      .filter(Boolean)
      .join(' | ');
    state.ui.download.href = `/api/admin/replays/${encodeURIComponent(state.matchId)}/download`;
    state.ui.download.classList.toggle('hidden', !replay?.available);
    state.ui.slider.max = String(Math.max(0, snapshots.length - 1));
    state.ui.slider.value = String(clampFrame(state.frameIndex));
    state.ui.slider.disabled = snapshots.length < 2;
    state.ui.play.textContent = state.playing ? '暂停' : '播放';
    state.ui.frame.textContent = `${snapshots.length ? clampFrame(state.frameIndex) + 1 : 0} / ${snapshots.length}`;
    state.ui.summary.innerHTML = `
      <div class="replay-card"><strong>回放</strong><span>${escapeHtml([getReplayStatus(replay), formatBytes(replay?.sizeBytes), replay?.fileName].filter(Boolean).join(' | ') || '暂无')}</span></div>
      <div class="replay-card"><strong>比赛</strong><span>${escapeHtml([state.detail?.match?.winnerTeam ? `胜者 ${state.detail.match.winnerTeam}` : null, state.detail?.match?.completedAt ? formatDate(state.detail.match.completedAt) : null].filter(Boolean).join(' | ') || '暂无')}</span></div>
      <div class="replay-card"><strong>统计</strong><span>${escapeHtml(state.content?.summary ? `${Number(state.content.summary.snapshotCount || 0)} 帧 / ${Number(state.content.summary.eventCount || 0)} 事件` : '摘要模式')}</span></div>
    `;
    state.ui.filter.innerHTML = ['<option value="">全部玩家</option>', ...players.map((player) => `<option value="${escapeHtml(player.userId)}">${escapeHtml(player.displayName || player.username || player.userId)}</option>`)].join('');
    if (!players.some((player) => String(player.userId || '') === String(state.selectedUserId))) {
      state.selectedUserId = '';
    }
    state.ui.filter.value = state.selectedUserId;
    drawMap(snapshot, playerMap);
    state.ui.players.innerHTML = snapshot?.players?.length
      ? snapshot.players
          .filter((player) => !state.selectedUserId || String(player.userId || '') === String(state.selectedUserId))
          .map((player) => `<div class="replay-item"><strong>${escapeHtml(getPlayerName(playerMap, player.userId))}</strong><span>HP ${Number(player.hp || 0)} | K ${Number(player.kills || 0)} | D ${Number(player.deaths || 0)}</span></div>`)
          .join('')
      : '<div class="replay-empty">暂无快照。</div>';
    state.ui.events.innerHTML = events.length
      ? events.map((event) => `<div class="replay-item"><strong>${escapeHtml(event.type || 'unknown')}</strong><span>${escapeHtml(formatEvent(event, playerMap))}</span></div>`).join('')
      : '<div class="replay-empty">暂无事件。</div>';
    state.ui.message.textContent = state.loading ? '正在加载回放内容...' : state.error || (state.content ? '回放内容已加载。' : '仅展示摘要。');
  }

  async function open(matchId) {
    state.matchId = String(matchId || '').trim();
    state.detail = null;
    state.content = null;
    state.frameIndex = 0;
    state.selectedUserId = '';
    state.bounds = null;
    state.loading = true;
    state.error = '';
    stopPlayback();
    render();
    try {
      state.detail = await apiRequest(`/api/admin/replays/${encodeURIComponent(state.matchId)}`);
      render();
      const payload = await apiRequest(`/api/admin/replays/${encodeURIComponent(state.matchId)}/content`);
      state.detail = payload;
      state.content = payload.content || null;
      state.bounds = calculateBounds();
      state.loading = false;
      state.error = '';
      render();
    } catch (error) {
      state.loading = false;
      state.error = getErrorText(error);
      if (error.payload && typeof error.payload === 'object' && !state.detail) {
        state.detail = error.payload;
      }
      render();
    }
  }

  function installUi() {
    if (state.ui) return;
    const style = document.createElement('style');
    style.textContent = '.inline-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.table-button{padding:8px 12px;border-radius:10px;font-size:12px;box-shadow:none}.replay-overlay{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(2,6,12,.72);backdrop-filter:blur(8px)}.replay-dialog{width:min(1080px,100%);max-height:90vh;overflow:auto;padding:20px;border-radius:24px;border:1px solid rgba(255,255,255,.1);background:rgba(9,13,21,.96)}.replay-head,.replay-toolbar{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center}.replay-grid,.replay-body{display:grid;gap:14px}.replay-grid{grid-template-columns:repeat(3,minmax(0,1fr));margin:16px 0}.replay-body{grid-template-columns:minmax(0,1.15fr) minmax(300px,.85fr)}.replay-card,.replay-panel{padding:14px 16px;border-radius:18px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.04)}.replay-card strong,.replay-panel strong{display:block;margin-bottom:6px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:rgba(244,247,255,.72)}.replay-card span,.replay-item span,.replay-empty{color:rgba(244,247,255,.72);font-size:13px;line-height:1.5}.replay-item{padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.08);background:rgba(1,4,10,.42);display:grid;gap:4px}.replay-list{display:grid;gap:10px;max-height:260px;overflow:auto}.replay-overlay canvas{width:100%;height:auto;border-radius:14px;border:1px solid rgba(255,255,255,.08);background:#08111b}.replay-close-row{display:flex;gap:8px;flex-wrap:wrap}@media (max-width:980px){.replay-grid,.replay-body{grid-template-columns:1fr}}';
    document.head.append(style);
    const overlay = document.createElement('div');
    overlay.className = 'replay-overlay hidden';
    overlay.innerHTML = `<div class="replay-dialog"><div class="replay-head"><div><span class="eyebrow">Admin Replay</span><h3 data-title>回放查看器</h3><div class="minor" data-subtitle>加载中...</div></div><div class="replay-close-row"><a class="button-link secondary hidden" data-download href="#" download>下载原始回放</a><button class="secondary" type="button" data-close>关闭</button></div></div><div class="replay-grid" data-summary></div><div class="replay-toolbar"><div class="replay-close-row"><button class="secondary table-button" type="button" data-prev>上一帧</button><button class="table-button" type="button" data-play>播放</button><button class="secondary table-button" type="button" data-next>下一帧</button></div><div class="replay-close-row"><input type="range" min="0" max="0" step="1" value="0" data-slider /><span class="minor" data-frame>0 / 0</span></div><label>聚焦玩家<select data-filter><option value="">全部玩家</option></select></label></div><div class="replay-body"><div class="replay-grid"><div class="replay-panel"><strong>地图</strong><canvas width="420" height="240" data-canvas></canvas></div><div class="replay-panel"><strong>当前帧玩家状态</strong><div class="replay-list" data-players></div></div></div><div class="replay-panel"><strong>事件时间线</strong><div class="replay-list" data-events></div><div class="message" data-message></div></div></div></div>`;
    document.body.append(overlay);
    state.ui = {
      overlay,
      title: overlay.querySelector('[data-title]'),
      subtitle: overlay.querySelector('[data-subtitle]'),
      summary: overlay.querySelector('[data-summary]'),
      download: overlay.querySelector('[data-download]'),
      prev: overlay.querySelector('[data-prev]'),
      play: overlay.querySelector('[data-play]'),
      next: overlay.querySelector('[data-next]'),
      slider: overlay.querySelector('[data-slider]'),
      frame: overlay.querySelector('[data-frame]'),
      filter: overlay.querySelector('[data-filter]'),
      canvas: overlay.querySelector('[data-canvas]'),
      players: overlay.querySelector('[data-players]'),
      events: overlay.querySelector('[data-events]'),
      message: overlay.querySelector('[data-message]')
    };
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        state.matchId = '';
        stopPlayback();
        render();
      }
    });
    overlay.querySelector('[data-close]')?.addEventListener('click', () => {
      state.matchId = '';
      stopPlayback();
      render();
    });
    state.ui.prev?.addEventListener('click', () => {
      stopPlayback();
      state.frameIndex = clampFrame(state.frameIndex - 1);
      render();
    });
    state.ui.next?.addEventListener('click', () => {
      stopPlayback();
      state.frameIndex = clampFrame(state.frameIndex + 1);
      render();
    });
    state.ui.play?.addEventListener('click', () => {
      const snapshots = Array.isArray(state.content?.snapshots) ? state.content.snapshots : [];
      if (snapshots.length < 2) return;
      if (state.playing) {
        stopPlayback();
        render();
        return;
      }
      state.playing = true;
      state.timer = window.setInterval(() => {
        if (state.frameIndex >= snapshots.length - 1) {
          stopPlayback();
        } else {
          state.frameIndex += 1;
        }
        render();
      }, 700);
      render();
    });
    state.ui.slider?.addEventListener('input', (event) => {
      stopPlayback();
      state.frameIndex = clampFrame(Number(event.currentTarget.value || 0));
      render();
    });
    state.ui.filter?.addEventListener('change', (event) => {
      state.selectedUserId = String(event.currentTarget.value || '');
      render();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.matchId) {
        state.matchId = '';
        stopPlayback();
        render();
      }
    });
  }

  return {
    getActionMarkup(replay) {
      if (!replay?.matchId) return '';
      return `<div class="inline-actions"><button class="secondary table-button" type="button" data-replay-open="1" data-match-id="${escapeHtml(replay.matchId)}">${escapeHtml(replay.available ? '查看回放' : '查看摘要')}</button></div>`;
    },
    handleClick(event) {
      const button = event.target instanceof Element ? event.target.closest('[data-replay-open]') : null;
      if (button) {
        void open(button.getAttribute('data-match-id'));
      }
    }
  };
}
