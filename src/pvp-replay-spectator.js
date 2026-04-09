export function clampReplaySeconds(seconds, durationSeconds = 0) {
  const safeDuration = Number.isFinite(Number(durationSeconds)) ? Math.max(0, Number(durationSeconds)) : 0;
  const safeSeconds = Number.isFinite(Number(seconds)) ? Number(seconds) : 0;
  return Math.max(0, Math.min(safeDuration, safeSeconds));
}

export function findReplaySnapshotIndex(snapshots, seconds) {
  const entries = Array.isArray(snapshots) ? snapshots : [];
  if (!entries.length) return -1;
  const clampedSeconds = Math.max(0, Number(seconds) || 0);
  let foundIndex = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const timelineSeconds = Number(entries[index]?.timelineSeconds || 0);
    if (timelineSeconds <= clampedSeconds) {
      foundIndex = index;
      continue;
    }
    break;
  }
  return foundIndex;
}

export function findReplayEventCursor(events, seconds) {
  const entries = Array.isArray(events) ? events : [];
  const clampedSeconds = Math.max(0, Number(seconds) || 0);
  for (let index = 0; index < entries.length; index += 1) {
    if (Number(entries[index]?.timelineSeconds || 0) > clampedSeconds) {
      return index;
    }
  }
  return entries.length;
}

export function buildReplaySpectateTimeline(content) {
  const snapshots = Array.isArray(content?.snapshots)
    ? [...content.snapshots]
        .filter((entry) => entry && typeof entry === 'object')
        .sort((left, right) => Number(left.timelineSeconds || 0) - Number(right.timelineSeconds || 0))
    : [];
  const events = Array.isArray(content?.events)
    ? [...content.events]
        .filter((entry) => entry && typeof entry === 'object')
        .sort((left, right) => Number(left.timelineSeconds || 0) - Number(right.timelineSeconds || 0))
    : [];
  const durationFromSummary = Number(content?.summary?.durationSeconds);
  const lastSnapshotTime = Number(snapshots[snapshots.length - 1]?.timelineSeconds || 0);
  const lastEventTime = Number(events[events.length - 1]?.timelineSeconds || 0);
  const durationSeconds = Number.isFinite(durationFromSummary)
    ? Math.max(0, durationFromSummary)
    : Math.max(0, lastSnapshotTime, lastEventTime);

  return {
    snapshots,
    events,
    durationSeconds
  };
}

