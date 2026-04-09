import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { createApp } from '../server/app.mjs';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const USERS = {
  alice: {
    code: 'code-alice',
    id: '1001',
    username: 'alice',
    displayName: 'Alice'
  },
  bob: {
    code: 'code-bob',
    id: '1002',
    username: 'bob',
    displayName: 'Bob'
  },
  cathy: {
    code: 'code-cathy',
    id: '1003',
    username: 'cathy',
    displayName: 'Cathy'
  },
  dora: {
    code: 'code-dora',
    id: '1004',
    username: 'dora',
    displayName: 'Dora'
  },
  erin: {
    code: 'code-erin',
    id: '1005',
    username: 'erin',
    displayName: 'Erin'
  },
  frank: {
    code: 'code-frank',
    id: '1006',
    username: 'frank',
    displayName: 'Frank'
  },
  greg: {
    code: 'code-greg',
    id: '1007',
    username: 'greg',
    displayName: 'Greg'
  }
};

function createMockLinuxDoFetch(usersByCode) {
  return async (url, init = {}) => {
    const target = String(url);

    if (target === 'https://connect.linux.do/oauth2/token') {
      const body = init.body instanceof URLSearchParams ? init.body : new URLSearchParams(String(init.body || ''));
      const code = String(body.get('code') || '');
      const user = usersByCode.get(code);
      if (!user) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }

      return Response.json({
        access_token: `token:${code}`
      });
    }

    if (target === 'https://connect.linux.do/api/user') {
      const authorization = String(init.headers?.Authorization || init.headers?.authorization || '');
      const token = authorization.replace(/^Bearer\s+/iu, '');
      const code = token.replace(/^token:/u, '');
      const user = usersByCode.get(code);
      if (!user) {
        return new Response(JSON.stringify({ error: 'invalid_token' }), {
          status: 401,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }

      return Response.json({
        sub: user.id,
        preferred_username: user.username,
        name: user.displayName
      });
    }

    throw new Error(`Unexpected outbound fetch: ${target}`);
  };
}

async function startPvpApp(context, options = {}) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'shooters-pvp-'));
  const dataDir = path.join(tempRoot, 'data');
  let nowMs = Date.UTC(2026, 2, 21, 0, 0, 0);
  const defaultPvpConfig = {
    enabled: true,
    matchmakingEnabled: true,
    rewardEnabled: false,
    maxActiveRooms: 20,
    maxRoomIdleSeconds: 60,
    allowModes: {
      duel: true,
      deathmatch: true
    }
  };
  const usersByCode = new Map(
    Object.values(options.users || USERS).map((user) => [user.code, user])
  );

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
    linuxDo: {
      clientId: 'test-client',
      clientSecret: 'test-secret'
    },
    pvpConfig: {
      ...defaultPvpConfig,
      ...(options.pvpConfig || {}),
      allowModes: {
        ...defaultPvpConfig.allowModes,
        ...(options.pvpConfig?.allowModes || {})
      }
    },
    now: () => nowMs,
    pvpSweepIntervalMs: options.pvpSweepIntervalMs || 250,
    fetchImpl: createMockLinuxDoFetch(usersByCode)
  });

  context.after(async () => {
    await app.close();
  });

  const baseUrl = await app.start();

  return {
    baseUrl,
    dataDir,
    advance(ms) {
      nowMs += ms;
    },
    async wait(ms = 350) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
  };
}

async function loginAs(baseUrl, user) {
  const startResponse = await fetch(`${baseUrl}/auth/linuxdo/start?returnTo=/`, {
    redirect: 'manual'
  });
  assert.equal(startResponse.status, 302);

  const authorizeLocation = startResponse.headers.get('location');
  assert.ok(authorizeLocation);

  const stateToken = new URL(authorizeLocation).searchParams.get('state');
  assert.ok(stateToken);

  const callbackResponse = await fetch(
    `${baseUrl}/auth/linuxdo/callback?code=${encodeURIComponent(user.code)}&state=${encodeURIComponent(stateToken)}`,
    {
      redirect: 'manual'
    }
  );
  assert.equal(callbackResponse.status, 302);

  const cookie = callbackResponse.headers.get('set-cookie');
  assert.ok(cookie);
  return cookie.split(';', 1)[0];
}

