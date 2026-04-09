import { createHash, randomUUID } from 'node:crypto';

import {
  buildCombatResult,
  buildCombatSnapshot,
  COMBAT_TICK_MS,
  createInitialCombatState,
  forceCombatForfeit,
  markCombatPlayerDisconnected,
  markCombatPlayerReconnected,
  normalizeCombatInput,
  normalizeCombatMode,
  PVP_COMBAT_MODES,
  RECONNECT_GRACE_MS,
  SNAPSHOT_TICK_INTERVAL,
  stepCombatState
} from '../src/pvp-combat-core.mjs';
import {
  PVP_DEFAULT_MAP_SELECTION,
  PVP_MAP_SELECTION_RANDOM,
  isCompatiblePvpMapSelection,
  normalizePvpMapSelection,
  resolvePreferredPvpMapSelection,
  resolvePvpMapSelection
} from '../src/pvp-map-catalog.mjs';

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const DEFAULT_PVP_REPLAY_CONFIG = Object.freeze({
  enabled: false,
  maxStoredMatches: 100,
  compressOnComplete: true,
  modes: Object.freeze({
    duel: false,
    deathmatch: true
  })
});

export const DEFAULT_PVP_CONFIG = Object.freeze({
  enabled: false,
  matchmakingEnabled: false,
  rewardEnabled: false,
  maxActiveRooms: 20,
  maxRoomIdleSeconds: 600,
  allowModes: Object.freeze({
    duel: true,
    deathmatch: true
  }),
  replay: DEFAULT_PVP_REPLAY_CONFIG
});

export const PVP_MODE_CAPACITY = Object.freeze(
  Object.fromEntries(
    Object.entries(PVP_COMBAT_MODES).map(([mode, config]) => [mode, config.capacity])
  )
);

const PVP_MODES = new Set(Object.keys(PVP_MODE_CAPACITY));

function normalizeNonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return fallback;
  }
  return Math.floor(number);
}

export function normalizePvpMode(value, fallback = 'duel') {
  const normalized = normalizeCombatMode(value, null);
  if (normalized && PVP_MODES.has(normalized)) {
    return normalized;
  }
  return fallback;
}

export function normalizePvpMapSelectionInput(value, fallback = PVP_DEFAULT_MAP_SELECTION) {
  return normalizePvpMapSelection(value, fallback);
}

export function normalizePvpConfig(input) {
  const source = input && typeof input === 'object' ? input : {};
  const allowModes = source.allowModes && typeof source.allowModes === 'object' ? source.allowModes : {};
  const replay = source.replay && typeof source.replay === 'object' ? source.replay : {};
  const replayModes = replay.modes && typeof replay.modes === 'object' ? replay.modes : {};

  return {
    enabled: Boolean(source.enabled),
    matchmakingEnabled: Boolean(source.matchmakingEnabled),
    rewardEnabled: Boolean(source.rewardEnabled),
    maxActiveRooms: Math.max(
      1,
      normalizeNonNegativeInteger(source.maxActiveRooms, DEFAULT_PVP_CONFIG.maxActiveRooms)
    ),
    maxRoomIdleSeconds: Math.max(
      60,
      normalizeNonNegativeInteger(source.maxRoomIdleSeconds, DEFAULT_PVP_CONFIG.maxRoomIdleSeconds)
    ),
    allowModes: {
      duel: allowModes.duel !== false,
      deathmatch: allowModes.deathmatch !== false
    },
    replay: {
      enabled: Boolean(replay.enabled),
      maxStoredMatches: Math.max(
        0,
        normalizeNonNegativeInteger(
          replay.maxStoredMatches,
          DEFAULT_PVP_REPLAY_CONFIG.maxStoredMatches
        )
      ),
      compressOnComplete:
        replay.compressOnComplete === undefined
          ? DEFAULT_PVP_REPLAY_CONFIG.compressOnComplete
          : Boolean(replay.compressOnComplete),
      modes: {
        duel:
          replayModes.duel === undefined
            ? DEFAULT_PVP_REPLAY_CONFIG.modes.duel
            : Boolean(replayModes.duel),
        deathmatch:
          replayModes.deathmatch === undefined
            ? DEFAULT_PVP_REPLAY_CONFIG.modes.deathmatch
            : Boolean(replayModes.deathmatch)
      }
    }
  };
}

function createPvpError(code, status = 400, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

function normalizeUser(user) {
  const source = user && typeof user === 'object' ? user : {};
  return {
    id: String(source.id || source.userId || ''),
    username: String(source.username || ''),
    displayName: String(source.displayName || source.username || source.id || 'Player'),
    avatarUrl: source.avatarUrl || null
  };
}

function getCapacityForMode(mode) {
  return PVP_MODE_CAPACITY[normalizePvpMode(mode)] || PVP_MODE_CAPACITY.duel;
}

function createRoomCode(existingRooms) {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    let code = '';
    for (let index = 0; index < 6; index += 1) {
      code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
    }

    const duplicated = Array.from(existingRooms.values()).some((room) => room.roomCode === code);
    if (!duplicated) {
      return code;
    }
  }

  return randomUUID().slice(0, 6).toUpperCase();
}

function createMember(userKey, user, joinedAt, presence = 'online') {
  return {
    userKey,
    user: normalizeUser(user),
    isHost: false,
    isReady: false,
    joinedAt,
    lastSeenAt: joinedAt,
    presence
  };
}

function summarizeMember(member) {
  return {
    userId: member.user.id,
    username: member.user.username,
    displayName: member.user.displayName,
    avatarUrl: member.user.avatarUrl || null,
    isHost: Boolean(member.isHost),
    isReady: Boolean(member.isReady),
    joinedAt: member.joinedAt,
    presence: member.presence || 'offline'
  };
}

function canRoomStart(room) {
  return (
    !room.currentMatchId &&
    room.members.length === room.capacity &&
    room.members.every((member) => member.isReady && member.presence === 'online')
  );
}

function computeRoomStatus(room) {
  if (room.currentMatchId) return 'in_match';
  if (room.isStarting) return 'starting';
  if (room.members.length < room.capacity) return 'idle';
  if (canRoomStart(room)) return 'ready';
  return 'full';
}

function summarizeRoom(room) {
  if (!room) return null;

  const members = room.members.map(summarizeMember);
  const hostUser = members.find((member) => member.isHost) || null;

  return {
    roomId: room.roomId,
    roomCode: room.roomCode,
    mode: room.mode,
    mapSelection: normalizePvpMapSelectionInput(room.mapSelection, PVP_DEFAULT_MAP_SELECTION),
    mapId: room.mapId || null,
    capacity: room.capacity,
    source: room.source,
    status: computeRoomStatus(room),
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    hostUser,
    members,
    canStart: canRoomStart(room),
    currentMatchId: room.currentMatchId || null
  };
}