export function createPvpReplaySpectator({ apiRequest, onOpenAnalysisMode } = {}) {
  const state = {
    active: false,
    loading: false,
    playing: false,
    finished: false,
    matchId: '',
    mode: 'duel',
    currentUserId: '',
    detail: null,
    content: null,
    players: [],
    snapshots: [],
    events: [],
    durationSeconds: 0,
    playheadSeconds: 0,
    snapshotIndex: -1,
    eventCursor: 0,
    speed: 1,
    cameraMode: 'follow',
    observedUserId: '',
    rafId: 0,
    lastFrameAt: 0
  };

  function stopAnimation() {
    state.playing = false;
    state.lastFrameAt = 0;
    if (state.rafId) {
      window.cancelAnimationFrame(state.rafId);
      state.rafId = 0;
    }
  }

  function buildReplayMeta() {
    return {
      active: true,
      matchId: state.matchId,
      playheadSeconds: state.playheadSeconds,
      durationSeconds: state.durationSeconds,
      observedUserId: state.observedUserId,
      cameraMode: state.cameraMode
    };
  }

  function getPlayers() {
    if (Array.isArray(state.content?.players) && state.content.players.length) {
      return state.content.players;
    }
    if (Array.isArray(state.detail?.players) && state.detail.players.length) {
      return state.detail.players;
    }
    return [];
  }

  function pickDefaultObservedUserId() {
    const players = getPlayers();
    if (!players.length) return '';
    if (players.some((player) => String(player.userId || '') === String(state.observedUserId || ''))) {
      return String(state.observedUserId || '');
    }
    if (players.some((player) => String(player.userId || '') === String(state.currentUserId || ''))) {
      return String(state.currentUserId || '');
    }
    return String(players[0]?.userId || '');
  }

  function dispatch(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  function emitReplayState(extra = {}) {
    dispatch('shooters-pvp-replay-state', {
      active: state.active,
      loading: state.loading,
      playing: state.playing,
      finished: state.finished,
      matchId: state.matchId || null,
      mode: state.mode || null,
      playheadSeconds: state.playheadSeconds,
      durationSeconds: state.durationSeconds,
      speed: state.speed,
      cameraMode: state.cameraMode,
      observedUserId: state.observedUserId || null,
      players: getPlayers(),
      replayAvailable: Boolean(state.content),
      ...extra
    });
  }

  function getSnapshotAt(index) {
    return index >= 0 ? state.snapshots[index] || null : null;
  }

  function buildStartedPayload(snapshot) {
    return {
      matchId: state.matchId,
      mode: state.mode,
      mapId: snapshot?.mapId || state.content?.mapId || state.content?.summary?.mapId || null,
      role: 'spectator',
      snapshot,
      replay: buildReplayMeta()
    };
  }

  function buildSnapshotPayload(snapshot) {
    return {
      ...snapshot,
      matchId: state.matchId,
      mode: state.mode,
      role: 'spectator',
      replay: buildReplayMeta()
    };
  }

  function buildEndedPayload() {
    return {
      ...(state.content?.result || {}),
      matchId: state.matchId,
      mode: state.mode,
      mapId: state.content?.result?.mapId || state.content?.mapId || state.content?.summary?.mapId || null,
      role: 'spectator',
      replay: buildReplayMeta()
    };
  }

  function emitStarted(snapshot) {
    dispatch('shooters-pvp-match-started', buildStartedPayload(snapshot));
  }

  function emitSnapshot(snapshot) {
    dispatch('shooters-pvp-match-snapshot', buildSnapshotPayload(snapshot));
  }

  function emitEvent(event) {
    dispatch('shooters-pvp-match-event', {
      matchId: state.matchId,
      mode: state.mode,
      role: 'spectator',
      replay: buildReplayMeta(),
      event
    });
  }

  function emitEnded() {
    dispatch('shooters-pvp-match-ended', buildEndedPayload());
  }

  function ensureReplayIdle() {
    const liveMatch = window.shootersPvp?.getCurrentMatch?.() || null;
    if (liveMatch?.matchId) {
      throw new Error('live_match_active');
    }
  }

  function applyObservedUser(userId = '') {
    state.observedUserId = String(userId || pickDefaultObservedUserId() || '');
    emitReplayState();
    dispatch('shooters-pvp-replay-observed-user-changed', {
      observedUserId: state.observedUserId || null,
      replay: buildReplayMeta()
    });
  }

  function applySnapshotForTime(seconds, { forceStart = false, reason = 'seek' } = {}) {
    const clampedSeconds = clampReplaySeconds(seconds, state.durationSeconds);
    const snapshotIndex = findReplaySnapshotIndex(state.snapshots, clampedSeconds);
    const snapshot = getSnapshotAt(snapshotIndex);
    if (!snapshot) {
      state.playheadSeconds = clampedSeconds;
      state.snapshotIndex = -1;
      state.eventCursor = findReplayEventCursor(state.events, clampedSeconds);
      emitReplayState({ reason });
      return;
    }

    const shouldStart = forceStart || !state.active;
    state.active = true;
    state.playheadSeconds = clampedSeconds;
    state.snapshotIndex = snapshotIndex;
    state.eventCursor = findReplayEventCursor(state.events, clampedSeconds);
    state.observedUserId = pickDefaultObservedUserId();

    if (shouldStart) {
      emitStarted(snapshot);
    } else {
      emitSnapshot(snapshot);
    }

    if (reason === 'seek') {
      dispatch('shooters-pvp-replay-seeked', {
        playheadSeconds: clampedSeconds,
        replay: buildReplayMeta()
      });
    }

    emitReplayState({ reason });
  }

  function finishPlayback() {
    if (state.finished) return;
    state.finished = true;
    state.playing = false;
    stopAnimation();
    state.playheadSeconds = state.durationSeconds;
    emitEnded();
    emitReplayState({ reason: 'ended' });
  }

  function advanceTo(seconds) {
    const nextSeconds = clampReplaySeconds(seconds, state.durationSeconds);
    const previousSeconds = state.playheadSeconds;

    if (nextSeconds < previousSeconds) {
      applySnapshotForTime(nextSeconds, { reason: 'seek' });
      return;
    }

    while (state.snapshotIndex + 1 < state.snapshots.length) {
      const nextSnapshot = state.snapshots[state.snapshotIndex + 1];
      if (Number(nextSnapshot?.timelineSeconds || 0) > nextSeconds) break;
      state.snapshotIndex += 1;
      emitSnapshot(state.snapshots[state.snapshotIndex]);
    }

    while (state.eventCursor < state.events.length) {
      const event = state.events[state.eventCursor];
      if (Number(event?.timelineSeconds || 0) > nextSeconds) break;
      state.eventCursor += 1;
      emitEvent(event);
    }

    state.playheadSeconds = nextSeconds;
    state.observedUserId = pickDefaultObservedUserId();
    emitReplayState({ reason: 'tick' });

    if (nextSeconds >= state.durationSeconds) {
      finishPlayback();
    }
  }

  function tick(now) {
    if (!state.playing) return;
    if (!state.lastFrameAt) {
      state.lastFrameAt = now;
    }
    const deltaSeconds = Math.max(0, (now - state.lastFrameAt) / 1000) * state.speed;
    state.lastFrameAt = now;
    advanceTo(state.playheadSeconds + deltaSeconds);
    if (state.playing) {
      state.rafId = window.requestAnimationFrame(tick);
    }
  }

  async function open({ matchId, currentUserId = '', initialSeconds = 0 } = {}) {
    const normalizedMatchId = String(matchId || '').trim();
    if (!normalizedMatchId) {
      throw new Error('replay_not_found');
    }

    ensureReplayIdle();
    stopAnimation();

    state.loading = true;
    state.finished = false;
    state.active = false;
    state.matchId = normalizedMatchId;
    state.currentUserId = String(currentUserId || '');
    emitReplayState({ reason: 'loading' });
    try {
      const detail = await apiRequest(`/api/pvp/replays/${encodeURIComponent(normalizedMatchId)}`);
      const payload = await apiRequest(`/api/pvp/replays/${encodeURIComponent(normalizedMatchId)}/content`);
      const content = payload?.content || null;
      if (!content) {
        throw new Error('replay_not_available');
      }

      const timeline = buildReplaySpectateTimeline(content);
      state.detail = payload;
      state.content = content;
      state.mode = detail?.match?.mode || content?.replay?.mode || 'duel';
      state.players = getPlayers();
      state.snapshots = timeline.snapshots;
      state.events = timeline.events;
      state.durationSeconds = timeline.durationSeconds;
      state.cameraMode = 'follow';
      state.speed = 1;
      state.finished = false;
      state.playheadSeconds = 0;
      state.snapshotIndex = -1;
      state.eventCursor = 0;
      state.observedUserId = pickDefaultObservedUserId();

      applySnapshotForTime(initialSeconds, { forceStart: true, reason: 'open' });
      play();

      dispatch('shooters-pvp-replay-opened', {
        matchId: state.matchId,
        mode: state.mode,
        replay: buildReplayMeta()
      });

      return {
        detail,
        content
      };
    } catch (error) {
      state.active = false;
      state.finished = false;
      throw error;
    } finally {
      state.loading = false;
      emitReplayState({ reason: 'loaded' });
    }
  }

  function play() {
    if (!state.content || state.finished) {
      if (state.finished) {
        restart();
      }
      return;
    }
    if (state.playing) return;
    state.playing = true;
    state.lastFrameAt = 0;
    state.rafId = window.requestAnimationFrame(tick);
    emitReplayState({ reason: 'play' });
  }

  function pause() {
    stopAnimation();
    emitReplayState({ reason: 'pause' });
  }

  function togglePlayback() {
    if (state.playing) {
      pause();
      return;
    }
    play();
  }

  function seek(seconds) {
    stopAnimation();
    state.finished = false;
    applySnapshotForTime(seconds, { reason: 'seek' });
  }

  function restart() {
    stopAnimation();
    state.finished = false;
    applySnapshotForTime(0, { forceStart: true, reason: 'restart' });
    play();
  }

  function close() {
    const previousState = {
      matchId: state.matchId,
      playheadSeconds: state.playheadSeconds
    };
    stopAnimation();
    const wasActive = state.active || state.finished;

    state.active = false;
    state.loading = false;
    state.playing = false;
    state.finished = false;
    state.matchId = '';
    state.mode = 'duel';
    state.detail = null;
    state.content = null;
    state.players = [];
    state.snapshots = [];
    state.events = [];
    state.durationSeconds = 0;
    state.playheadSeconds = 0;
    state.snapshotIndex = -1;
    state.eventCursor = 0;
    state.observedUserId = '';
    state.cameraMode = 'follow';

    if (wasActive) {
      dispatch('shooters-pvp-replay-closed', previousState);
    }
    emitReplayState({ reason: 'close' });
  }

  function setSpeed(speed) {
    state.speed = Math.max(0.5, Math.min(4, Number(speed) || 1));
    emitReplayState({ reason: 'speed' });
  }

  function setObservedUser(userId) {
    applyObservedUser(userId);
  }

  function setCameraMode(mode) {
    state.cameraMode = mode === 'free' ? 'free' : 'follow';
    emitReplayState({ reason: 'camera' });
    dispatch('shooters-pvp-replay-camera-changed', {
      cameraMode: state.cameraMode,
      replay: buildReplayMeta()
    });
  }

  function openAnalysisMode() {
    pause();
    onOpenAnalysisMode?.(state.matchId, state.currentUserId, {
      initialSeconds: state.playheadSeconds
    });
  }

  function isActive() {
    return state.active || state.finished;
  }

  function getState() {
    return {
      active: state.active,
      loading: state.loading,
      playing: state.playing,
      finished: state.finished,
      matchId: state.matchId,
      mode: state.mode,
      playheadSeconds: state.playheadSeconds,
      durationSeconds: state.durationSeconds,
      speed: state.speed,
      cameraMode: state.cameraMode,
      observedUserId: state.observedUserId,
      players: getPlayers()
    };
  }

  return {
    open,
    play,
    pause,
    togglePlayback,
    seek,
    restart,
    close,
    setSpeed,
    setObservedUser,
    setCameraMode,
    openAnalysisMode,
    isActive,
    getState
  };
}