async function apiJson(baseUrl, pathname, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');

  if (options.cookie) {
    headers.set('Cookie', options.cookie);
  }

  if (options.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  const payload = await response.json().catch(() => ({}));
  return {
    response,
    payload
  };
}

async function waitForCondition(check, options = {}) {
  const timeoutMs = options.timeoutMs || 4000;
  const intervalMs = options.intervalMs || 100;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const result = await check();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for ${options.label || 'condition'}`);
}

function createClientFrame(opcode, payloadText = '') {
  const payload = Buffer.from(payloadText, 'utf8');
  const maskingKey = randomBytes(4);
  let header;

  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  header[0] = 0x80 | (opcode & 0x0f);

  const maskedPayload = Buffer.from(payload);
  for (let index = 0; index < maskedPayload.length; index += 1) {
    maskedPayload[index] ^= maskingKey[index % 4];
  }

  return Buffer.concat([header, maskingKey, maskedPayload]);
}

function parseFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];
    let payloadLength = secondByte & 0x7f;
    const masked = (secondByte & 0x80) !== 0;
    let cursor = offset + 2;

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

    frames.push({
      opcode: firstByte & 0x0f,
      payload
    });
    offset = cursor + payloadLength;
  }

  return {
    frames,
    remaining: buffer.subarray(offset)
  };
}

class TestWebSocketClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.messages = [];
    this.waiters = [];
    this.closed = false;
    this.closePromise = once(socket, 'close').catch(() => {});

    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      const parsed = parseFrames(this.buffer);
      this.buffer = Buffer.from(parsed.remaining);

      for (const frame of parsed.frames) {
        if (frame.opcode === 0x8) {
          this.closed = true;
          continue;
        }

        if (frame.opcode !== 0x1) {
          continue;
        }

        const message = JSON.parse(frame.payload.toString('utf8'));
        this.pushMessage(message);
      }
    });

    socket.on('close', () => {
      this.closed = true;
      while (this.waiters.length) {
        const waiter = this.waiters.shift();
        clearTimeout(waiter.timer);
        waiter.reject(new Error('socket_closed'));
      }
    });
  }

  static async connect(wsUrl, { cookie }) {
    const url = new URL(wsUrl);
    if (url.protocol !== 'ws:') {
      throw new Error(`Unsupported protocol in test websocket client: ${url.protocol}`);
    }

    const socket = net.createConnection({
      host: url.hostname,
      port: Number(url.port || 80)
    });

    await once(socket, 'connect');

    const key = randomBytes(16).toString('base64');
    const handshake = [
      `GET ${url.pathname}${url.search} HTTP/1.1`,
      `Host: ${url.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${key}`,
      `Cookie: ${cookie}`,
      '\r\n'
    ].join('\r\n');

    socket.write(handshake);

    const { responseText, remaining } = await new Promise((resolve, reject) => {
      let responseBuffer = Buffer.alloc(0);

      const onData = (chunk) => {
        responseBuffer = Buffer.concat([responseBuffer, chunk]);
        const boundary = responseBuffer.indexOf('\r\n\r\n');
        if (boundary < 0) {
          return;
        }

        socket.off('data', onData);
        resolve({
          responseText: responseBuffer.subarray(0, boundary).toString('utf8'),
          remaining: responseBuffer.subarray(boundary + 4)
        });
      };

      socket.on('data', onData);
      socket.once('error', reject);
      socket.once('end', () => reject(new Error('websocket_handshake_ended_early')));
    });

    assert.match(responseText, /^HTTP\/1\.1 101 /u);
    const acceptLine = responseText
      .split('\r\n')
      .find((line) => line.toLowerCase().startsWith('sec-websocket-accept:'));
    assert.ok(acceptLine);

    const expectedAccept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    assert.equal(acceptLine.split(':', 2)[1].trim(), expectedAccept);

    const client = new TestWebSocketClient(socket);
    if (remaining.length) {
      client.socket.emit('data', remaining);
    }
    return client;
  }

  pushMessage(message) {
    const waiterIndex = this.waiters.findIndex((waiter) => {
      try {
        return waiter.predicate(message);
      } catch {
        return false;
      }
    });

    if (waiterIndex >= 0) {
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }

    this.messages.push(message);
  }

  waitFor(predicate, timeoutMs = 2500, label = 'message') {
    const existingIndex = this.messages.findIndex((message) => {
      try {
        return predicate(message);
      } catch {
        return false;
      }
    });

    if (existingIndex >= 0) {
      return Promise.resolve(this.messages.splice(existingIndex, 1)[0]);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((entry) => entry !== waiter);
        reject(new Error(`Timed out waiting for ${label}`));
      }, timeoutMs);

      const waiter = {
        predicate,
        resolve,
        reject,
        timer
      };

      this.waiters.push(waiter);
    });
  }

  waitForType(type, predicate = () => true, timeoutMs = 2500) {
    return this.waitFor(
      (message) => message?.type === type && predicate(message),
      timeoutMs,
      type
    );
  }

  sendJson(payload) {
    this.socket.write(createClientFrame(0x1, JSON.stringify(payload)));
  }

  async close() {
    if (this.closed) {
      return;
    }

    try {
      this.socket.write(createClientFrame(0x8));
      this.socket.end();
    } catch {
      this.socket.destroy();
    }

    await Promise.race([
      this.closePromise,
      new Promise((resolve) => setTimeout(resolve, 300))
    ]);

    if (!this.socket.destroyed) {
      this.socket.destroy();
    }
  }
}

test('PVP bootstrap rejects unauthenticated users and disabled beta blocks room creation', async (context) => {
  const { baseUrl } = await startPvpApp(context, {
    pvpConfig: {
      enabled: false,
      matchmakingEnabled: false
    }
  });

  const anonymousBootstrap = await fetch(`${baseUrl}/api/pvp/bootstrap`);
  assert.equal(anonymousBootstrap.status, 401);

  const aliceCookie = await loginAs(baseUrl, USERS.alice);

  const sessionResult = await apiJson(baseUrl, '/api/auth/session', {
    cookie: aliceCookie
  });
  assert.equal(sessionResult.response.status, 200);
  assert.equal(sessionResult.payload.pvpConfig.enabled, false);
  assert.equal(sessionResult.payload.pvpConfig.matchmakingEnabled, false);

  const bootstrapResult = await apiJson(baseUrl, '/api/pvp/bootstrap', {
    cookie: aliceCookie
  });
  assert.equal(bootstrapResult.response.status, 200);
  assert.equal(bootstrapResult.payload.config.enabled, false);
  assert.equal(bootstrapResult.payload.config.matchmakingEnabled, false);
  assert.match(bootstrapResult.payload.wsUrl, /^ws:\/\//u);

  const createRoomResult = await apiJson(baseUrl, '/api/pvp/rooms', {
    method: 'POST',
    cookie: aliceCookie,
    body: {
      mode: 'duel'
    }
  });
  assert.equal(createRoomResult.response.status, 403);
  assert.equal(createRoomResult.payload.error, 'pvp_disabled');
});

test('private duel room starts a live match on the selected map and authoritative snapshots react to client input', async (context) => {
  const { baseUrl } = await startPvpApp(context);
  const aliceCookie = await loginAs(baseUrl, USERS.alice);
  const bobCookie = await loginAs(baseUrl, USERS.bob);

  const aliceBootstrap = await apiJson(baseUrl, '/api/pvp/bootstrap', {
    cookie: aliceCookie
  });
  const bobBootstrap = await apiJson(baseUrl, '/api/pvp/bootstrap', {
    cookie: bobCookie
  });

  const aliceWs = await TestWebSocketClient.connect(aliceBootstrap.payload.wsUrl, {
    cookie: aliceCookie
  });
  const bobWs = await TestWebSocketClient.connect(bobBootstrap.payload.wsUrl, {
    cookie: bobCookie
  });

  context.after(async () => {
    await aliceWs.close();
    await bobWs.close();
  });

  await aliceWs.waitForType('pvp.session.synced');
  await bobWs.waitForType('pvp.session.synced');

  const createRoomResult = await apiJson(baseUrl, '/api/pvp/rooms', {
    method: 'POST',
    cookie: aliceCookie,
    body: {
      mode: 'duel',
      mapSelection: 'crossfire'
    }
  });
  assert.equal(createRoomResult.response.status, 200);
  assert.equal(createRoomResult.payload.room.mode, 'duel');
  assert.equal(createRoomResult.payload.room.mapSelection, 'crossfire');

  const roomCode = createRoomResult.payload.room.roomCode;
  assert.ok(roomCode);

  const aliceRoomCreated = await aliceWs.waitForType(
    'pvp.room.updated',
    (message) => message.room?.roomCode === roomCode && message.room?.members?.length === 1
  );
  assert.equal(aliceRoomCreated.room.hostUser.username, 'alice');

  const joinRoomResult = await apiJson(baseUrl, '/api/pvp/rooms/join', {
    method: 'POST',
    cookie: bobCookie,
    body: {
      roomCode
    }
  });
  assert.equal(joinRoomResult.response.status, 200);
  assert.equal(joinRoomResult.payload.room.members.length, 2);

  const aliceSawBobJoin = await aliceWs.waitForType(
    'pvp.room.updated',
    (message) => message.room?.roomCode === roomCode && message.room?.members?.length === 2
  );
  const bobSawRoom = await bobWs.waitForType(
    'pvp.room.updated',
    (message) => message.room?.roomCode === roomCode && message.room?.members?.length === 2
  );
  assert.equal(aliceSawBobJoin.room.capacity, 2);
  assert.equal(bobSawRoom.room.capacity, 2);

  const aliceReadyResult = await apiJson(baseUrl, '/api/pvp/rooms/ready', {
    method: 'POST',
    cookie: aliceCookie,
    body: {
      ready: true
    }
  });
  assert.equal(aliceReadyResult.response.status, 200);
  assert.equal(
    aliceReadyResult.payload.room.members.find((member) => member.username === 'alice')?.isReady,
    true
  );

  const aliceReadyUpdate = await aliceWs.waitForType(
    'pvp.room.updated',
    (message) =>
      message.room?.roomCode === roomCode &&
      message.room?.members?.find((member) => member.username === 'alice')?.isReady === true
  );
  const bobSawAliceReady = await bobWs.waitForType(
    'pvp.room.updated',
    (message) =>
      message.room?.roomCode === roomCode &&
      message.room?.members?.find((member) => member.username === 'alice')?.isReady === true
  );
  assert.equal(aliceReadyUpdate.room.canStart, false);
  assert.equal(bobSawAliceReady.room.canStart, false);

  const startTooEarlyResult = await apiJson(baseUrl, '/api/pvp/rooms/start', {
    method: 'POST',
    cookie: aliceCookie
  });
  assert.equal(startTooEarlyResult.response.status, 409);
  assert.equal(startTooEarlyResult.payload.error, 'room_not_ready');

  bobWs.sendJson({
    type: 'pvp.room.ready',
    ready: true
  });

  const roomReadyForHost = await aliceWs.waitForType(
    'pvp.room.updated',
    (message) => message.room?.roomCode === roomCode && message.room?.canStart === true
  );
  const roomReadyForGuest = await bobWs.waitForType(
    'pvp.room.updated',
    (message) => message.room?.roomCode === roomCode && message.room?.canStart === true
  );
  assert.equal(roomReadyForHost.room.status, 'ready');
  assert.equal(roomReadyForGuest.room.status, 'ready');

  const guestStartResult = await apiJson(baseUrl, '/api/pvp/rooms/start', {
    method: 'POST',
    cookie: bobCookie
  });
  assert.equal(guestStartResult.response.status, 403);
  assert.equal(guestStartResult.payload.error, 'not_room_host');

  const hostStartResult = await apiJson(baseUrl, '/api/pvp/rooms/start', {
    method: 'POST',
    cookie: aliceCookie
  });
  assert.equal(hostStartResult.response.status, 200);
  assert.equal(hostStartResult.payload.match.mode, 'duel');
  assert.equal(hostStartResult.payload.match.mapId, 'crossfire');
  assert.match(hostStartResult.payload.match.matchId, /^[0-9a-f-]{36}$/u);

  const aliceStarting = await aliceWs.waitForType(
    'pvp.room.starting',
    (message) => message.room?.roomCode === roomCode
  );
  const bobStarting = await bobWs.waitForType(
    'pvp.room.starting',
    (message) => message.room?.roomCode === roomCode
  );
  assert.equal(aliceStarting.room.status, 'starting');
  assert.equal(bobStarting.room.status, 'starting');

  const aliceMatchStarted = await aliceWs.waitForType(
    'pvp.match.started',
    (message) => message.mode === 'duel'
  );
  const bobMatchStarted = await bobWs.waitForType(
    'pvp.match.started',
    (message) => message.mode === 'duel'
  );
  assert.equal(aliceMatchStarted.matchId, bobMatchStarted.matchId);
  assert.equal(aliceMatchStarted.snapshot.players.length, 2);
  assert.equal(bobMatchStarted.snapshot.players.length, 2);
  assert.equal(aliceMatchStarted.mapId, 'crossfire');
  assert.equal(aliceMatchStarted.snapshot.mapId, 'crossfire');
  assert.equal(aliceMatchStarted.team, 'p1');
  assert.equal(bobMatchStarted.team, 'p2');

  aliceWs.sendJson({
    type: 'pvp.match.subscribe',
    matchId: aliceMatchStarted.matchId
  });
  bobWs.sendJson({
    type: 'pvp.match.subscribe',
    matchId: bobMatchStarted.matchId
  });

  const aliceSnapshot = await aliceWs.waitForType(
    'pvp.match.snapshot',
    (message) => message.matchId === aliceMatchStarted.matchId
  );
  await bobWs.waitForType(
    'pvp.match.snapshot',
    (message) => message.matchId === bobMatchStarted.matchId
  );

  const aliceBeforeMove = aliceSnapshot.players.find((player) => player.team === 'p1');
  assert.ok(aliceBeforeMove);
  assert.equal(aliceSnapshot.mapId, 'crossfire');

  aliceWs.sendJson({
    type: 'pvp.match.input',
    matchId: aliceMatchStarted.matchId,
    inputSeq: 1,
    moveX: 1,
    moveY: 0,
    aimYaw: 0,
    fire: false,
    reload: false,
    dash: false,
    weaponId: 'pistol'
  });

  const movedSnapshot = await aliceWs.waitForType(
    'pvp.match.snapshot',
    (message) =>
      message.matchId === aliceMatchStarted.matchId &&
      message.players.find((player) => player.team === 'p1')?.x > aliceBeforeMove.x + 0.05
  );
  assert.ok(movedSnapshot.players.find((player) => player.team === 'p1')?.x > aliceBeforeMove.x);

  const repeatStartResult = await apiJson(baseUrl, '/api/pvp/rooms/start', {
    method: 'POST',
    cookie: aliceCookie
  });
  assert.equal(repeatStartResult.response.status, 409);
  assert.equal(repeatStartResult.payload.error, 'room_already_started');
});

test('winning MVP can claim a PVP CDK when authoritative PVP rewards are enabled', async (context) => {
  const { baseUrl } = await startPvpApp(context, {
    pvpConfig: {
      enabled: true,
      matchmakingEnabled: true,
      rewardEnabled: true
    }
  });
  const aliceCookie = await loginAs(baseUrl, USERS.alice);
  const bobCookie = await loginAs(baseUrl, USERS.bob);

  const importPvpCodesResult = await apiJson(baseUrl, '/api/admin/cdks', {
    method: 'POST',
    cookie: aliceCookie,
    body: {
      pool: 'pvp',
      bulkText: 'PVP111',
      note: 'seed pvp reward'
    }
  });
  assert.equal(importPvpCodesResult.response.status, 200);
  assert.equal(importPvpCodesResult.payload.addedCount, 1);

  const aliceBootstrap = await apiJson(baseUrl, '/api/pvp/bootstrap', {
    cookie: aliceCookie
  });
  const bobBootstrap = await apiJson(baseUrl, '/api/pvp/bootstrap', {
    cookie: bobCookie
  });

  const aliceWs = await TestWebSocketClient.connect(aliceBootstrap.payload.wsUrl, {
    cookie: aliceCookie
  });
  const bobWs = await TestWebSocketClient.connect(bobBootstrap.payload.wsUrl, {
    cookie: bobCookie
  });

  context.after(async () => {
    await aliceWs.close();
    await bobWs.close();
  });

  await aliceWs.waitForType('pvp.session.synced');
  await bobWs.waitForType('pvp.session.synced');

  const createRoomResult = await apiJson(baseUrl, '/api/pvp/rooms', {
    method: 'POST',
    cookie: aliceCookie,
    body: {
      mode: 'duel'
    }
  });
  assert.equal(createRoomResult.response.status, 200);
  const roomCode = createRoomResult.payload.room.roomCode;
  assert.ok(roomCode);

  await aliceWs.waitForType(
    'pvp.room.updated',
    (message) => message.room?.roomCode === roomCode && message.room?.members?.length === 1
  );

  const joinRoomResult = await apiJson(baseUrl, '/api/pvp/rooms/join', {
    method: 'POST',
    cookie: bobCookie,
    body: {
      roomCode
    }
  });
  assert.equal(joinRoomResult.response.status, 200);

  await aliceWs.waitForType(
    'pvp.room.updated',
    (message) => message.room?.roomCode === roomCode && message.room?.members?.length === 2
  );
  await bobWs.waitForType(
    'pvp.room.updated',
    (message) => message.room?.roomCode === roomCode && message.room?.members?.length === 2
  );

  await apiJson(baseUrl, '/api/pvp/rooms/ready', {
    method: 'POST',
    cookie: aliceCookie,
    body: {
      ready: true
    }
  });
  await aliceWs.waitForType(
    'pvp.room.updated',
    (message) =>
      message.room?.roomCode === roomCode &&
      message.room?.members?.find((member) => member.username === 'alice')?.isReady === true
  );

  bobWs.sendJson({
    type: 'pvp.room.ready',
    ready: true
  });

  await aliceWs.waitForType(
    'pvp.room.updated',
    (message) => message.room?.roomCode === roomCode && message.room?.canStart === true
  );
  await bobWs.waitForType(
    'pvp.room.updated',
    (message) => message.room?.roomCode === roomCode && message.room?.canStart === true
  );

  const hostStartResult = await apiJson(baseUrl, '/api/pvp/rooms/start', {
    method: 'POST',
    cookie: aliceCookie
  });
  assert.equal(hostStartResult.response.status, 200);

  const aliceStarted = await aliceWs.waitForType(
    'pvp.match.started',
    (message) => message.mode === 'duel'
  );
  const bobStarted = await bobWs.waitForType(
    'pvp.match.started',
    (message) => message.matchId === aliceStarted.matchId
  );
  assert.equal(aliceStarted.matchId, bobStarted.matchId);

  aliceWs.sendJson({
    type: 'pvp.match.subscribe',
    matchId: aliceStarted.matchId
  });
  bobWs.sendJson({
    type: 'pvp.match.subscribe',
    matchId: bobStarted.matchId
  });

  await aliceWs.waitForType(
    'pvp.match.snapshot',
    (message) => message.matchId === aliceStarted.matchId
  );
  await bobWs.waitForType(
    'pvp.match.snapshot',
    (message) => message.matchId === bobStarted.matchId
  );

  bobWs.sendJson({
    type: 'pvp.match.surrender',
    matchId: bobStarted.matchId
  });

  const aliceEnded = await aliceWs.waitForType(
    'pvp.match.ended',
    (message) => message.matchId === aliceStarted.matchId
  );
  const bobEnded = await bobWs.waitForType(
    'pvp.match.ended',
    (message) => message.matchId === bobStarted.matchId
  );
  assert.equal(aliceEnded.result.winnerTeam, aliceStarted.team);
  assert.equal(bobEnded.result.winnerTeam, aliceStarted.team);

  const aliceRewards = await waitForCondition(
    async () => {
      const result = await apiJson(baseUrl, '/api/cdks/me', {
        cookie: aliceCookie
      });
      return result.payload.pendingAward?.summary?.rewardPool === 'pvp' ? result : null;
    },
    {
      label: 'alice pvp pending award'
    }
  );
  assert.equal(aliceRewards.payload.pendingAward.summary.rewardPool, 'pvp');
  assert.equal(aliceRewards.payload.pendingAward.summary.codePool, 'pvp_duel');
  assert.equal(aliceRewards.payload.pendingAward.summary.playerWon, true);
  assert.equal(aliceRewards.payload.pendingAward.summary.playerIsMvp, true);
  assert.equal(aliceRewards.payload.pendingPool, 'pvp');
  assert.equal(aliceRewards.payload.pendingCodePool, 'pvp_duel');

  const bobRewards = await apiJson(baseUrl, '/api/cdks/me', {
    cookie: bobCookie
  });
  assert.equal(bobRewards.response.status, 200);
  assert.equal(bobRewards.payload.pendingAward, null);

  const aliceClaim = await apiJson(baseUrl, '/api/cdks/claim', {
    method: 'POST',
    cookie: aliceCookie
  });
  assert.equal(aliceClaim.response.status, 200);
  assert.equal(aliceClaim.payload.newlyClaimed, true);
  assert.equal(aliceClaim.payload.rewardPool, 'pvp');
  assert.equal(aliceClaim.payload.codePool, 'pvp');
  assert.equal(aliceClaim.payload.assignedCdk.pool, 'pvp');
  assert.equal(aliceClaim.payload.assignedCdk.code, 'PVP111');
});

test('42 cup event only ranks signed-up players within the activity window', async (context) => {
  const { baseUrl, advance } = await startPvpApp(context, {
    pvpConfig: {
      enabled: true,
      matchmakingEnabled: true,
      rewardEnabled: false,
      replay: {
        enabled: true,
        maxStoredMatches: 5,
        compressOnComplete: true,
        modes: {
          duel: true,
          deathmatch: false
        }
      }
    }
  });
  const aliceCookie = await loginAs(baseUrl, USERS.alice);
  const bobCookie = await loginAs(baseUrl, USERS.bob);

  const saveEventResult = await apiJson(baseUrl, '/api/admin/pvp-event', {
    method: 'POST',
    cookie: aliceCookie,
    body: {
      enabled: true,
      title: '42杯',
      slug: '42-cup-s1',
      description: '报名后参加的限时 PVP 活动',
      signupStartsAt: '2026-03-21T00:00:00.000Z',
      startsAt: '2026-03-21T00:30:00.000Z',
      endsAt: '2026-03-21T02:00:00.000Z'
    }
  });
  assert.equal(saveEventResult.response.status, 200);
  assert.equal(saveEventResult.payload.pvpEvent.title, '42杯');
  assert.equal(saveEventResult.payload.pvpEvent.phase, 'signup');

  const bobSignupResult = await apiJson(baseUrl, '/api/pvp/event/signup', {
    method: 'POST',
    cookie: bobCookie
  });
  assert.equal(bobSignupResult.response.status, 200);
  assert.equal(bobSignupResult.payload.signedUp, true);
  assert.equal(bobSignupResult.payload.event.signedUp, true);

  advance(31 * 60 * 1000);

  const lateSignupResult = await apiJson(baseUrl, '/api/pvp/event/signup', {
    method: 'POST',
    cookie: aliceCookie
  });
  assert.equal(lateSignupResult.response.status, 200);
  assert.equal(lateSignupResult.payload.signedUp, true);
  assert.equal(lateSignupResult.payload.event.phase, 'live');

  const bobBootstrap = await apiJson(baseUrl, '/api/pvp/bootstrap', {
    cookie: bobCookie
  });
  const aliceBootstrap = await apiJson(baseUrl, '/api/pvp/bootstrap', {
    cookie: aliceCookie
  });

  const bobWs = await TestWebSocketClient.connect(bobBootstrap.payload.wsUrl, {
    cookie: bobCookie
  });
  const aliceWs = await TestWebSocketClient.connect(aliceBootstrap.payload.wsUrl, {
    cookie: aliceCookie
  });

  context.after(async () => {
    await bobWs.close();
    await aliceWs.close();
  });

  await bobWs.waitForType('pvp.session.synced');
  await aliceWs.waitForType('pvp.session.synced');

  const createRoomResult = await apiJson(baseUrl, '/api/pvp/rooms', {
    method: 'POST',
    cookie: bobCookie,
    body: {
      mode: 'duel'
    }
  });
  assert.equal(createRoomResult.response.status, 200);
  const roomCode = createRoomResult.payload.room.roomCode;
  assert.ok(roomCode);

  await bobWs.waitForType(
    'pvp.room.updated',
    (message) => message.room?.roomCode === roomCode && message.room?.members?.length === 1
  );

  const joinRoomResult = await apiJson(baseUrl, '/api/pvp/rooms/join', {
    method: 'POST',
    cookie: aliceCookie,
    body: {
      roomCode
    }
  });
  assert.equal(joinRoomResult.response.status, 200);

  await bobWs.waitForType(
    'pvp.room.updated',
    (message) => message.room?.roomCode === roomCode && message.room?.members?.length === 2
  );
  await aliceWs.waitForType(
    'pvp.room.updated',
    (message) => message.room?.roomCode === roomCode && message.room?.members?.length === 2
  );

  await apiJson(baseUrl, '/api/pvp/rooms/ready', {
    method: 'POST',
    cookie: bobCookie,
    body: {
      ready: true
    }
  });
  await apiJson(baseUrl, '/api/pvp/rooms/ready', {
    method: 'POST',
    cookie: aliceCookie,
    body: {
      ready: true
    }
  });

  const startRoomResult = await apiJson(baseUrl, '/api/pvp/rooms/start', {
    method: 'POST',
    cookie: bobCookie
  });
  assert.equal(startRoomResult.response.status, 200);
  const matchId = startRoomResult.payload.match.matchId;

  await bobWs.waitForType('pvp.match.started', (message) => message.matchId === matchId);
  await aliceWs.waitForType('pvp.match.started', (message) => message.matchId === matchId);
  await bobWs.waitForType('pvp.match.snapshot', (message) => message.matchId === matchId);
  await aliceWs.waitForType('pvp.match.snapshot', (message) => message.matchId === matchId);

  aliceWs.sendJson({
    type: 'pvp.match.surrender',
    matchId
  });

  await bobWs.waitForType('pvp.match.ended', (message) => message.matchId === matchId);
  await aliceWs.waitForType('pvp.match.ended', (message) => message.matchId === matchId);

  const bobEventResult = await waitForCondition(
    async () => {
      const result = await apiJson(baseUrl, '/api/pvp/event', {
        cookie: bobCookie
      });
      return result.payload.currentUser?.event?.matchesPlayed === 1 ? result : null;
    },
    {
      label: '42 cup leaderboard update'
    }
  );

  assert.equal(bobEventResult.response.status, 200);
  assert.equal(bobEventResult.payload.event.phase, 'live');
  assert.equal(bobEventResult.payload.event.signedUp, true);
  assert.equal(bobEventResult.payload.event.scoring.leaderboardMinMatches, 8);
  assert.equal(bobEventResult.payload.leaderboards.event.length, 0);
  assert.equal(bobEventResult.payload.leaderboards.global.length, 0);
  assert.equal(bobEventResult.payload.currentUser.event?.score, 16);
  assert.equal(bobEventResult.payload.currentUser.event?.qualified, false);
  assert.equal(bobEventResult.payload.currentUser.event?.matchesNeeded, 7);
  assert.equal(bobEventResult.payload.currentUser.global?.score, 16);

  const aliceEventResult = await apiJson(baseUrl, '/api/pvp/event', {
    cookie: aliceCookie
  });
  assert.equal(aliceEventResult.response.status, 200);
  assert.equal(aliceEventResult.payload.event.signedUp, true);
  assert.equal(aliceEventResult.payload.currentUser.signedUp, true);
  assert.equal(aliceEventResult.payload.leaderboards.event.length, 0);
  assert.equal(aliceEventResult.payload.leaderboards.global.length, 0);
  assert.equal(aliceEventResult.payload.currentUser.event?.score, -10);
  assert.equal(aliceEventResult.payload.currentUser.global?.score, -10);
  assert.equal(aliceEventResult.payload.currentUser.global?.qualified, false);
  assert.equal(aliceEventResult.payload.currentUser.global?.matchesNeeded, 7);

  await waitForCondition(
    async () => {
      const result = await apiJson(baseUrl, `/api/pvp/replays/${matchId}/content`, {
        cookie: bobCookie
      });
      return result.response.status === 200 ? result : null;
    },
    {
      label: '42 cup replay content'
    }
  ).then((result) => {
    assert.equal(result.payload.content.replay.matchId, matchId);
    assert.equal(result.payload.eventPanel.enabled, true);
    const bobPanel = result.payload.eventPanel.participants.find((item) => item.user?.username === 'bob');
    const alicePanel = result.payload.eventPanel.participants.find((item) => item.user?.username === 'alice');
    assert.equal(bobPanel?.counted, true);
    assert.equal(bobPanel?.reason, 'counted');
    assert.equal(bobPanel?.scoreDelta, 16);
    assert.equal(alicePanel?.counted, true);
    assert.equal(alicePanel?.reason, 'counted');
    assert.equal(alicePanel?.scoreDelta, -10);
  });
});

test('spectators can join a live room by room code, receive live updates, and stay read-only', async (context) => {
  const { baseUrl } = await startPvpApp(context);
  const aliceCookie = await loginAs(baseUrl, USERS.alice);
  const bobCookie = await loginAs(baseUrl, USERS.bob);
  const gregCookie = await loginAs(baseUrl, USERS.greg);

  const aliceBootstrap = await apiJson(baseUrl, '/api/pvp/bootstrap', {
    cookie: aliceCookie
  });
  const bobBootstrap = await apiJson(baseUrl, '/api/pvp/bootstrap', {
    cookie: bobCookie
  });
  const gregBootstrap = await apiJson(baseUrl, '/api/pvp/bootstrap', {
    cookie: gregCookie
  });

  const aliceWs = await TestWebSocketClient.connect(aliceBootstrap.payload.wsUrl, {
    cookie: aliceCookie
  });
  const bobWs = await TestWebSocketClient.connect(bobBootstrap.payload.wsUrl, {
    cookie: bobCookie
  });
  const gregWs = await TestWebSocketClient.connect(gregBootstrap.payload.wsUrl, {
    cookie: gregCookie
  });

  context.after(async () => {
    await aliceWs.close();
    await bobWs.close();
    await gregWs.close();
  });

  await aliceWs.waitForType('pvp.session.synced');
  await bobWs.waitForType('pvp.session.synced');
  await gregWs.waitForType('pvp.session.synced');

  const createRoomResult = await apiJson(baseUrl, '/api/pvp/rooms', {
    method: 'POST',
    cookie: aliceCookie,
    body: {
      mode: 'duel'
    }
  });
  assert.equal(createRoomResult.response.status, 200);

  const roomCode = createRoomResult.payload.room.roomCode;
  assert.ok(roomCode);

  const joinRoomResult = await apiJson(baseUrl, '/api/pvp/rooms/join', {
    method: 'POST',
    cookie: bobCookie,
    body: {
      roomCode
    }
  });
  assert.equal(joinRoomResult.response.status, 200);

  await apiJson(baseUrl, '/api/pvp/rooms/ready', {
    method: 'POST',
    cookie: aliceCookie,
    body: {
      ready: true
    }
  });
  await apiJson(baseUrl, '/api/pvp/rooms/ready', {
    method: 'POST',
    cookie: bobCookie,
    body: {
      ready: true
    }
  });

  const startRoomResult = await apiJson(baseUrl, '/api/pvp/rooms/start', {
    method: 'POST',
    cookie: aliceCookie
  });
  assert.equal(startRoomResult.response.status, 200);
  const matchId = startRoomResult.payload.match.matchId;

  await aliceWs.waitForType('pvp.match.started', (message) => message.matchId === matchId);
  await bobWs.waitForType('pvp.match.started', (message) => message.matchId === matchId);

  const spectateResult = await apiJson(baseUrl, '/api/pvp/rooms/spectate', {
    method: 'POST',
    cookie: gregCookie,
    body: {
      roomCode
    }
  });
  assert.equal(spectateResult.response.status, 200);
  assert.equal(spectateResult.payload.match.role, 'spectator');
  assert.equal(spectateResult.payload.match.matchId, matchId);

  const gregSynced = await gregWs.waitForType(
    'pvp.session.synced',
    (message) => message.currentMatch?.matchId === matchId && message.currentMatch?.role === 'spectator'
  );
  assert.equal(gregSynced.currentRoom, null);
  assert.equal(gregSynced.currentQueue, null);

  gregWs.sendJson({
    type: 'pvp.match.subscribe',
    matchId
  });

  const gregStarted = await gregWs.waitForType(
    'pvp.match.started',
    (message) => message.matchId === matchId && message.role === 'spectator'
  );
  assert.equal(gregStarted.snapshot.players.length, 2);
  assert.equal(gregStarted.team, null);
  assert.equal(gregStarted.seat, null);

  const gregSnapshot = await gregWs.waitForType(
    'pvp.match.snapshot',
    (message) => message.matchId === matchId && message.players?.length === 2
  );
  assert.equal(gregSnapshot.spectatorCount, 1);

  gregWs.sendJson({
    type: 'pvp.match.input',
    matchId,
    inputSeq: 1,
    moveX: 1,
    moveY: 0,
    aimYaw: 0,
    fire: true,
    reload: false,
    dash: false,
    weaponId: 'pistol'
  });
  const gregInputRejected = await gregWs.waitForType(
    'pvp.error',
    (message) => message.error === 'spectator_read_only'
  );
  assert.equal(gregInputRejected.error, 'spectator_read_only');

  const leaveSpectateResult = await apiJson(baseUrl, '/api/pvp/matches/leave-spectate', {
    method: 'POST',
    cookie: gregCookie
  });
  assert.equal(leaveSpectateResult.response.status, 200);
  assert.equal(leaveSpectateResult.payload.match, null);

  const gregBootstrapAfterLeave = await apiJson(baseUrl, '/api/pvp/bootstrap', {
    cookie: gregCookie
  });
  assert.equal(gregBootstrapAfterLeave.response.status, 200);
  assert.equal(gregBootstrapAfterLeave.payload.currentMatch, null);
  assert.equal(gregBootstrapAfterLeave.payload.currentRoom, null);
});

test('private deathmatch rooms start a live 4-player match and surrender only removes that player', async (context) => {
  const { baseUrl } = await startPvpApp(context);
  const users = [USERS.cathy, USERS.dora, USERS.erin, USERS.frank];
  const cookies = new Map();
  const clients = [];

  for (const user of users) {
    cookies.set(user.username, await loginAs(baseUrl, user));
  }

  const bootstraps = new Map();
  for (const user of users) {
    const bootstrap = await apiJson(baseUrl, '/api/pvp/bootstrap', {
      cookie: cookies.get(user.username)
    });
    bootstraps.set(user.username, bootstrap.payload);
  }

  for (const user of users) {
    const client = await TestWebSocketClient.connect(bootstraps.get(user.username).wsUrl, {
      cookie: cookies.get(user.username)
    });
    clients.push(client);
  }

  context.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
  });

  await Promise.all(clients.map((client) => client.waitForType('pvp.session.synced')));

  const createRoomResult = await apiJson(baseUrl, '/api/pvp/rooms', {
    method: 'POST',
    cookie: cookies.get('cathy'),
    body: {
      mode: 'deathmatch'
    }
  });
  assert.equal(createRoomResult.response.status, 200);
  assert.equal(createRoomResult.payload.room.mode, 'deathmatch');
  assert.equal(createRoomResult.payload.room.capacity, 4);

  const roomCode = createRoomResult.payload.room.roomCode;
  assert.ok(roomCode);

  for (const user of users.slice(1)) {
    const joinRoomResult = await apiJson(baseUrl, '/api/pvp/rooms/join', {
      method: 'POST',
      cookie: cookies.get(user.username),
      body: {
        roomCode
      }
    });
    assert.equal(joinRoomResult.response.status, 200);
  }

  for (const user of users) {
    const readyResult = await apiJson(baseUrl, '/api/pvp/rooms/ready', {
      method: 'POST',
      cookie: cookies.get(user.username),
      body: {
        ready: true
      }
    });
    assert.equal(readyResult.response.status, 200);
  }

  const hostReadyRoom = await waitForCondition(
    async () => {
      const result = await apiJson(baseUrl, '/api/pvp/bootstrap', {
        cookie: cookies.get('cathy')
      });
      return result.payload.currentRoom?.canStart ? result.payload.currentRoom : null;
    },
    {
      label: 'deathmatch room ready'
    }
  );
  assert.equal(hostReadyRoom.mode, 'deathmatch');
  assert.equal(hostReadyRoom.members.length, 4);
  assert.equal(hostReadyRoom.canStart, true);

  const hostStartResult = await apiJson(baseUrl, '/api/pvp/rooms/start', {
    method: 'POST',
    cookie: cookies.get('cathy')
  });
  assert.equal(hostStartResult.response.status, 200);
  assert.equal(hostStartResult.payload.match.mode, 'deathmatch');

  const startedMessages = await Promise.all(
    clients.map((client) => client.waitForType('pvp.match.started', (message) => message.mode === 'deathmatch'))
  );
  const matchId = startedMessages[0].matchId;
  const teams = new Set(startedMessages.map((message) => message.team));
  assert.equal(teams.size, 4);
  for (const message of startedMessages) {
    assert.equal(message.matchId, matchId);
    assert.equal(message.snapshot.players.length, 4);
  }

  clients.forEach((client) => {
    client.sendJson({
      type: 'pvp.match.subscribe',
      matchId
    });
  });

  const snapshotAfterSubscribe = await clients[0].waitForType(
    'pvp.match.snapshot',
    (message) => message.matchId === matchId && message.players?.length === 4
  );
  assert.equal(snapshotAfterSubscribe.mode, 'deathmatch');

  const frankClient = clients[3];
  const frankStarted = startedMessages[3];
  frankClient.sendJson({
    type: 'pvp.match.surrender',
    matchId
  });

  const postSurrenderSnapshot = await clients[0].waitForType(
    'pvp.match.snapshot',
    (message) => {
      if (message.matchId !== matchId || message.status !== 'active') {
        return false;
      }
      const surrenderedPlayer = message.players?.find((player) => player.team === frankStarted.team);
      return Boolean(surrenderedPlayer?.eliminated && surrenderedPlayer?.lives === 0);
    }
  );

  const surrenderedPlayer = postSurrenderSnapshot.players.find((player) => player.team === frankStarted.team);
  assert.ok(surrenderedPlayer);
  assert.equal(surrenderedPlayer.eliminated, true);
  assert.equal(surrenderedPlayer.lives, 0);
  assert.equal(
    postSurrenderSnapshot.players.filter((player) => !player.eliminated).length,
    3
  );
});

test('deathmatch replay recording persists replay metadata and artifact files when enabled', async (context) => {
  const { baseUrl, dataDir } = await startPvpApp(context, {
    pvpConfig: {
      replay: {
        enabled: true,
        maxStoredMatches: 5,
        compressOnComplete: true,
        modes: {
          duel: false,
          deathmatch: true
        }
      }
    }
  });
  const aliceCookie = await loginAs(baseUrl, USERS.alice);
  const bobCookie = await loginAs(baseUrl, USERS.bob);
  const users = [USERS.cathy, USERS.dora, USERS.erin, USERS.frank];
  const cookies = new Map();
  const clients = [];

  for (const user of users) {
    cookies.set(user.username, await loginAs(baseUrl, user));
  }

  const bootstraps = new Map();
  for (const user of users) {
    const bootstrap = await apiJson(baseUrl, '/api/pvp/bootstrap', {
      cookie: cookies.get(user.username)
    });
    bootstraps.set(user.username, bootstrap.payload);
  }

  for (const user of users) {
    const client = await TestWebSocketClient.connect(bootstraps.get(user.username).wsUrl, {
      cookie: cookies.get(user.username)
    });
    clients.push(client);
  }

  context.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
  });

  await Promise.all(clients.map((client) => client.waitForType('pvp.session.synced')));

  const createRoomResult = await apiJson(baseUrl, '/api/pvp/rooms', {
    method: 'POST',
    cookie: cookies.get('cathy'),
    body: {
      mode: 'deathmatch'
    }
  });
  assert.equal(createRoomResult.response.status, 200);

  const roomCode = createRoomResult.payload.room.roomCode;
  assert.ok(roomCode);

  for (const user of users.slice(1)) {
    const joinRoomResult = await apiJson(baseUrl, '/api/pvp/rooms/join', {
      method: 'POST',
      cookie: cookies.get(user.username),
      body: {
        roomCode
      }
    });
    assert.equal(joinRoomResult.response.status, 200);
  }

  for (const user of users) {
    const readyResult = await apiJson(baseUrl, '/api/pvp/rooms/ready', {
      method: 'POST',
      cookie: cookies.get(user.username),
      body: {
        ready: true
      }
    });
    assert.equal(readyResult.response.status, 200);
  }

  const startResult = await apiJson(baseUrl, '/api/pvp/rooms/start', {
    method: 'POST',
    cookie: cookies.get('cathy')
  });
  assert.equal(startResult.response.status, 200);
  assert.equal(startResult.payload.match.mode, 'deathmatch');

  const startedMessages = await Promise.all(
    clients.map((client) => client.waitForType('pvp.match.started', (message) => message.mode === 'deathmatch'))
  );
  const matchId = startedMessages[0].matchId;

  clients.forEach((client) => {
    client.sendJson({
      type: 'pvp.match.subscribe',
      matchId
    });
  });

  await clients[0].waitForType(
    'pvp.match.snapshot',
    (message) => message.matchId === matchId && message.players?.length === 4
  );

  for (const client of clients.slice(1)) {
    client.sendJson({
      type: 'pvp.match.surrender',
      matchId
    });
  }

  const endedMessage = await clients[0].waitForType(
    'pvp.match.ended',
    (message) => message.matchId === matchId
  );
  assert.equal(endedMessage.result.matchId, matchId);
  assert.equal(endedMessage.result.mode, 'deathmatch');

  const replayRecords = await waitForCondition(
    async () => {
      const rawStore = await readFile(path.join(dataDir, 'matches.json'), 'utf8');
      const store = JSON.parse(rawStore);
      const records = Array.isArray(store.matches)
        ? store.matches.filter((item) => String(item.ticketId || '').startsWith(`pvp:${matchId}:`))
        : [];

      if (records.length !== 4) {
        return null;
      }

      const hasReplayOnEveryRecord = records.every(
        (record) =>
          record.replay &&
          record.replay.available === true &&
          record.replay.matchId === matchId &&
          typeof record.replay.relativePath === 'string' &&
          record.replay.relativePath.length > 0
      );

      return hasReplayOnEveryRecord ? records : null;
    },
    {
      label: 'deathmatch replay persistence'
    }
  );

  const replayPaths = new Set(replayRecords.map((record) => record.replay.relativePath));
  assert.equal(replayPaths.size, 1);

  const replay = replayRecords[0].replay;
  assert.equal(replay.mode, 'deathmatch');
  assert.equal(replay.mapId, 'classic');
  assert.equal(replay.compressed, true);
  assert.match(replay.fileName, /\.ndjson\.gz$/u);
  assert.ok(Number(replay.snapshotCount || 0) > 0);

  const replayStat = await stat(path.join(dataDir, ...replay.relativePath.split('/')));
  assert.ok(replayStat.size > 0);

  const replayDetailResult = await apiJson(baseUrl, `/api/admin/replays/${matchId}`, {
    cookie: aliceCookie
  });
  assert.equal(replayDetailResult.response.status, 200);
  assert.equal(replayDetailResult.payload.matchId, matchId);
  assert.equal(replayDetailResult.payload.replay.matchId, matchId);
  assert.equal(replayDetailResult.payload.match.mapId, 'classic');
  assert.equal(replayDetailResult.payload.records.length, 4);

  const replayContentResult = await apiJson(baseUrl, `/api/admin/replays/${matchId}/content`, {
    cookie: aliceCookie
  });
  assert.equal(replayContentResult.response.status, 200);
  assert.equal(replayContentResult.payload.matchId, matchId);
  assert.equal(replayContentResult.payload.content.replay.matchId, matchId);
  assert.equal(replayContentResult.payload.content.mapId, 'classic');
  assert.equal(replayContentResult.payload.content.summary.mapId, 'classic');
  assert.ok(replayContentResult.payload.content.summary.snapshotCount > 0);
  assert.ok(replayContentResult.payload.content.snapshots.length > 0);
  assert.ok(replayContentResult.payload.content.events.length > 0);
  assert.equal(replayContentResult.payload.content.result.matchId, matchId);

  const replayDownloadResult = await fetch(`${baseUrl}/api/admin/replays/${matchId}/download`, {
    headers: {
      Cookie: aliceCookie
    }
  });
  assert.equal(replayDownloadResult.status, 200);
  assert.equal(replayDownloadResult.headers.get('content-type'), 'application/gzip');
  const replayDownloadBuffer = Buffer.from(await replayDownloadResult.arrayBuffer());
  assert.ok(replayDownloadBuffer.length > 0);

  const participantReplayList = await apiJson(baseUrl, '/api/pvp/replays?limit=12', {
    cookie: cookies.get('cathy')
  });
  assert.equal(participantReplayList.response.status, 200);
  assert.ok(participantReplayList.payload.items.some((item) => item.matchId === matchId));

  const participantReplayDetail = await apiJson(baseUrl, `/api/pvp/replays/${matchId}`, {
    cookie: cookies.get('cathy')
  });
  assert.equal(participantReplayDetail.response.status, 200);
  assert.equal(participantReplayDetail.payload.matchId, matchId);
  assert.equal(participantReplayDetail.payload.eventPanel.enabled, false);

  const participantReplayContent = await apiJson(baseUrl, `/api/pvp/replays/${matchId}/content`, {
    cookie: cookies.get('cathy')
  });
  assert.equal(participantReplayContent.response.status, 200);
  assert.equal(participantReplayContent.payload.content.replay.matchId, matchId);

  const forbiddenReplayDetail = await apiJson(baseUrl, `/api/pvp/replays/${matchId}`, {
    cookie: bobCookie
  });
  assert.equal(forbiddenReplayDetail.response.status, 403);
  assert.equal(forbiddenReplayDetail.payload.error, 'replay_forbidden');
});

test('matchmaking creates duel and deathmatch rooms with service-side room ownership', async (context) => {
  const { baseUrl } = await startPvpApp(context);

  const aliceCookie = await loginAs(baseUrl, USERS.alice);
  const bobCookie = await loginAs(baseUrl, USERS.bob);
  const cathyCookie = await loginAs(baseUrl, USERS.cathy);
  const doraCookie = await loginAs(baseUrl, USERS.dora);
  const erinCookie = await loginAs(baseUrl, USERS.erin);
  const frankCookie = await loginAs(baseUrl, USERS.frank);

  const aliceBootstrap = await apiJson(baseUrl, '/api/pvp/bootstrap', {
    cookie: aliceCookie
  });
  const bobBootstrap = await apiJson(baseUrl, '/api/pvp/bootstrap', {
    cookie: bobCookie
  });
  const cathyBootstrap = await apiJson(baseUrl, '/api/pvp/bootstrap', {
    cookie: cathyCookie
  });

  const aliceWs = await TestWebSocketClient.connect(aliceBootstrap.payload.wsUrl, {
    cookie: aliceCookie
  });
  const bobWs = await TestWebSocketClient.connect(bobBootstrap.payload.wsUrl, {
    cookie: bobCookie
  });
  const cathyWs = await TestWebSocketClient.connect(cathyBootstrap.payload.wsUrl, {
    cookie: cathyCookie
  });

  context.after(async () => {
    await aliceWs.close();
    await bobWs.close();
    await cathyWs.close();
  });

  await aliceWs.waitForType('pvp.session.synced');
  await bobWs.waitForType('pvp.session.synced');
  await cathyWs.waitForType('pvp.session.synced');

  const duelQueueAlice = await apiJson(baseUrl, '/api/pvp/matchmaking/enqueue', {
    method: 'POST',
    cookie: aliceCookie,
    body: {
      mode: 'duel',
      mapSelection: 'random'
    }
  });
  assert.equal(duelQueueAlice.response.status, 200);
  assert.equal(duelQueueAlice.payload.queue.mode, 'duel');
  assert.equal(duelQueueAlice.payload.queue.mapSelection, 'random');
  assert.equal(duelQueueAlice.payload.room, null);

  const duelQueueBob = await apiJson(baseUrl, '/api/pvp/matchmaking/enqueue', {
    method: 'POST',
    cookie: bobCookie,
    body: {
      mode: 'duel',
      mapSelection: 'classic'
    }
  });
  assert.equal(duelQueueBob.response.status, 200);
  assert.equal(duelQueueBob.payload.queue, null);
  assert.equal(duelQueueBob.payload.room.mode, 'duel');
  assert.equal(duelQueueBob.payload.room.capacity, 2);
  assert.equal(duelQueueBob.payload.room.source, 'matchmaking');
  assert.equal(duelQueueBob.payload.room.mapSelection, 'classic');

  const duelFoundForAlice = await aliceWs.waitForType(
    'pvp.match.found',
    (message) => message.room?.mode === 'duel'
  );
  const duelFoundForBob = await bobWs.waitForType(
    'pvp.match.found',
    (message) => message.room?.mode === 'duel'
  );
  assert.equal(duelFoundForAlice.room.members.length, 2);
  assert.equal(duelFoundForBob.room.members.length, 2);
  assert.equal(duelFoundForAlice.room.mapSelection, 'classic');

  const duelBootstrapAlice = await apiJson(baseUrl, '/api/pvp/bootstrap', {
    cookie: aliceCookie
  });
  assert.equal(duelBootstrapAlice.payload.currentRoom.mapSelection, 'classic');

  await apiJson(baseUrl, '/api/pvp/matchmaking/enqueue', {
    method: 'POST',
    cookie: cathyCookie,
    body: {
      mode: 'deathmatch'
    }
  });
  await apiJson(baseUrl, '/api/pvp/matchmaking/enqueue', {
    method: 'POST',
    cookie: doraCookie,
    body: {
      mode: 'deathmatch'
    }
  });
  await apiJson(baseUrl, '/api/pvp/matchmaking/enqueue', {
    method: 'POST',
    cookie: erinCookie,
    body: {
      mode: 'deathmatch'
    }
  });
  const deathmatchQueueFrank = await apiJson(baseUrl, '/api/pvp/matchmaking/enqueue', {
    method: 'POST',
    cookie: frankCookie,
    body: {
      mode: 'deathmatch'
    }
  });
  assert.equal(deathmatchQueueFrank.response.status, 200);
  assert.equal(deathmatchQueueFrank.payload.queue, null);
  assert.equal(deathmatchQueueFrank.payload.room.mode, 'deathmatch');
  assert.equal(deathmatchQueueFrank.payload.room.capacity, 4);

  const deathmatchFoundForCathy = await cathyWs.waitForType(
    'pvp.match.found',
    (message) => message.room?.mode === 'deathmatch'
  );
  assert.equal(deathmatchFoundForCathy.room.source, 'matchmaking');
  assert.equal(deathmatchFoundForCathy.room.members.length, 4);

  for (const cookie of [cathyCookie, doraCookie, erinCookie, frankCookie]) {
    const bootstrapResult = await apiJson(baseUrl, '/api/pvp/bootstrap', {
      cookie
    });
    assert.equal(bootstrapResult.response.status, 200);
    assert.equal(bootstrapResult.payload.currentQueue, null);
    assert.equal(bootstrapResult.payload.currentRoom.mode, 'deathmatch');
    assert.equal(bootstrapResult.payload.currentRoom.capacity, 4);
    assert.equal(bootstrapResult.payload.currentRoom.source, 'matchmaking');
  }
});

test('disconnects go offline first, then get cleaned from rooms and queues after timeout', async (context) => {
  const app = await startPvpApp(context);
  const { baseUrl, advance, wait } = app;

  const aliceCookie = await loginAs(baseUrl, USERS.alice);
  const bobCookie = await loginAs(baseUrl, USERS.bob);
  const gregCookie = await loginAs(baseUrl, USERS.greg);

  const aliceBootstrap = await apiJson(baseUrl, '/api/pvp/bootstrap', {
    cookie: aliceCookie
  });
  const bobBootstrap = await apiJson(baseUrl, '/api/pvp/bootstrap', {
    cookie: bobCookie
  });

  const aliceWs = await TestWebSocketClient.connect(aliceBootstrap.payload.wsUrl, {
    cookie: aliceCookie
  });
  const bobWs = await TestWebSocketClient.connect(bobBootstrap.payload.wsUrl, {
    cookie: bobCookie
  });

  context.after(async () => {
    await aliceWs.close();
    await bobWs.close();
  });

  await aliceWs.waitForType('pvp.session.synced');
  await bobWs.waitForType('pvp.session.synced');

  const createRoomResult = await apiJson(baseUrl, '/api/pvp/rooms', {
    method: 'POST',
    cookie: aliceCookie,
    body: {
      mode: 'duel'
    }
  });
  const roomCode = createRoomResult.payload.room.roomCode;

  await apiJson(baseUrl, '/api/pvp/rooms/join', {
    method: 'POST',
    cookie: bobCookie,
    body: {
      roomCode
    }
  });

  await aliceWs.waitForType(
    'pvp.room.updated',
    (message) => message.room?.roomCode === roomCode && message.room?.members?.length === 2
  );
  await bobWs.waitForType(
    'pvp.room.updated',
    (message) => message.room?.roomCode === roomCode && message.room?.members?.length === 2
  );

  const gregQueueResult = await apiJson(baseUrl, '/api/pvp/matchmaking/enqueue', {
    method: 'POST',
    cookie: gregCookie,
    body: {
      mode: 'deathmatch'
    }
  });
  assert.equal(gregQueueResult.response.status, 200);
  assert.equal(gregQueueResult.payload.queue.mode, 'deathmatch');

  await bobWs.close();

  const offlineUpdate = await aliceWs.waitForType(
    'pvp.room.updated',
    (message) =>
      message.room?.roomCode === roomCode &&
      message.room?.members?.find((member) => member.username === 'bob')?.presence === 'offline'
  );
  assert.equal(
    offlineUpdate.room.members.find((member) => member.username === 'bob')?.isReady,
    false
  );

  advance(61_000);
  await wait(500);

  const staleMemberRemoved = await waitForCondition(
    async () => {
      const result = await apiJson(baseUrl, '/api/pvp/bootstrap', {
        cookie: aliceCookie
      });
      const room = result.payload.currentRoom;
      if (room?.roomCode === roomCode && room.members?.length === 1 && !room.members.some((member) => member.username === 'bob')) {
        return result;
      }
      return null;
    },
    {
      label: 'stale member removal'
    }
  );
  assert.equal(staleMemberRemoved.payload.currentRoom.hostUser.username, 'alice');

  const gregBootstrapAfterExpiry = await waitForCondition(
    async () => {
      const result = await apiJson(baseUrl, '/api/pvp/bootstrap', {
        cookie: gregCookie
      });
      return result.payload.currentQueue === null ? result : null;
    },
    {
      label: 'queue expiry'
    }
  );
  assert.equal(gregBootstrapAfterExpiry.response.status, 200);
  assert.equal(gregBootstrapAfterExpiry.payload.currentQueue, null);

  advance(61_000);
  await wait(500);

  const aliceBootstrapAfterRoomExpiry = await waitForCondition(
    async () => {
      const result = await apiJson(baseUrl, '/api/pvp/bootstrap', {
        cookie: aliceCookie
      });
      return result.payload.currentRoom === null ? result : null;
    },
    {
      label: 'room expiry'
    }
  );
  assert.equal(aliceBootstrapAfterRoomExpiry.response.status, 200);
  assert.equal(aliceBootstrapAfterRoomExpiry.payload.currentRoom, null);
});