function summarizeQueue(entry, estimatedSize = 0) {
  if (!entry) return null;

  return {
    mode: entry.mode,
    mapSelection: normalizePvpMapSelectionInput(entry.mapSelection, PVP_DEFAULT_MAP_SELECTION),
    queuedAt: entry.queuedAt,
    status: entry.status || 'queued',
    estimatedSize
  };
}

function resolveRoomMapSelection(mapSelection, fallback = PVP_DEFAULT_MAP_SELECTION) {
  return normalizePvpMapSelectionInput(mapSelection, fallback);
}

function resolveMatchMapId(mapSelection, seed = '') {
  return resolvePvpMapSelection(resolveRoomMapSelection(mapSelection), {
    preferredMapId: null,
    seed
  });
}

function toPublicConfig(config) {
  const normalized = normalizePvpConfig(config);
  return {
    enabled: normalized.enabled,
    matchmakingEnabled: normalized.matchmakingEnabled,
    rewardEnabled: normalized.rewardEnabled,
    maxActiveRooms: normalized.maxActiveRooms,
    maxRoomIdleSeconds: normalized.maxRoomIdleSeconds,
    allowModes: {
      duel: normalized.allowModes.duel,
      deathmatch: normalized.allowModes.deathmatch
    },
    replay: {
      enabled: normalized.replay?.enabled === true,
      maxStoredMatches: Number(normalized.replay?.maxStoredMatches || 0),
      compressOnComplete: normalized.replay?.compressOnComplete !== false,
      modes: {
        duel: normalized.replay?.modes?.duel === true,
        deathmatch: normalized.replay?.modes?.deathmatch !== false
      }
    }
  };
}

function parseClientMessage(text) {
  try {
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== 'object') {
      throw new Error('invalid_message');
    }
    return payload;
  } catch {
    throw createPvpError('invalid_ws_message', 400);
  }
}

function createWebSocketFrame(opcode, payloadBuffer) {
  const payload = Buffer.isBuffer(payloadBuffer) ? payloadBuffer : Buffer.from(payloadBuffer || '');
  let header;

  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  header[0] = 0x80 | (opcode & 0x0f);
  return Buffer.concat([header, payload]);
}

function tryParseWebSocketFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];
    const fin = (firstByte & 0x80) !== 0;
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7f;
    let cursor = offset + 2;

    if (!fin) {
      throw createPvpError('ws_fragmented_frame_unsupported', 400);
    }

    if (payloadLength === 126) {
      if (cursor + 2 > buffer.length) break;
      payloadLength = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (payloadLength === 127) {
      if (cursor + 8 > buffer.length) break;
      payloadLength = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }

    const maskingKeyLength = masked ? 4 : 0;
    if (cursor + maskingKeyLength + payloadLength > buffer.length) {
      break;
    }

    const maskingKey = masked ? buffer.subarray(cursor, cursor + 4) : null;
    cursor += maskingKeyLength;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + payloadLength));

    if (maskingKey) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= maskingKey[index % 4];
      }
    }

    frames.push({ opcode, payload });
    offset = cursor + payloadLength;
  }

  return {
    frames,
    remaining: buffer.subarray(offset)
  };
}

function upgradeToWebSocket(req, socket, head, handlers) {
  const key = String(req.headers['sec-websocket-key'] || '').trim();
  if (!key) {
    throw createPvpError('ws_missing_key', 400);
  }

  const accept = createHash('sha1')
    .update(`${key}${WS_MAGIC}`)
    .digest('base64');

  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n'
    ].join('\r\n')
  );

  if (head && head.length) {
    socket.unshift(head);
  }

  socket.setNoDelay(true);

  let closed = false;
  let closeNotified = false;
  let buffer = Buffer.alloc(0);

  const notifyClose = () => {
    if (closeNotified) return;
    closeNotified = true;
    handlers.onClose?.();
  };

  const peer = {
    subscribedMatchId: null,
    send(payload) {
      if (closed) return;
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
      socket.write(createWebSocketFrame(0x1, Buffer.from(text, 'utf8')));
    },
    close(code = 1000, reason = '') {
      if (closed) return;
      closed = true;
      const reasonBuffer = Buffer.from(String(reason || ''), 'utf8');
      const payload = Buffer.alloc(2 + reasonBuffer.length);
      payload.writeUInt16BE(code, 0);
      reasonBuffer.copy(payload, 2);
      try {
        socket.write(createWebSocketFrame(0x8, payload));
      } catch {}
      socket.destroy();
      notifyClose();
    }
  };

  const handleClose = () => {
    if (!closed) {
      closed = true;
    }
    notifyClose();
  };

  const handleMessageError = (error) => {
    handlers.onError?.(error);
    peer.send({
      type: 'pvp.error',
      error: error?.code || error?.message || 'ws_handler_error'
    });
  };

  socket.on('data', (chunk) => {
    if (closed) return;
    buffer = Buffer.concat([buffer, chunk]);

    let parsed;
    try {
      parsed = tryParseWebSocketFrames(buffer);
    } catch (error) {
      handlers.onError?.(error);
      peer.close(1003, 'invalid_frame');
      return;
    }

    buffer = Buffer.from(parsed.remaining);

    for (const frame of parsed.frames) {
      if (frame.opcode === 0x8) {
        peer.close(1000, 'closing');
        return;
      }

      if (frame.opcode === 0x9) {
        socket.write(createWebSocketFrame(0xA, frame.payload));
        continue;
      }

      if (frame.opcode !== 0x1) {
        continue;
      }

      Promise.resolve(handlers.onMessage?.(frame.payload.toString('utf8'))).catch(handleMessageError);
    }
  });

  socket.on('close', handleClose);
  socket.on('end', handleClose);
  socket.on('error', (error) => {
    handlers.onError?.(error);
    handleClose();
  });

  return peer;
}

