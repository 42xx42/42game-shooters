import { getPvpMapDefinition, getPvpMapLabel, normalizePvpMapId } from './pvp-map-catalog.mjs';

export function createPvpReplayViewer({ apiRequest, formatDateTime }) {
  const state = {
    matchId: '',
    detail: null,
    content: null,
    selectedUserId: '',
    currentUserId: '',
    loading: false,
    error: '',
    ui: null,
    playing: false,
    rafId: 0,
    playheadSeconds: 0,
    durationSeconds: 0,
    speed: 1,
    cameraMode: 'follow',
    lastFrameAt: 0,
    bounds: null
  };

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function getSnapshots() {
    return Array.isArray(state.content?.snapshots) ? state.content.snapshots : [];
  }

  function getEvents() {
    return Array.isArray(state.content?.events) ? state.content.events : [];
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
        state.detail?.map?.mapId ||
        state.detail?.match?.mapId ||
        state.content?.result?.mapId ||
        null,
      null
    );
  }

  function getStatusText(replay) {
    if (!replay) return '无回放';
    if (replay.status === 'pruned') return '回放已清理';
    if (replay.status === 'missing') return '回放缺失';
    if (replay.available) return '回放就绪';
    return replay.status || 'unknown';
  }

  function getErrorText(error) {
    const payload = error?.payload || {};
    if (payload.error === 'replay_pruned') return '回放文件已清理，目前只能查看摘要。';
    if (payload.error === 'replay_missing') return '回放文件缺失，目前只能查看摘要。';
    if (payload.error === 'replay_forbidden') return '你不能查看这场对局的回放。';
    if (payload.error === 'replay_not_found') return '没有找到这场对局的回放。';
    return error?.message || '加载回放失败。';
  }

  function calculateBounds() {
    const mapId = getReplayMapId();
    if (mapId) {
      return { ...getPvpMapDefinition(mapId).arena.bounds };
    }
    const snapshots = getSnapshots();
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const snapshot of snapshots) {
      for (const player of Array.isArray(snapshot?.players) ? snapshot.players : []) {
        const x = Number(player?.x);
        const z = Number(player?.z);
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
      }
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minZ) || !Number.isFinite(maxZ)) {
      return { minX: -24, maxX: 24, minZ: -24, maxZ: 24 };
    }
    return {
      minX: minX - Math.max((maxX - minX) * 0.08, 4),
      maxX: maxX + Math.max((maxX - minX) * 0.08, 4),
      minZ: minZ - Math.max((maxZ - minZ) * 0.08, 4),
      maxZ: maxZ + Math.max((maxZ - minZ) * 0.08, 4)
    };
  }

  function getDurationSeconds() {
    const summaryValue = Number(state.content?.summary?.durationSeconds);
    if (Number.isFinite(summaryValue) && summaryValue >= 0) return summaryValue;
    const snapshots = getSnapshots();
    const last = snapshots[snapshots.length - 1];
    const timeline = Number(last?.timelineSeconds);
    return Number.isFinite(timeline) ? timeline : 0;
  }

  function getSelectedUserId() {
    const players = getPlayers();
    if (players.some((item) => String(item.userId || '') === String(state.selectedUserId || ''))) {
      return String(state.selectedUserId || '');
    }
    if (players.some((item) => String(item.userId || '') === String(state.currentUserId || ''))) {
      state.selectedUserId = String(state.currentUserId || '');
      return state.selectedUserId;
    }
    state.selectedUserId = players[0]?.userId ? String(players[0].userId) : '';
    return state.selectedUserId;
  }

  function findFramePair(playheadSeconds) {
    const snapshots = getSnapshots();
    if (!snapshots.length) return { current: null, next: null, progress: 0, index: 0 };
    const clampedSeconds = Math.max(0, Math.min(playheadSeconds, state.durationSeconds || 0));
    for (let index = 0; index < snapshots.length; index += 1) {
      const current = snapshots[index];
      const next = snapshots[index + 1] || null;
      const currentTime = Number(current?.timelineSeconds || 0);
      const nextTime = Number(next?.timelineSeconds || currentTime);
      if (!next || clampedSeconds <= nextTime) {
        const span = Math.max(0.0001, nextTime - currentTime);
        const progress = next ? Math.max(0, Math.min(1, (clampedSeconds - currentTime) / span)) : 0;
        return { current, next, progress, index };
      }
    }
    const lastIndex = snapshots.length - 1;
    return { current: snapshots[lastIndex], next: null, progress: 0, index: lastIndex };
  }

  function interpolatePlayer(current, next, progress) {
    if (!current) return null;
    if (!next) return current;
    const currentUserId = String(current.userId || '');
    const nextPlayer = (Array.isArray(next.players) ? next.players : []).find((item) => String(item.userId || '') === currentUserId);
    if (!nextPlayer) return current;
    const lerp = (from, to) => {
      const a = Number(from);
      const b = Number(to);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.isFinite(a) ? a : b;
      return a + (b - a) * progress;
    };
    return {
      ...current,
      x: lerp(current.x, nextPlayer.x),
      z: lerp(current.z, nextPlayer.z),
      yaw: lerp(current.yaw, nextPlayer.yaw)
    };
  }

  function getInterpolatedSnapshot() {
    const pair = findFramePair(state.playheadSeconds);
    if (!pair.current) return null;
    return {
      ...pair.current,
      players: (Array.isArray(pair.current.players) ? pair.current.players : []).map((player) =>
        interpolatePlayer(player, pair.next, pair.progress)
      ),
      _frameIndex: pair.index
    };
  }

  function getCameraBounds(snapshot) {
    if (!snapshot || state.cameraMode !== 'follow') {
      return state.bounds || { minX: -24, maxX: 24, minZ: -24, maxZ: 24 };
    }
    const selectedUserId = getSelectedUserId();
    const selected = (Array.isArray(snapshot.players) ? snapshot.players : []).find((item) => String(item.userId || '') === selectedUserId);
    if (!selected) {
      return state.bounds || { minX: -24, maxX: 24, minZ: -24, maxZ: 24 };
    }
    return {
      minX: Number(selected.x || 0) - 14,
      maxX: Number(selected.x || 0) + 14,
      minZ: Number(selected.z || 0) - 10,
      maxZ: Number(selected.z || 0) + 10
    };
  }

  function getCurrentEventBanner(playerMap) {
    const nearest = getEvents()
      .filter((event) => Math.abs(Number(event.timelineSeconds || 0) - state.playheadSeconds) <= 0.75)
      .slice(-1)[0];
    if (!nearest) return '';
    switch (nearest.type) {
      case 'kill':
        return `${getPlayerName(playerMap, nearest.attackerUserId)} 淘汰 ${getPlayerName(playerMap, nearest.targetUserId)}`;
      case 'round_end':
        return `第 ${Math.max(1, Number(nearest.round || 1))} 回合结束`;
      case 'match_end':
        return '对局结束';
      case 'hit':
        return `${getPlayerName(playerMap, nearest.attackerUserId)} 命中 ${getPlayerName(playerMap, nearest.targetUserId)}`;
      default:
        return '';
    }
  }

  function drawMap(snapshot, playerMap) {
    const canvas = state.ui?.canvas;
    if (!(canvas instanceof HTMLCanvasElement)) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#08111b';
    context.fillRect(0, 0, canvas.width, canvas.height);

    const bounds = getCameraBounds(snapshot);
    const rangeX = Math.max(1, bounds.maxX - bounds.minX);
    const rangeZ = Math.max(1, bounds.maxZ - bounds.minZ);
    const width = canvas.width - 36;
    const height = canvas.height - 36;

    context.strokeStyle = 'rgba(255,255,255,0.08)';
    context.strokeRect(18, 18, width, height);

    for (const player of Array.isArray(snapshot?.players) ? snapshot.players : []) {
      const x = Number(player?.x);
      const z = Number(player?.z);
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      const px = 18 + ((x - bounds.minX) / rangeX) * width;
      const py = 18 + (1 - (z - bounds.minZ) / rangeZ) * height;
      const selected = String(player.userId || '') === getSelectedUserId();
      const alive = player.alive !== false;
      context.beginPath();
      context.fillStyle = alive ? (selected ? '#ffffff' : '#7edcff') : 'rgba(255,255,255,0.32)';
      context.arc(px, py, selected ? 9 : 6, 0, Math.PI * 2);
      context.fill();

      const yaw = Number(player.yaw || 0);
      const arrowLength = selected ? 18 : 12;
      context.beginPath();
      context.strokeStyle = alive ? '#ffd08d' : 'rgba(255,255,255,0.2)';
      context.moveTo(px, py);
      context.lineTo(px + Math.cos(yaw) * arrowLength, py + Math.sin(yaw) * arrowLength);
      context.stroke();

      context.fillStyle = '#f4f7ff';
      context.font = '12px "Segoe UI", sans-serif';
      context.fillText(getPlayerName(playerMap, player.userId).slice(0, 10), px + 10, py - 8);
    }
  }

  function formatEvent(event, playerMap) {
    const at = Number.isFinite(Number(event?.timelineSeconds)) ? `${Number(event.timelineSeconds).toFixed(1)}s` : '-';
    if (event?.type === 'kill') return `${at} ${getPlayerName(playerMap, event.attackerUserId)} 淘汰 ${getPlayerName(playerMap, event.targetUserId)}`;
    if (event?.type === 'hit') return `${at} ${getPlayerName(playerMap, event.attackerUserId)} 命中 ${getPlayerName(playerMap, event.targetUserId)} -${Math.max(0, Number(event.damage || 0))}`;
    if (event?.type === 'fire') return `${at} ${getPlayerName(playerMap, event.attackerUserId)} 开火 ${event.weaponId || ''}`.trim();
    if (event?.type === 'round_start') return `${at} 第 ${Math.max(1, Number(event.round || 1))} 回合开始`;
    if (event?.type === 'round_end') return `${at} 第 ${Math.max(1, Number(event.round || 1))} 回合结束`;
    if (event?.type === 'match_end') return `${at} 对局结束`;
    return `${at} ${event?.type || 'unknown'}`;
  }

  function stopPlayback() {
    state.playing = false;
    state.lastFrameAt = 0;
    if (state.rafId) {
      window.cancelAnimationFrame(state.rafId);
      state.rafId = 0;
    }
  }

  function tick(now) {
    if (!state.playing) return;
    if (!state.lastFrameAt) {
      state.lastFrameAt = now;
    }
    const deltaSeconds = Math.max(0, (now - state.lastFrameAt) / 1000) * state.speed;
    state.lastFrameAt = now;
    state.playheadSeconds = Math.min(state.durationSeconds, state.playheadSeconds + deltaSeconds);
    if (state.playheadSeconds >= state.durationSeconds) {
      stopPlayback();
    }
    render();
    if (state.playing) {
      state.rafId = window.requestAnimationFrame(tick);
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
    const playerMap = getPlayerMap();
    const snapshot = getInterpolatedSnapshot();
    const currentFrameIndex = Number(snapshot?._frameIndex || 0);
    const nearbyEvents = getEvents()
      .filter((event) => {
        if (getSelectedUserId() && ![event.userId, event.attackerUserId, event.targetUserId].some((value) => String(value || '') === getSelectedUserId())) {
          return false;
        }
        return Math.abs(Number(event.timelineSeconds || 0) - state.playheadSeconds) <= 8;
      })
      .slice(-10);
    const currentPlayers = (Array.isArray(snapshot?.players) ? snapshot.players : [])
      .filter((player) => !getSelectedUserId() || String(player.userId || '') === getSelectedUserId());
    const eventPanel = state.detail?.eventPanel || null;

    state.ui.title.textContent = `回放 ${state.matchId.slice(0, 8)}`;
    const replayMapId = getReplayMapId();
    state.ui.subtitle.textContent = [
      state.detail?.match?.mode || replay?.mode || '-',
      replayMapId ? getPvpMapLabel(replayMapId) : null,
      getStatusText(replay)
    ]
      .filter(Boolean)
      .join(' | ');
    state.ui.slider.max = String(Math.max(0, Math.round(state.durationSeconds * 10)));
    state.ui.slider.value = String(Math.round(state.playheadSeconds * 10));
    state.ui.slider.disabled = !state.content;
    state.ui.play.textContent = state.playing ? '暂停' : '播放';
    state.ui.frame.textContent = `${state.playheadSeconds.toFixed(1)}s / ${state.durationSeconds.toFixed(1)}s · 帧 ${currentFrameIndex + 1}`;
    state.ui.camera.value = state.cameraMode;
    state.ui.speed.value = String(state.speed);
    state.ui.summary.innerHTML = `
      <div class="pvp-replay-card"><strong>比赛</strong><span>${escapeHtml([state.detail?.match?.winnerTeam ? `胜者 ${state.detail.match.winnerTeam}` : null, state.detail?.match?.completedAt ? formatDateTime(state.detail.match.completedAt) : null].filter(Boolean).join(' | ') || '暂无')}</span></div>
      <div class="pvp-replay-card"><strong>回放</strong><span>${escapeHtml([getStatusText(replay), replay?.fileName || null].filter(Boolean).join(' | ') || '暂无')}</span></div>
      <div class="pvp-replay-card"><strong>统计</strong><span>${escapeHtml(state.content?.summary ? `${Number(state.content.summary.snapshotCount || 0)} 帧 / ${Number(state.content.summary.eventCount || 0)} 事件` : '摘要模式')}</span></div>
    `;
    state.ui.filter.innerHTML = ['<option value="">全部玩家</option>', ...getPlayers().map((player) => `<option value="${escapeHtml(player.userId)}">${escapeHtml(player.displayName || player.username || player.userId)}</option>`)].join('');
    state.ui.filter.value = getSelectedUserId();
    state.ui.mapMeta.textContent = getCurrentEventBanner(playerMap) || (snapshot ? `剩余 ${Number(snapshot.timeLeft || 0).toFixed(1)}s` : '暂无画面');
    drawMap(snapshot, playerMap);

    state.ui.players.innerHTML = currentPlayers.length
      ? currentPlayers.map((player) => `
          <div class="pvp-replay-item">
            <strong>${escapeHtml(getPlayerName(playerMap, player.userId))}</strong>
            <span>HP ${Number(player.hp || 0)} | K ${Number(player.kills || 0)} | D ${Number(player.deaths || 0)} | Lives ${Number(player.lives || 0)}</span>
            <span>${escapeHtml(player.weaponId || '-')} | Ammo ${Number(player.ammo || 0)} / ${Number(player.reserve || 0)} | ${player.alive === false ? '已阵亡' : '存活'} | (${Number(player.x || 0).toFixed(1)}, ${Number(player.z || 0).toFixed(1)})</span>
          </div>
        `).join('')
      : '<div class="pvp-replay-empty">当前没有可显示的玩家状态。</div>';

    state.ui.events.innerHTML = nearbyEvents.length
      ? nearbyEvents.map((event) => `<div class="pvp-replay-item"><strong>${escapeHtml(event.type || 'unknown')}</strong><span>${escapeHtml(formatEvent(event, playerMap))}</span></div>`).join('')
      : '<div class="pvp-replay-empty">当前时间附近没有事件。</div>';

    state.ui.event.innerHTML = eventPanel
      ? `
          <div class="pvp-replay-item">
            <strong>${escapeHtml(eventPanel.title || '42杯')}</strong>
            <span>${eventPanel.counted ? '本局计入 42 杯' : '本局未计入 42 杯'} | 计入人数 ${Number(eventPanel.countedParticipantCount || 0)}/${Number(eventPanel.participantCount || 0)}</span>
          </div>
          ${eventPanel.participants.map((item) => `
            <div class="pvp-replay-item">
              <strong>${escapeHtml(item.user?.displayName || item.user?.username || item.user?.id || '-')}</strong>
              <span>${item.counted ? '计入' : '未计入'} | ${escapeHtml(item.reason || '-')}</span>
              <span>积分变化 ${Number(item.scoreDelta || 0)} | 赛后排名 ${item.rankAfterMatch == null ? '-' : `#${Number(item.rankAfterMatch)}`} | 赛后场次 ${Number(item.matchesPlayedAfterMatch || 0)}</span>
            </div>
          `).join('')}
        `
      : '<div class="pvp-replay-empty">暂无 42 杯信息。</div>';

    state.ui.message.textContent = state.loading ? '正在加载回放...' : state.error || (state.content ? '回放已加载。' : '当前仅展示摘要。');
  }

  async function open(matchId, currentUserId = '', options = {}) {
    state.matchId = String(matchId || '').trim();
    state.currentUserId = String(currentUserId || '');
    state.selectedUserId = state.currentUserId;
    state.detail = null;
    state.content = null;
    state.error = '';
    state.loading = true;
    state.playheadSeconds = 0;
    state.durationSeconds = 0;
    state.cameraMode = 'follow';
    stopPlayback();
    render();

    try {
      state.detail = await apiRequest(`/api/pvp/replays/${encodeURIComponent(state.matchId)}`);
      render();
      const payload = await apiRequest(`/api/pvp/replays/${encodeURIComponent(state.matchId)}/content`);
      state.detail = payload;
      state.content = payload.content || null;
      state.durationSeconds = getDurationSeconds();
      state.bounds = calculateBounds();
      state.loading = false;
      state.error = '';
      const initialSeconds = Number(options?.initialSeconds);
      if (Number.isFinite(initialSeconds) && initialSeconds >= 0) {
        state.playheadSeconds = Math.max(0, Math.min(state.durationSeconds, initialSeconds));
      }
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
    style.textContent = '.pvp-replay-overlay{position:fixed;inset:0;z-index:45;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(2,6,12,.76);backdrop-filter:blur(10px)}.pvp-replay-dialog{width:min(1180px,100%);max-height:90vh;overflow:auto;padding:20px;border-radius:24px;border:1px solid rgba(255,255,255,.12);background:rgba(9,13,21,.96)}.pvp-replay-head,.pvp-replay-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.pvp-replay-toolbar{margin-top:14px}.pvp-replay-grid,.pvp-replay-body{display:grid;gap:14px}.pvp-replay-grid{grid-template-columns:repeat(3,minmax(0,1fr));margin:16px 0}.pvp-replay-body{grid-template-columns:minmax(0,1.2fr) minmax(300px,.8fr)}.pvp-replay-panel,.pvp-replay-card{padding:14px 16px;border-radius:18px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.04)}.pvp-replay-card strong,.pvp-replay-panel strong{display:block;margin-bottom:6px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:rgba(244,247,255,.72)}.pvp-replay-card span,.pvp-replay-item span,.pvp-replay-empty{display:block;color:rgba(244,247,255,.72);font-size:13px;line-height:1.5}.pvp-replay-list{display:grid;gap:10px;max-height:260px;overflow:auto}.pvp-replay-item{padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.08);background:rgba(1,4,10,.42)}.pvp-replay-overlay canvas{width:100%;height:auto;border-radius:14px;border:1px solid rgba(255,255,255,.08);background:#08111b}.pvp-replay-actions{display:flex;gap:8px;flex-wrap:wrap}@media (max-width:980px){.pvp-replay-grid,.pvp-replay-body{grid-template-columns:1fr}}';
    document.head.append(style);
    const overlay = document.createElement('div');
    overlay.className = 'pvp-replay-overlay hidden';
    overlay.innerHTML = `<div class="pvp-replay-dialog"><div class="pvp-replay-head"><div><span class="accountEyebrow">Replay V2</span><h3 data-title>回放</h3><div class="pvp-caption" data-subtitle>加载中...</div></div><div class="pvp-replay-actions"><button class="accountBtn secondary" type="button" data-close>关闭</button></div></div><div class="pvp-replay-grid" data-summary></div><div class="pvp-replay-toolbar"><div class="pvp-replay-actions"><button class="accountBtn secondary" type="button" data-prev>后退 5 秒</button><button class="accountBtn" type="button" data-play>播放</button><button class="accountBtn secondary" type="button" data-next>前进 5 秒</button></div><div class="pvp-replay-actions"><input type="range" min="0" max="0" step="1" value="0" data-slider /><span class="pvp-caption" data-frame>0 / 0</span></div><div class="pvp-replay-actions"><label>镜头 <select class="pvp-input" data-camera><option value="follow">跟随</option><option value="overview">全图</option></select></label><label>倍速 <select class="pvp-input" data-speed><option value="0.5">0.5x</option><option value="1">1x</option><option value="2">2x</option><option value="4">4x</option></select></label><label>聚焦玩家 <select class="pvp-input" data-filter><option value="">全部玩家</option></select></label></div></div><div class="pvp-replay-body"><div class="pvp-replay-grid"><div class="pvp-replay-panel"><strong>伪观战地图</strong><div class="pvp-caption" data-map-meta>暂无画面</div><canvas width="520" height="280" data-canvas></canvas></div><div class="pvp-replay-panel"><strong>当前帧玩家状态</strong><div class="pvp-replay-list" data-players></div></div></div><div class="pvp-replay-grid"><div class="pvp-replay-panel"><strong>事件时间线</strong><div class="pvp-replay-list" data-events></div></div><div class="pvp-replay-panel"><strong>42杯赛事面板</strong><div class="pvp-replay-list" data-event></div><div class="message" data-message></div></div></div></div></div>`;
    document.body.append(overlay);
    state.ui = {
      overlay,
      title: overlay.querySelector('[data-title]'),
      subtitle: overlay.querySelector('[data-subtitle]'),
      summary: overlay.querySelector('[data-summary]'),
      play: overlay.querySelector('[data-play]'),
      prev: overlay.querySelector('[data-prev]'),
      next: overlay.querySelector('[data-next]'),
      slider: overlay.querySelector('[data-slider]'),
      frame: overlay.querySelector('[data-frame]'),
      camera: overlay.querySelector('[data-camera]'),
      speed: overlay.querySelector('[data-speed]'),
      filter: overlay.querySelector('[data-filter]'),
      mapMeta: overlay.querySelector('[data-map-meta]'),
      canvas: overlay.querySelector('[data-canvas]'),
      players: overlay.querySelector('[data-players]'),
      events: overlay.querySelector('[data-events]'),
      event: overlay.querySelector('[data-event]'),
      message: overlay.querySelector('[data-message]')
    };
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        close();
      }
    });
    overlay.querySelector('[data-close]')?.addEventListener('click', close);
    state.ui.play?.addEventListener('click', () => {
      if (!state.content) return;
      if (state.playing) {
        stopPlayback();
        render();
        return;
      }
      state.playing = true;
      state.lastFrameAt = 0;
      state.rafId = window.requestAnimationFrame(tick);
      render();
    });
    state.ui.prev?.addEventListener('click', () => {
      stopPlayback();
      state.playheadSeconds = Math.max(0, state.playheadSeconds - 5);
      render();
    });
    state.ui.next?.addEventListener('click', () => {
      stopPlayback();
      state.playheadSeconds = Math.min(state.durationSeconds, state.playheadSeconds + 5);
      render();
    });
    state.ui.slider?.addEventListener('input', (event) => {
      stopPlayback();
      state.playheadSeconds = Number(event.currentTarget.value || 0) / 10;
      render();
    });
    state.ui.camera?.addEventListener('change', (event) => {
      state.cameraMode = event.currentTarget.value === 'overview' ? 'overview' : 'follow';
      render();
    });
    state.ui.speed?.addEventListener('change', (event) => {
      state.speed = Math.max(0.5, Number(event.currentTarget.value || 1));
      render();
    });
    state.ui.filter?.addEventListener('change', (event) => {
      state.selectedUserId = String(event.currentTarget.value || '');
      render();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.matchId) {
        close();
      }
    });
  }

  function close() {
    stopPlayback();
    state.matchId = '';
    state.detail = null;
    state.content = null;
    state.error = '';
    render();
  }

  return {
    open,
    handleListClick(event, currentUserId = '') {
      const button = event.target instanceof Element ? event.target.closest('[data-pvp-replay-open]') : null;
      if (!button) return;
      void open(button.getAttribute('data-match-id') || '', currentUserId);
    }
  };
}