export function createPvpService(options = {}) {
  const getNowMs = typeof options.getNowMs === 'function' ? options.getNowMs : () => Date.now();
  const getNowIso =
    typeof options.getNowIso === 'function' ? options.getNowIso : () => new Date(getNowMs()).toISOString();
  const getConfig =
    typeof options.getConfig === 'function'
      ? options.getConfig
      : () => normalizePvpConfig(DEFAULT_PVP_CONFIG);
  const onMatchFinished =
    typeof options.onMatchFinished === 'function' ? options.onMatchFinished : async () => {};
  const createReplayRecorder =
    typeof options.createReplayRecorder === 'function' ? options.createReplayRecorder : async () => null;

  const rooms = new Map();
  const roomMembershipByUser = new Map();
  const queueByMode = {
    duel: [],
    deathmatch: []
  };
  const queueEntryByUser = new Map();
  const connectionsByUser = new Map();
  const liveMatches = new Map();
  const matchIdByUser = new Map();
  const spectatorMatchIdByUser = new Map();

  const matchTickTimer = setInterval(() => {
    tickMatches().catch(() => {});
  }, COMBAT_TICK_MS);
  matchTickTimer.unref?.();

  async function readConfig() {
    return normalizePvpConfig(await Promise.resolve(getConfig()));
  }

  function getRoomForUser(userKey) {
    const roomId = roomMembershipByUser.get(userKey);
    return roomId ? rooms.get(roomId) || null : null;
  }

  function getQueueForUser(userKey) {
    return queueEntryByUser.get(userKey) || null;
  }

  function getPlayerMatchForUser(userKey) {
    const matchId = matchIdByUser.get(userKey);
    return matchId ? liveMatches.get(matchId) || null : null;
  }

  function getSpectatedMatchForUser(userKey) {
    const matchId = spectatorMatchIdByUser.get(userKey);
    return matchId ? liveMatches.get(matchId) || null : null;
  }

  function getMatchContextForUser(userKey) {
    const playerRuntime = getPlayerMatchForUser(userKey);
    if (playerRuntime) {
      return {
        runtime: playerRuntime,
        role: 'player'
      };
    }

    const spectatorRuntime = getSpectatedMatchForUser(userKey);
    if (spectatorRuntime) {
      return {
        runtime: spectatorRuntime,
        role: 'spectator'
      };
    }

    return null;
  }

  function hasLiveConnection(userKey) {
    const entries = connectionsByUser.get(userKey);
    return Boolean(entries && entries.size > 0);
  }

  function ensurePvpEnabled(config) {
    if (!config.enabled) {
      throw createPvpError('pvp_disabled', 403);
    }
  }

  function ensureMatchmakingEnabled(config) {
    if (!config.matchmakingEnabled) {
      throw createPvpError('matchmaking_disabled', 403);
    }
  }

  function ensureModeAllowed(config, mode) {
    if (!config.allowModes?.[mode]) {
      throw createPvpError('pvp_mode_disabled', 403);
    }
  }

  function ensureRoomLimit(config) {
    if (rooms.size >= config.maxActiveRooms) {
      throw createPvpError('room_limit_reached', 409);
    }
  }

  function ensureNotInLiveMatch(userKey) {
    if (getMatchContextForUser(userKey)) {
      throw createPvpError('already_in_match', 409);
    }
  }

  function getRuntimeAudienceUserKeys(runtime) {
    const recipients = new Set();

    for (const player of runtime?.state?.players || []) {
      recipients.add(player.userKey);
    }

    for (const userKey of runtime?.spectators?.keys?.() || []) {
      recipients.add(userKey);
    }

    return [...recipients];
  }

  function getRuntimeRoleForUser(runtime, userKey) {
    if (runtime?.state?.players?.some((player) => player.userKey === userKey)) {
      return 'player';
    }
    if (runtime?.spectators?.has(userKey)) {
      return 'spectator';
    }
    return null;
  }

  function emitToUser(userKey, payload, options = {}) {
    const peers = connectionsByUser.get(userKey);
    if (!peers) return;
    for (const peer of peers.values()) {
      if (options.matchId && peer.subscribedMatchId && peer.subscribedMatchId !== options.matchId) {
        continue;
      }
      try {
        peer.send(payload);
      } catch {}
    }
  }

  function emitRoomUpdated(room) {
    const summary = summarizeRoom(room);
    for (const member of room.members) {
      emitToUser(member.userKey, {
        type: 'pvp.room.updated',
        room: summary
      });
    }
  }

  function emitQueueUpdated(userKey) {
    const entry = getQueueForUser(userKey);
    emitToUser(userKey, {
      type: 'pvp.queue.updated',
      queue: summarizeQueue(entry, entry ? queueByMode[entry.mode].length : 0)
    });
  }

  function emitMatchEvent(runtime, event) {
    runtime.replayRecorder?.recordEvent?.({
      matchId: runtime.matchId,
      mode: runtime.mode,
      event
    });
    for (const userKey of getRuntimeAudienceUserKeys(runtime)) {
      emitToUser(userKey, {
        type: 'pvp.match.event',
        matchId: runtime.matchId,
        mode: runtime.mode,
        event
      });
    }
  }

  function buildMatchSummaryForUser(runtime, userKey, wsUrl = '') {
    if (!runtime) return null;
    const player = runtime.state.players.find((entry) => entry.userKey === userKey) || null;
    const role = getRuntimeRoleForUser(runtime, userKey) || 'player';
    return {
      matchId: runtime.matchId,
      roomId: runtime.roomId,
      roomCode: runtime.roomCode,
      mode: runtime.mode,
      mapSelection: runtime.mapSelection,
      mapId: runtime.mapId || runtime.state.mapId || null,
      status: runtime.state.status,
      source: runtime.source,
      role,
      seat: role === 'player' ? (player?.seat ?? null) : null,
      team: role === 'player' ? (player?.team ?? null) : null,
      reconnectDeadline: role === 'player' ? (player?.reconnectDeadline || null) : null,
      spectatorCount: runtime.spectators?.size || 0,
      startedAt: runtime.startedAt,
      wsUrl
    };
  }

  function buildMatchStartedPayload(runtime, userKey, wsUrl = '') {
    const player = runtime.state.players.find((entry) => entry.userKey === userKey) || null;
    const role = getRuntimeRoleForUser(runtime, userKey) || 'player';
    return {
      type: 'pvp.match.started',
      matchId: runtime.matchId,
      mode: runtime.mode,
      mapSelection: runtime.mapSelection,
      mapId: runtime.mapId || runtime.state.mapId || null,
      roomId: runtime.roomId,
      roomCode: runtime.roomCode,
      status: runtime.state.status,
      role,
      seat: role === 'player' ? (player?.seat ?? null) : null,
      team: role === 'player' ? (player?.team ?? null) : null,
      reconnectDeadline: role === 'player' ? (player?.reconnectDeadline || null) : null,
      spectatorCount: runtime.spectators?.size || 0,
      wsUrl,
      snapshot: buildCombatSnapshot(runtime.state),
      scoreboard: runtime.lastScoreboard
    };
  }

  function buildMatchSnapshotPayload(runtime) {
    return {
      type: 'pvp.match.snapshot',
      mapSelection: runtime.mapSelection,
      ...buildCombatSnapshot(runtime.state),
      serverTime: runtime.state.startedAtMs + runtime.state.tick * COMBAT_TICK_MS,
      scoreboard: runtime.lastScoreboard,
      spectatorCount: runtime.spectators?.size || 0
    };
  }

  function emitMatchStarted(runtime, wsUrl = '') {
    for (const userKey of getRuntimeAudienceUserKeys(runtime)) {
      emitToUser(userKey, buildMatchStartedPayload(runtime, userKey, wsUrl));
    }
  }

  function emitMatchSnapshot(runtime) {
    const payload = buildMatchSnapshotPayload(runtime);
    runtime.replayRecorder?.recordSnapshot?.(payload);
    for (const userKey of getRuntimeAudienceUserKeys(runtime)) {
      emitToUser(userKey, {
        ...payload,
        role: getRuntimeRoleForUser(runtime, userKey) || 'player'
      });
    }
  }

  function touchRoom(room) {
    if (!room) return;
    room.updatedAt = getNowIso();
  }

  function refreshHost(room) {
    if (!room) return;
    let hostAssigned = false;
    for (const member of room.members) {
      if (!hostAssigned) {
        member.isHost = true;
        room.hostUserKey = member.userKey;
        hostAssigned = true;
      } else {
        member.isHost = false;
      }
    }
  }

  function normalizeRoomSummaryForUser(userKey) {
    return summarizeRoom(getRoomForUser(userKey));
  }

  function normalizeQueueSummaryForUser(userKey) {
    const entry = getQueueForUser(userKey);
    return summarizeQueue(entry, entry ? queueByMode[entry.mode].length : 0);
  }

  function buildBootstrapPayload({ userKey, wsUrl, config }) {
    const normalizedConfig = normalizePvpConfig(config);
    const matchContext = getMatchContextForUser(userKey);
    return {
      config: toPublicConfig(normalizedConfig),
      currentRoom: normalizeRoomSummaryForUser(userKey),
      currentQueue: normalizeQueueSummaryForUser(userKey),
      currentMatch: matchContext?.runtime
        ? buildMatchSummaryForUser(matchContext.runtime, userKey, wsUrl)
        : null,
      wsUrl
    };
  }

  function findRoomByCode(roomCode) {
    const normalizedCode = String(roomCode || '').trim().toUpperCase();
    if (!normalizedCode) {
      return null;
    }
    return Array.from(rooms.values()).find((room) => room.roomCode === normalizedCode) || null;
  }

  function removeSpectatorState(userKey, runtime = null) {
    const targetRuntime = runtime || getSpectatedMatchForUser(userKey);
    if (targetRuntime?.spectators) {
      targetRuntime.spectators.delete(userKey);
    }

    if (spectatorMatchIdByUser.has(userKey)) {
      spectatorMatchIdByUser.delete(userKey);
    }
  }

  function removeRoom(room, reason = 'room_expired', emitError = true) {
    if (!room) return;

    rooms.delete(room.roomId);
    for (const member of room.members) {
      if (roomMembershipByUser.get(member.userKey) === room.roomId) {
        roomMembershipByUser.delete(member.userKey);
      }
      if (emitError) {
        emitToUser(member.userKey, {
          type: 'pvp.error',
          error: reason
        });
      }
      emitToUser(member.userKey, {
        type: 'pvp.room.updated',
        room: null
      });
    }
  }

  function createRoomInternal({ userKey, user, mode, mapSelection = PVP_DEFAULT_MAP_SELECTION, source = 'private' }) {
    const now = getNowIso();
    const room = {
      roomId: randomUUID(),
      roomCode: createRoomCode(rooms),
      mode,
      mapSelection: resolveRoomMapSelection(mapSelection),
      mapId: null,
      source,
      capacity: getCapacityForMode(mode),
      hostUserKey: userKey,
      createdAt: now,
      updatedAt: now,
      isStarting: false,
      currentMatchId: null,
      members: []
    };

    const member = createMember(userKey, user, now, hasLiveConnection(userKey) ? 'online' : 'offline');
    member.isHost = true;
    room.members.push(member);
    rooms.set(room.roomId, room);
    roomMembershipByUser.set(userKey, room.roomId);
    return room;
  }

  function removeQueueEntry(entry) {
    if (!entry) return;

    const queue = queueByMode[entry.mode] || [];
    const index = queue.findIndex((item) => item.userKey === entry.userKey);
    if (index >= 0) {
      queue.splice(index, 1);
    }
    queueEntryByUser.delete(entry.userKey);
  }

  function settleRoomAfterMatch(room) {
    if (!room) return;

    room.currentMatchId = null;
    room.isStarting = false;
    room.mapId = null;
    touchRoom(room);

    if (room.source === 'matchmaking') {
      removeRoom(room, 'match_complete', false);
      return;
    }

    for (const member of room.members) {
      member.isReady = false;
      member.presence = hasLiveConnection(member.userKey) ? 'online' : 'offline';
      member.lastSeenAt = getNowIso();
    }
    refreshHost(room);
    emitRoomUpdated(room);
  }

  async function persistMatch(runtime, result, aborted = false, replay = null) {
    try {
      await onMatchFinished({
        result,
        aborted,
        room: summarizeRoom(rooms.get(runtime.roomId) || null),
        roomId: runtime.roomId,
        roomCode: runtime.roomCode,
        source: runtime.source,
        mapSelection: runtime.mapSelection,
        mapId: runtime.mapId,
        startedAt: runtime.startedAt,
        endedAt: getNowIso(),
        players: runtime.state.players.map((player) => ({
          userId: player.userId,
          username: player.username,
          displayName: player.displayName,
          team: player.team
        })),
        replay
      });
    } catch {}
  }

  async function finishRuntime(runtime, options = {}) {
    if (!runtime || runtime.finished) return;
    runtime.finished = true;

    const room = rooms.get(runtime.roomId) || null;
    const result = options.result || runtime.state.result || buildCombatResult(runtime.state, runtime.state.endedReason);
    const audienceUserKeys = getRuntimeAudienceUserKeys(runtime);

    for (const player of runtime.state.players) {
      if (matchIdByUser.get(player.userKey) === runtime.matchId) {
        matchIdByUser.delete(player.userKey);
      }
    }

    for (const userKey of runtime.spectators?.keys?.() || []) {
      if (spectatorMatchIdByUser.get(userKey) === runtime.matchId) {
        spectatorMatchIdByUser.delete(userKey);
      }
    }

    liveMatches.delete(runtime.matchId);

    if (options.aborted) {
      for (const userKey of audienceUserKeys) {
        emitToUser(userKey, {
          type: 'pvp.match.aborted',
          matchId: runtime.matchId,
          mode: runtime.mode,
          mapSelection: runtime.mapSelection,
          mapId: runtime.mapId || runtime.state.mapId || null,
          role: getRuntimeRoleForUser(runtime, userKey) || 'player',
          reason: options.reason || 'match_aborted',
          result
        });
      }
    } else {
      for (const userKey of audienceUserKeys) {
        emitToUser(userKey, {
          type: 'pvp.match.ended',
          matchId: runtime.matchId,
          mode: runtime.mode,
          mapSelection: runtime.mapSelection,
          mapId: runtime.mapId || runtime.state.mapId || null,
          role: getRuntimeRoleForUser(runtime, userKey) || 'player',
          result
        });
      }
    }

    let replay = null;
    try {
      replay = await runtime.replayRecorder?.finalize?.({
        matchId: runtime.matchId,
        mode: runtime.mode,
        aborted: Boolean(options.aborted),
        reason: options.reason || null,
        result
      });
    } catch {}

    runtime.replayRecorder = null;
    runtime.spectators?.clear?.();
    await persistMatch(runtime, result, Boolean(options.aborted), replay);
    settleRoomAfterMatch(room);
  }

  function abortRuntime(runtime, reason = 'match_aborted') {
    if (!runtime || runtime.finished) return;
    runtime.state.status = 'ended';
    runtime.state.endedReason = reason;
    runtime.state.result = buildCombatResult(runtime.state, reason);
    finishRuntime(runtime, {
      aborted: true,
      reason,
      result: runtime.state.result
    }).catch(() => {});
  }

  async function createRuntimeForRoom(room, config = null) {
    const players = room.members.map((member) => ({
      ...member.user,
      userKey: member.userKey
    }));
    const mapSelection = resolveRoomMapSelection(room.mapSelection, PVP_DEFAULT_MAP_SELECTION);
    const mapId = resolveMatchMapId(mapSelection, room.roomId || room.roomCode || room.hostUserKey || '');
    const runtime = {
      matchId: randomUUID(),
      roomId: room.roomId,
      roomCode: room.roomCode,
      mode: room.mode,
      mapSelection,
      mapId,
      source: room.source,
      startedAt: getNowIso(),
      state: createInitialCombatState({
        matchId: randomUUID(),
        roomId: room.roomId,
        roomCode: room.roomCode,
        mode: room.mode,
        mapId,
        players,
        startedAtMs: getNowMs()
      }),
      inputByUserKey: new Map(),
      replayRecorder: null,
      spectators: new Map(),
      lastScoreboard: null,
      lastSnapshotTick: 0,
      finished: false
    };

    runtime.matchId = runtime.state.matchId;
    runtime.lastScoreboard =
      runtime.mode === 'duel'
        ? { wins: { ...runtime.state.wins } }
        : {
            lives: Object.fromEntries(
              runtime.state.players.map((player) => [
                player.team,
                {
                  lives: player.lives,
                  kills: player.kills,
                  deaths: player.deaths
                }
              ])
            )
          };

    const normalizedConfig = normalizePvpConfig(config || (await readConfig()));
    runtime.replayRecorder = await createReplayRecorder({
      matchId: runtime.matchId,
      roomId: room.roomId,
      roomCode: room.roomCode,
      mode: room.mode,
      mapSelection,
      mapId,
      source: room.source,
      startedAt: runtime.startedAt,
      config: normalizedConfig,
      players: runtime.state.players.map((player) => ({
        userId: player.userId,
        userKey: player.userKey,
        username: player.username,
        displayName: player.displayName,
        team: player.team
      }))
    });
    runtime.replayRecorder?.recordMeta?.({
      matchId: runtime.matchId,
      roomId: room.roomId,
      roomCode: room.roomCode,
      mode: room.mode,
      mapSelection,
      mapId,
      source: room.source,
      startedAt: runtime.startedAt,
      players: runtime.state.players.map((player) => ({
        userId: player.userId,
        username: player.username,
        displayName: player.displayName,
        team: player.team
      })),
      snapshotRateHz: Number((1000 / (COMBAT_TICK_MS * SNAPSHOT_TICK_INTERVAL)).toFixed(4)),
      tickRateHz: Number((1000 / COMBAT_TICK_MS).toFixed(4))
    });
    runtime.replayRecorder?.recordSnapshot?.(buildMatchSnapshotPayload(runtime));

    liveMatches.set(runtime.matchId, runtime);
    room.currentMatchId = runtime.matchId;
    room.mapId = mapId;
    for (const member of room.members) {
      member.isReady = false;
      matchIdByUser.set(member.userKey, runtime.matchId);
    }
    touchRoom(room);
    return runtime;
  }

  async function createRoom({ userKey, user, mode, mapSelection }) {
    const config = await readConfig();
    ensurePvpEnabled(config);

    const normalizedMode = normalizePvpMode(mode, null);
    if (!normalizedMode) {
      throw createPvpError('invalid_mode', 400);
    }
    const requestedMapSelection = normalizePvpMapSelectionInput(mapSelection, null);
    if (mapSelection !== undefined && mapSelection !== null && !requestedMapSelection) {
      throw createPvpError('invalid_map_selection', 400);
    }
    const normalizedMapSelection =
      requestedMapSelection || normalizePvpMapSelectionInput(PVP_DEFAULT_MAP_SELECTION, PVP_DEFAULT_MAP_SELECTION);
    ensureModeAllowed(config, normalizedMode);
    ensureNotInLiveMatch(userKey);

    if (getRoomForUser(userKey)) {
      throw createPvpError('already_in_room', 409);
    }
    if (getQueueForUser(userKey)) {
      throw createPvpError('already_in_queue', 409);
    }

    ensureRoomLimit(config);

    const room = createRoomInternal({
      userKey,
      user,
      mode: normalizedMode,
      mapSelection: normalizedMapSelection,
      source: 'private'
    });

    emitRoomUpdated(room);

    return {
      room: summarizeRoom(room)
    };
  }

  async function joinRoom({ userKey, user, roomCode }) {
    const config = await readConfig();
    ensurePvpEnabled(config);
    ensureNotInLiveMatch(userKey);

    if (getRoomForUser(userKey)) {
      throw createPvpError('already_in_room', 409);
    }
    if (getQueueForUser(userKey)) {
      throw createPvpError('already_in_queue', 409);
    }

    const normalizedCode = String(roomCode || '').trim().toUpperCase();
    if (!normalizedCode) {
      throw createPvpError('invalid_room_code', 400);
    }

    const room = findRoomByCode(normalizedCode);
    if (!room) {
      throw createPvpError('room_not_found', 404);
    }

    if (room.currentMatchId) {
      throw createPvpError('room_already_started', 409);
    }

    ensureModeAllowed(config, room.mode);

    if (room.members.length >= room.capacity) {
      throw createPvpError('room_full', 409);
    }

    const member = createMember(userKey, user, getNowIso(), hasLiveConnection(userKey) ? 'online' : 'offline');
    room.members.push(member);
    roomMembershipByUser.set(userKey, room.roomId);
    touchRoom(room);
    emitRoomUpdated(room);

    return {
      room: summarizeRoom(room)
    };
  }

  async function spectateRoom({ userKey, user, roomCode, wsUrl = '' }) {
    const config = await readConfig();
    ensurePvpEnabled(config);
    ensureNotInLiveMatch(userKey);

    if (getRoomForUser(userKey)) {
      throw createPvpError('already_in_room', 409);
    }
    if (getQueueForUser(userKey)) {
      throw createPvpError('already_in_queue', 409);
    }

    const normalizedCode = String(roomCode || '').trim().toUpperCase();
    if (!normalizedCode) {
      throw createPvpError('invalid_room_code', 400);
    }

    const room = findRoomByCode(normalizedCode);
    if (!room) {
      throw createPvpError('room_not_found', 404);
    }

    ensureModeAllowed(config, room.mode);

    if (!room.currentMatchId) {
      throw createPvpError('match_not_live', 409);
    }

    const runtime = liveMatches.get(room.currentMatchId) || null;
    if (!runtime || runtime.finished) {
      throw createPvpError('match_not_live', 409);
    }

    runtime.spectators.set(userKey, {
      userKey,
      user: normalizeUser(user),
      joinedAt: getNowIso()
    });
    spectatorMatchIdByUser.set(userKey, runtime.matchId);

    emitToUser(userKey, {
      type: 'pvp.session.synced',
      ...buildBootstrapPayload({
        userKey,
        wsUrl,
        config
      })
    });

    return {
      match: buildMatchSummaryForUser(runtime, userKey, wsUrl)
    };
  }

  async function leaveSpectate({ userKey, wsUrl = '' }) {
    const config = await readConfig();
    const runtime = getSpectatedMatchForUser(userKey);

    removeSpectatorState(userKey, runtime);

    emitToUser(userKey, {
      type: 'pvp.session.synced',
      ...buildBootstrapPayload({
        userKey,
        wsUrl,
        config
      })
    });

    return {
      match: null
    };
  }

  function leaveRoomInternal(userKey) {
    const room = getRoomForUser(userKey);
    if (!room) {
      throw createPvpError('room_not_found', 404);
    }
    if (room.currentMatchId) {
      throw createPvpError('room_already_started', 409);
    }

    room.members = room.members.filter((member) => member.userKey !== userKey);
    roomMembershipByUser.delete(userKey);

    if (!room.members.length) {
      rooms.delete(room.roomId);
      emitToUser(userKey, {
        type: 'pvp.room.updated',
        room: null
      });
      return {
        room: null
      };
    }

    refreshHost(room);
    touchRoom(room);
    emitRoomUpdated(room);
    emitToUser(userKey, {
      type: 'pvp.room.updated',
      room: null
    });

    return {
      room: summarizeRoom(room)
    };
  }

  async function leaveRoom({ userKey }) {
    return leaveRoomInternal(userKey);
  }

  async function setReady({ userKey, ready }) {
    const config = await readConfig();
    ensurePvpEnabled(config);

    const room = getRoomForUser(userKey);
    if (!room) {
      throw createPvpError('room_not_found', 404);
    }
    if (room.currentMatchId) {
      throw createPvpError('room_already_started', 409);
    }

    ensureModeAllowed(config, room.mode);

    const member = room.members.find((entry) => entry.userKey === userKey);
    if (!member) {
      throw createPvpError('room_not_found', 404);
    }

    member.isReady = Boolean(ready);
    member.lastSeenAt = getNowIso();
    touchRoom(room);
    emitRoomUpdated(room);

    return {
      room: summarizeRoom(room)
    };
  }

  async function startRoom({ userKey, wsUrl = '' }) {
    const config = await readConfig();
    ensurePvpEnabled(config);

    const room = getRoomForUser(userKey);
    if (!room) {
      throw createPvpError('room_not_found', 404);
    }

    ensureModeAllowed(config, room.mode);

    if (room.currentMatchId) {
      throw createPvpError('room_already_started', 409);
    }

    if (room.hostUserKey !== userKey) {
      throw createPvpError('not_room_host', 403);
    }

    if (!canRoomStart(room)) {
      throw createPvpError('room_not_ready', 409);
    }

    room.isStarting = true;
    touchRoom(room);
    emitRoomUpdated(room);

    for (const member of room.members) {
      emitToUser(member.userKey, {
        type: 'pvp.room.starting',
        room: summarizeRoom(room)
      });
    }

    const runtime = await createRuntimeForRoom(room, config);
    room.isStarting = false;
    emitRoomUpdated(room);
    emitMatchStarted(runtime, wsUrl);

    return {
      room: summarizeRoom(room),
      match: buildMatchSummaryForUser(runtime, userKey, wsUrl)
    };
  }

  function findCompatibleQueueGroup(queue, capacity) {
    if (!Array.isArray(queue) || queue.length < capacity) {
      return null;
    }

    for (let startIndex = 0; startIndex < queue.length; startIndex += 1) {
      const matchedIndexes = [startIndex];
      const selections = [queue[startIndex].mapSelection];

      for (let index = startIndex + 1; index < queue.length && matchedIndexes.length < capacity; index += 1) {
        const nextSelection = queue[index].mapSelection;
        if (!matchedIndexes.every((matchedIndex) => isCompatiblePvpMapSelection(queue[matchedIndex].mapSelection, nextSelection))) {
          continue;
        }

        const preferredSelection = resolvePreferredPvpMapSelection(
          [...selections, nextSelection],
          PVP_MAP_SELECTION_RANDOM
        );
        if (!preferredSelection) {
          continue;
        }

        matchedIndexes.push(index);
        selections.push(nextSelection);
      }

      if (matchedIndexes.length === capacity) {
        return {
          matchedIndexes,
          mapSelection: resolvePreferredPvpMapSelection(selections, PVP_MAP_SELECTION_RANDOM) || PVP_DEFAULT_MAP_SELECTION
        };
      }
    }

    return null;
  }

  function maybeMatchmake(mode, config) {
    const queue = queueByMode[mode];
    const capacity = getCapacityForMode(mode);

    if (!Array.isArray(queue) || queue.length < capacity) {
      return [];
    }

    const matchedUserKeys = [];
    while (rooms.size < config.maxActiveRooms) {
      const group = findCompatibleQueueGroup(queue, capacity);
      if (!group) {
        break;
      }

      const matchedEntries = group.matchedIndexes.map((index) => queue[index]);
      for (const index of [...group.matchedIndexes].sort((left, right) => right - left)) {
        queue.splice(index, 1);
      }
      for (const entry of matchedEntries) {
        queueEntryByUser.delete(entry.userKey);
      }

      const room = createRoomInternal({
        userKey: matchedEntries[0].userKey,
        user: matchedEntries[0].user,
        mode,
        mapSelection: group.mapSelection,
        source: 'matchmaking'
      });

      room.members = [];
      for (const [index, entry] of matchedEntries.entries()) {
        const member = createMember(
          entry.userKey,
          entry.user,
          getNowIso(),
          hasLiveConnection(entry.userKey) ? 'online' : 'offline'
        );
        member.isHost = index === 0;
        room.members.push(member);
        roomMembershipByUser.set(entry.userKey, room.roomId);
        matchedUserKeys.push(entry.userKey);
      }
      refreshHost(room);
      touchRoom(room);

      const roomSummary = summarizeRoom(room);
      for (const entry of matchedEntries) {
        emitToUser(entry.userKey, {
          type: 'pvp.queue.updated',
          queue: null
        });
        emitToUser(entry.userKey, {
          type: 'pvp.match.found',
          room: roomSummary
        });
      }
      emitRoomUpdated(room);
    }

    return matchedUserKeys;
  }

  async function enqueue({ userKey, user, mode, mapSelection }) {
    const config = await readConfig();
    ensurePvpEnabled(config);
    ensureMatchmakingEnabled(config);

    const normalizedMode = normalizePvpMode(mode, null);
    if (!normalizedMode) {
      throw createPvpError('invalid_mode', 400);
    }
    const requestedMapSelection = normalizePvpMapSelectionInput(mapSelection, null);
    if (mapSelection !== undefined && mapSelection !== null && !requestedMapSelection) {
      throw createPvpError('invalid_map_selection', 400);
    }
    const normalizedMapSelection =
      requestedMapSelection || normalizePvpMapSelectionInput(PVP_DEFAULT_MAP_SELECTION, PVP_DEFAULT_MAP_SELECTION);
    ensureModeAllowed(config, normalizedMode);
    ensureNotInLiveMatch(userKey);

    if (getRoomForUser(userKey)) {
      throw createPvpError('already_in_room', 409);
    }
    if (getQueueForUser(userKey)) {
      throw createPvpError('already_in_queue', 409);
    }

    const entry = {
      userKey,
      user: normalizeUser(user),
      mode: normalizedMode,
      mapSelection: normalizedMapSelection,
      queuedAt: getNowIso(),
      status: 'queued'
    };

    queueEntryByUser.set(userKey, entry);
    queueByMode[normalizedMode].push(entry);
    emitQueueUpdated(userKey);
    maybeMatchmake(normalizedMode, config);

    return {
      queue: normalizeQueueSummaryForUser(userKey),
      room: normalizeRoomSummaryForUser(userKey)
    };
  }

  async function cancelQueue({ userKey }) {
    const entry = getQueueForUser(userKey);
    if (!entry) {
      throw createPvpError('queue_not_found', 404);
    }

    removeQueueEntry(entry);
    emitQueueUpdated(userKey);

    return {
      queue: null
    };
  }

  function markPresence(userKey, presence) {
    const room = getRoomForUser(userKey);
    if (room) {
      const member = room.members.find((entry) => entry.userKey === userKey);
      if (member && member.presence !== presence) {
        member.presence = presence;
        if (presence === 'offline') {
          member.isReady = false;
        }
        member.lastSeenAt = getNowIso();
        touchRoom(room);
        emitRoomUpdated(room);
      }
    }

    const runtime = getPlayerMatchForUser(userKey);
    if (!runtime) return;

    if (presence === 'online') {
      markCombatPlayerReconnected(runtime.state, userKey);
    } else {
      markCombatPlayerDisconnected(runtime.state, userKey, getNowMs() + RECONNECT_GRACE_MS);
    }
  }

  async function tickMatches() {
    for (const runtime of [...liveMatches.values()]) {
      if (runtime.finished) continue;

      const result = stepCombatState(runtime.state, runtime.inputByUserKey);
      runtime.lastScoreboard = result.scoreboard;

      for (const event of result.events) {
        emitMatchEvent(runtime, event);
      }

      if (
        runtime.state.tick === 1 ||
        runtime.state.tick - runtime.lastSnapshotTick >= SNAPSHOT_TICK_INTERVAL ||
        result.events.length > 0 ||
        result.ended
      ) {
        runtime.lastSnapshotTick = runtime.state.tick;
        emitMatchSnapshot(runtime);
      }

      if (result.ended) {
        await finishRuntime(runtime, {
          result: result.result,
          aborted: false
        });
      }
    }
  }

  async function cleanup() {
    const config = await readConfig();
    const nowMs = getNowMs();
    const expiryMs = config.maxRoomIdleSeconds * 1000;

    for (const room of [...rooms.values()]) {
      if (room.currentMatchId) {
        continue;
      }

      let removedOfflineMembers = false;

      for (const member of [...room.members]) {
        if (member.presence !== 'offline') {
          continue;
        }

        const lastSeenAtMs = Date.parse(member.lastSeenAt || member.joinedAt || '');
        if (!Number.isFinite(lastSeenAtMs) || nowMs - lastSeenAtMs <= expiryMs) {
          continue;
        }

        room.members = room.members.filter((entry) => entry.userKey !== member.userKey);
        if (roomMembershipByUser.get(member.userKey) === room.roomId) {
          roomMembershipByUser.delete(member.userKey);
        }
        emitToUser(member.userKey, {
          type: 'pvp.room.updated',
          room: null
        });
        removedOfflineMembers = true;
      }

      if (removedOfflineMembers) {
        if (!room.members.length) {
          removeRoom(room, 'room_empty');
          continue;
        }

        refreshHost(room);
        touchRoom(room);
        emitRoomUpdated(room);
      }

      const updatedAtMs = Date.parse(room.updatedAt || room.createdAt || '');
      if (!Number.isFinite(updatedAtMs)) {
        continue;
      }

      if (!room.members.length) {
        removeRoom(room, 'room_empty');
        continue;
      }

      if (nowMs - updatedAtMs > expiryMs) {
        removeRoom(room, 'room_expired');
      }
    }

    for (const entry of [...queueEntryByUser.values()]) {
      const queuedAtMs = Date.parse(entry.queuedAt || '');
      if (!Number.isFinite(queuedAtMs)) {
        continue;
      }

      if (nowMs - queuedAtMs > expiryMs) {
        removeQueueEntry(entry);
        emitToUser(entry.userKey, {
          type: 'pvp.error',
          error: 'matchmaking_expired'
        });
        emitQueueUpdated(entry.userKey);
      }
    }

    for (const runtime of [...liveMatches.values()]) {
      if (runtime.finished) continue;

      for (const player of runtime.state.players) {
        if (player.connected || !player.reconnectDeadline) {
          continue;
        }
        if (player.reconnectDeadline > nowMs) {
          continue;
        }

        const outcome = forceCombatForfeit(runtime.state, player.userKey, 'disconnect_timeout');
        runtime.lastScoreboard =
          runtime.mode === 'duel'
            ? { wins: { ...runtime.state.wins } }
            : {
                lives: Object.fromEntries(
                  runtime.state.players.map((entry) => [
                    entry.team,
                    {
                      lives: entry.lives,
                      kills: entry.kills,
                      deaths: entry.deaths
                    }
                  ])
                )
              };

        for (const event of outcome.events || []) {
          emitMatchEvent(runtime, event);
        }
        emitMatchSnapshot(runtime);

        if (runtime.state.status === 'ended') {
          await finishRuntime(runtime, {
            result: runtime.state.result || outcome.result,
            aborted: false
          });
        }
      }
    }
  }

  async function connectSocket({ req, socket, head, userKey, user, wsUrl }) {
    let connectionId = null;

    const peer = upgradeToWebSocket(req, socket, head, {
      async onMessage(text) {
        const message = parseClientMessage(text);
        const config = await readConfig();

        const sendSynced = () => {
          peer.send({
            type: 'pvp.session.synced',
            ...buildBootstrapPayload({
              userKey,
              wsUrl,
              config
            })
          });
        };

        if (message.type === 'pvp.hello' || message.type === 'pvp.subscribe') {
          sendSynced();
          return;
        }

        if (message.type === 'pvp.room.ready') {
          await setReady({
            userKey,
            ready: Boolean(message.ready ?? message.payload?.ready)
          });
          return;
        }

        if (message.type === 'pvp.room.leave') {
          await leaveRoom({ userKey });
          return;
        }

        if (message.type === 'pvp.matchmaking.enqueue') {
          await enqueue({
            userKey,
            user,
            mode: message.mode || message.payload?.mode,
            mapSelection: message.mapSelection || message.payload?.mapSelection
          });
          return;
        }

        if (message.type === 'pvp.matchmaking.cancel') {
          await cancelQueue({ userKey });
          return;
        }

        if (message.type === 'pvp.room.start') {
          await startRoom({ userKey, wsUrl });
          return;
        }

        if (message.type === 'pvp.match.subscribe') {
          const matchContext = getMatchContextForUser(userKey);
          const runtime = matchContext?.runtime || null;
          if (!runtime || runtime.matchId !== String(message.matchId || '')) {
            throw createPvpError('match_not_found', 404);
          }
          peer.subscribedMatchId = runtime.matchId;
          if (matchContext.role === 'player') {
            markCombatPlayerReconnected(runtime.state, userKey);
          }
          peer.send(buildMatchStartedPayload(runtime, userKey, wsUrl));
          peer.send(buildMatchSnapshotPayload(runtime));
          return;
        }

        if (message.type === 'pvp.match.input') {
          const matchContext = getMatchContextForUser(userKey);
          const runtime = matchContext?.runtime || null;
          if (!runtime || runtime.matchId !== String(message.matchId || '')) {
            throw createPvpError('match_not_found', 404);
          }
          if (matchContext.role !== 'player') {
            throw createPvpError('spectator_read_only', 403);
          }
          runtime.inputByUserKey.set(userKey, normalizeCombatInput(message));
          return;
        }

        if (message.type === 'pvp.match.surrender') {
          const matchContext = getMatchContextForUser(userKey);
          const runtime = matchContext?.runtime || null;
          if (!runtime || runtime.matchId !== String(message.matchId || '')) {
            throw createPvpError('match_not_found', 404);
          }
          if (matchContext.role !== 'player') {
            throw createPvpError('spectator_read_only', 403);
          }
          const outcome = forceCombatForfeit(runtime.state, userKey, 'surrender');
          for (const event of outcome.events || []) {
            emitMatchEvent(runtime, event);
          }
          emitMatchSnapshot(runtime);
          if (runtime.state.status === 'ended') {
            await finishRuntime(runtime, {
              result: runtime.state.result || outcome.result,
              aborted: false
            });
          }
          return;
        }

        peer.send({
          type: 'pvp.error',
          error: 'unsupported_ws_message'
        });
      },
      onClose() {
        const peers = connectionsByUser.get(userKey);
        if (peers && connectionId) {
          peers.delete(connectionId);
          if (!peers.size) {
            connectionsByUser.delete(userKey);
            markPresence(userKey, 'offline');
          }
        }
      },
      onError(error) {
        if (error?.code || error?.message) {
          try {
            peer.send({
              type: 'pvp.error',
              error: error.code || error.message
            });
          } catch {}
        }
      }
    });

    connectionId = randomUUID();
    if (!connectionsByUser.has(userKey)) {
      connectionsByUser.set(userKey, new Map());
    }
    connectionsByUser.get(userKey).set(connectionId, peer);
    markPresence(userKey, 'online');

    const config = await readConfig();
    peer.send({
      type: 'pvp.session.synced',
      ...buildBootstrapPayload({
        userKey,
        wsUrl,
        config
      })
    });

    return peer;
  }

  function closeAll() {
    clearInterval(matchTickTimer);

    for (const runtime of [...liveMatches.values()]) {
      abortRuntime(runtime, 'server_shutdown');
    }

    for (const peers of connectionsByUser.values()) {
      for (const peer of peers.values()) {
        try {
          peer.close(1001, 'server_shutdown');
        } catch {}
      }
    }
    connectionsByUser.clear();
    rooms.clear();
    roomMembershipByUser.clear();
    queueByMode.duel = [];
    queueByMode.deathmatch = [];
    queueEntryByUser.clear();
    liveMatches.clear();
    matchIdByUser.clear();
    spectatorMatchIdByUser.clear();
  }

  return {
    buildBootstrapPayload,
    createRoom,
    joinRoom,
    spectateRoom,
    leaveRoom,
    leaveSpectate,
    setReady,
    startRoom,
    enqueue,
    cancelQueue,
    connectSocket,
    cleanup,
    closeAll,
    getRoomSummaryForUser(userKey) {
      return normalizeRoomSummaryForUser(userKey);
    },
    getQueueSummaryForUser(userKey) {
      return normalizeQueueSummaryForUser(userKey);
    },
    getMatchSummaryForUser(userKey, wsUrl = '') {
      const matchContext = getMatchContextForUser(userKey);
      return matchContext?.runtime ? buildMatchSummaryForUser(matchContext.runtime, userKey, wsUrl) : null;
    }
  };
}
