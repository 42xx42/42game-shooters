import {
  PVP_DEFAULT_MAP_ID,
  getPvpMapDefinition,
  normalizePvpMapId
} from './pvp-map-catalog.mjs';

export const COMBAT_TICK_RATE = 30;
export const COMBAT_TICK_MS = Math.round(1000 / COMBAT_TICK_RATE);
export const SNAPSHOT_TICK_INTERVAL = 2;
export const RECONNECT_GRACE_MS = 10_000;

function getCombatMapDefinition(mapId = PVP_DEFAULT_MAP_ID) {
  return getPvpMapDefinition(mapId).combat;
}

function getCombatArena(mapId = PVP_DEFAULT_MAP_ID) {
  return getCombatMapDefinition(mapId).arena;
}

function getCombatCoverLayout(mapId = PVP_DEFAULT_MAP_ID) {
  return getCombatMapDefinition(mapId).coverLayout;
}

export const PVP_COMBAT_ARENA = getCombatArena(PVP_DEFAULT_MAP_ID);

export const PVP_COMBAT_PLAYER = Object.freeze({
  radius: 0.62,
  hp: 100,
  moveSpeed: 7.8,
  accel: 38,
  decel: 42,
  dashSpeed: 19,
  dashDurationTicks: 5,
  dashCooldownTicks: 33,
  respawnTicks: 66,
  roundResetTicks: 42
});

export const PVP_COMBAT_WEAPONS = Object.freeze({
  pistol: Object.freeze({
    id: 'pistol',
    name: '手枪',
    fireRate: 2.1,
    damage: 16,
    magSize: 8,
    reserveStart: 24,
    reserveMax: 32,
    reloadTicks: 27,
    reloadType: 'mag',
    range: 34,
    spreadAngles: Object.freeze([0]),
    auto: false
  }),
  smg: Object.freeze({
    id: 'smg',
    name: '冲锋枪',
    fireRate: 10,
    damage: 8,
    magSize: 30,
    reserveStart: 60,
    reserveMax: 90,
    reloadTicks: 36,
    reloadType: 'mag',
    range: 28,
    spreadAngles: Object.freeze([0]),
    auto: true
  }),
  shotgun: Object.freeze({
    id: 'shotgun',
    name: '霰弹枪',
    fireRate: 1.2,
    damage: 12,
    pellets: 6,
    magSize: 4,
    reserveStart: 12,
    reserveMax: 24,
    reloadTicks: 15,
    reloadType: 'shell',
    range: 12,
    spreadAngles: Object.freeze([-0.16, -0.09, -0.03, 0.03, 0.09, 0.16]),
    auto: false
  })
});

export const PVP_COMBAT_MODES = Object.freeze({
  duel: Object.freeze({
    id: 'duel',
    capacity: 2,
    matchDurationMs: 105_000,
    roundWinsToWin: 3
  }),
  deathmatch: Object.freeze({
    id: 'deathmatch',
    capacity: 4,
    matchDurationMs: 105_000,
    startLives: 3
  })
});

const TEAM_ORDER = Object.freeze(['p1', 'p2', 'p3', 'p4']);
const VALID_WEAPON_IDS = new Set(Object.keys(PVP_COMBAT_WEAPONS));
const VALID_MODES = new Set(Object.keys(PVP_COMBAT_MODES));

export const PVP_COMBAT_COVER_LAYOUT = getCombatCoverLayout(PVP_DEFAULT_MAP_ID);

function buildCombatObstacle(entry) {
  const halfX = Math.max(0.1, Number(entry.sizeX || 0) / 2 - 0.08);
  const halfZ = Math.max(0.1, Number(entry.sizeZ || 0) / 2 - 0.08);
  const cos = Math.abs(Math.cos(Number(entry.rot) || 0));
  const sin = Math.abs(Math.sin(Number(entry.rot) || 0));
  const extentX = cos * halfX + sin * halfZ;
  const extentZ = sin * halfX + cos * halfZ;
  const centerX = Number(entry.x) || 0;
  const centerZ = Number(entry.z) || 0;
  return Object.freeze({
    key: entry.key,
    x: centerX,
    z: centerZ,
    minX: centerX - extentX,
    maxX: centerX + extentX,
    minZ: centerZ - extentZ,
    maxZ: centerZ + extentZ
  });
}

const COMBAT_OBSTACLE_CACHE = new Map();

function getCombatObstacles(mapId = PVP_DEFAULT_MAP_ID) {
  const normalizedMapId = normalizePvpMapId(mapId, PVP_DEFAULT_MAP_ID);
  if (!COMBAT_OBSTACLE_CACHE.has(normalizedMapId)) {
    COMBAT_OBSTACLE_CACHE.set(
      normalizedMapId,
      Object.freeze(getCombatCoverLayout(normalizedMapId).map(buildCombatObstacle))
    );
  }
  return COMBAT_OBSTACLE_CACHE.get(normalizedMapId);
}

export const PVP_COMBAT_OBSTACLES = getCombatObstacles(PVP_DEFAULT_MAP_ID);

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeAngle(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  let next = numeric;
  while (next <= -Math.PI) next += Math.PI * 2;
  while (next > Math.PI) next -= Math.PI * 2;
  return next;
}

function distanceSq(leftX, leftZ, rightX, rightZ) {
  const dx = rightX - leftX;
  const dz = rightZ - leftZ;
  return dx * dx + dz * dz;
}

function circleIntersectsObstacle(x, z, radius, obstacle) {
  const nearestX = clamp(x, obstacle.minX, obstacle.maxX);
  const nearestZ = clamp(z, obstacle.minZ, obstacle.maxZ);
  return distanceSq(x, z, nearestX, nearestZ) < radius * radius;
}

function resolveObstacleCollision(player, obstacle) {
  const radius = PVP_COMBAT_PLAYER.radius;
  const nearestX = clamp(player.x, obstacle.minX, obstacle.maxX);
  const nearestZ = clamp(player.z, obstacle.minZ, obstacle.maxZ);
  const dx = player.x - nearestX;
  const dz = player.z - nearestZ;
  const distSq = dx * dx + dz * dz;

  if (distSq > 0.000001) {
    const distance = Math.sqrt(distSq);
    const push = radius - distance + 0.0001;
    if (push > 0) {
      player.x += (dx / distance) * push;
      player.z += (dz / distance) * push;
    }
    return;
  }

  const moveToLeft = Math.abs(player.x - obstacle.minX);
  const moveToRight = Math.abs(obstacle.maxX - player.x);
  const moveToBottom = Math.abs(player.z - obstacle.minZ);
  const moveToTop = Math.abs(obstacle.maxZ - player.z);
  const minDistance = Math.min(moveToLeft, moveToRight, moveToBottom, moveToTop);

  if (minDistance === moveToLeft) {
    player.x = obstacle.minX - radius - 0.0001;
    return;
  }
  if (minDistance === moveToRight) {
    player.x = obstacle.maxX + radius + 0.0001;
    return;
  }
  if (minDistance === moveToBottom) {
    player.z = obstacle.minZ - radius - 0.0001;
    return;
  }
  player.z = obstacle.maxZ + radius + 0.0001;
}

function resolveObstacleCollisions(player, mapId = PVP_DEFAULT_MAP_ID) {
  for (let iteration = 0; iteration < 4; iteration += 1) {
    let collided = false;
    for (const obstacle of getCombatObstacles(mapId)) {
      if (!circleIntersectsObstacle(player.x, player.z, PVP_COMBAT_PLAYER.radius, obstacle)) {
        continue;
      }
      resolveObstacleCollision(player, obstacle);
      resolveBounds(player, mapId);
      collided = true;
    }
    if (!collided) {
      return;
    }
  }
}

function rayObstacleHit(originX, originZ, dirX, dirZ, maxDistance, obstacle) {
  let near = 0;
  let far = maxDistance;

  if (Math.abs(dirX) < 0.000001) {
    if (originX < obstacle.minX || originX > obstacle.maxX) {
      return null;
    }
  } else {
    const invX = 1 / dirX;
    let t1 = (obstacle.minX - originX) * invX;
    let t2 = (obstacle.maxX - originX) * invX;
    if (t1 > t2) [t1, t2] = [t2, t1];
    near = Math.max(near, t1);
    far = Math.min(far, t2);
    if (near > far) {
      return null;
    }
  }

  if (Math.abs(dirZ) < 0.000001) {
    if (originZ < obstacle.minZ || originZ > obstacle.maxZ) {
      return null;
    }
  } else {
    const invZ = 1 / dirZ;
    let t1 = (obstacle.minZ - originZ) * invZ;
    let t2 = (obstacle.maxZ - originZ) * invZ;
    if (t1 > t2) [t1, t2] = [t2, t1];
    near = Math.max(near, t1);
    far = Math.min(far, t2);
    if (near > far) {
      return null;
    }
  }

  if (far < 0 || near > maxDistance) {
    return null;
  }

  const distance = near >= 0 ? near : far;
  if (distance < 0 || distance > maxDistance) {
    return null;
  }

  return {
    obstacle,
    distance,
    x: originX + dirX * distance,
    z: originZ + dirZ * distance
  };
}

function getClosestObstacleHit(originX, originZ, dirX, dirZ, maxDistance, mapId = PVP_DEFAULT_MAP_ID) {
  let bestHit = null;
  for (const obstacle of getCombatObstacles(mapId)) {
    const hit = rayObstacleHit(originX, originZ, dirX, dirZ, maxDistance, obstacle);
    if (!hit) continue;
    if (!bestHit || hit.distance < bestHit.distance) {
      bestHit = hit;
    }
  }
  return bestHit;
}

function createEvent(state, type, payload = {}) {
  state.eventCursor = (state.eventCursor || 0) + 1;
  return {
    id: `${state.matchId}:${state.tick}:${state.eventCursor}`,
    type,
    tick: state.tick,
    serverTime: state.startedAtMs + state.tick * COMBAT_TICK_MS,
    ...payload
  };
}

function createWeaponState(weaponId) {
  const config = PVP_COMBAT_WEAPONS[weaponId];
  return {
    ammo: config.magSize,
    reserve: config.reserveStart,
    reloadTicks: 0,
    unlocked: true
  };
}

function getSeatDefaultYaw(seatIndex = 0) {
  return seatIndex % 2 === 0 ? Math.PI / 2 : -Math.PI / 2;
}

function getSpawnPool(mode, mapId = PVP_DEFAULT_MAP_ID) {
  const spawnByMode = getCombatMapDefinition(mapId).spawnByMode;
  return spawnByMode[mode] || spawnByMode.duel;
}

function getSpawnOccupants(state, excludeUserKey) {
  if (!state?.players?.length) {
    return [];
  }
  return state.players.filter(
    (player) => player.userKey !== excludeUserKey && player.alive && !player.eliminated
  );
}

function computeSpawnOrientation(spawn, mode, fallbackYaw, occupants = []) {
  if (mode !== 'deathmatch') {
    return fallbackYaw;
  }

  let targetX = 0;
  let targetZ = 0;
  let bestDistanceSq = Infinity;
  for (const occupant of occupants) {
    const currentDistanceSq = distanceSq(spawn.x, spawn.z, occupant.x, occupant.z);
    if (currentDistanceSq < bestDistanceSq) {
      bestDistanceSq = currentDistanceSq;
      targetX = occupant.x;
      targetZ = occupant.z;
    }
  }

  const dx = targetX - spawn.x;
  const dz = targetZ - spawn.z;
  if (dx * dx + dz * dz <= 0.0001) {
    return fallbackYaw;
  }
  return Math.atan2(dx, dz);
}

function chooseSpawnPlacement(mode, seatIndex, mapId = PVP_DEFAULT_MAP_ID, options = {}) {
  const spawns = getSpawnPool(mode, mapId);
  const fallbackIndex = seatIndex % spawns.length;
  const fallbackYaw = getSeatDefaultYaw(seatIndex);

  if (mode !== 'deathmatch') {
    const spawn = spawns[fallbackIndex];
    return {
      spawn,
      spawnIndex: fallbackIndex,
      yaw: computeSpawnOrientation(spawn, mode, fallbackYaw)
    };
  }

  const state = options.state || null;
  const reservedSpawnIndexes = options.reservedSpawnIndexes instanceof Set
    ? options.reservedSpawnIndexes
    : null;
  const occupants = getSpawnOccupants(state, options.excludeUserKey);

  if (!occupants.length) {
    let spawnIndex = fallbackIndex;
    if (reservedSpawnIndexes?.has(spawnIndex) && reservedSpawnIndexes.size < spawns.length) {
      const nextFreeSpawnIndex = spawns.findIndex((_, index) => !reservedSpawnIndexes.has(index));
      if (nextFreeSpawnIndex >= 0) {
        spawnIndex = nextFreeSpawnIndex;
      }
    }
    reservedSpawnIndexes?.add(spawnIndex);
    const spawn = spawns[spawnIndex];
    return {
      spawn,
      spawnIndex,
      yaw: computeSpawnOrientation(spawn, mode, fallbackYaw, occupants)
    };
  }

  let bestPlacement = null;
  for (let spawnIndex = 0; spawnIndex < spawns.length; spawnIndex += 1) {
    if (reservedSpawnIndexes?.has(spawnIndex) && reservedSpawnIndexes.size < spawns.length) {
      continue;
    }

    const spawn = spawns[spawnIndex];
    let minDistanceSq = Infinity;
    let totalDistanceSq = 0;
    for (const occupant of occupants) {
      const currentDistanceSq = distanceSq(spawn.x, spawn.z, occupant.x, occupant.z);
      minDistanceSq = Math.min(minDistanceSq, currentDistanceSq);
      totalDistanceSq += currentDistanceSq;
    }

    const placement = {
      spawn,
      spawnIndex,
      minDistanceSq,
      avgDistanceSq: occupants.length ? totalDistanceSq / occupants.length : Infinity,
      fallbackBias: spawnIndex === fallbackIndex ? 1 : 0
    };

    if (
      !bestPlacement ||
      placement.minDistanceSq > bestPlacement.minDistanceSq + 0.0001 ||
      (
        Math.abs(placement.minDistanceSq - bestPlacement.minDistanceSq) <= 0.0001 &&
        placement.avgDistanceSq > bestPlacement.avgDistanceSq + 0.0001
      ) ||
      (
        Math.abs(placement.minDistanceSq - bestPlacement.minDistanceSq) <= 0.0001 &&
        Math.abs(placement.avgDistanceSq - bestPlacement.avgDistanceSq) <= 0.0001 &&
        placement.fallbackBias > bestPlacement.fallbackBias
      )
    ) {
      bestPlacement = placement;
    }
  }

  const finalPlacement = bestPlacement || {
    spawn: spawns[fallbackIndex],
    spawnIndex: fallbackIndex
  };
  reservedSpawnIndexes?.add(finalPlacement.spawnIndex);
  return {
    spawn: finalPlacement.spawn,
    spawnIndex: finalPlacement.spawnIndex,
    yaw: computeSpawnOrientation(finalPlacement.spawn, mode, fallbackYaw, occupants)
  };
}

function createPlayerState(user, seatIndex, mode, mapId) {
  const placement = chooseSpawnPlacement(mode, seatIndex, mapId);
  const spawn = placement.spawn;
  return {
    seat: seatIndex,
    team: TEAM_ORDER[seatIndex] || `p${seatIndex + 1}`,
    userId: String(user.id || user.userId || seatIndex + 1),
    userKey: String(user.userKey || user.id || user.userId || seatIndex + 1),
    username: String(user.username || ''),
    displayName: String(user.displayName || user.username || user.id || `Player ${seatIndex + 1}`),
    avatarUrl: user.avatarUrl || null,
    spawn: { x: spawn.x, z: spawn.z },
    x: spawn.x,
    z: spawn.z,
    vx: 0,
    vz: 0,
    dashDirX: 0,
    dashDirZ: 1,
    yaw: placement.yaw,
    hp: PVP_COMBAT_PLAYER.hp,
    alive: true,
    eliminated: false,
    connected: true,
    reconnectDeadline: null,
    weaponId: 'pistol',
    pendingWeaponId: null,
    weaponSwitchTicks: 0,
    weapons: {
      pistol: createWeaponState('pistol'),
      smg: createWeaponState('smg'),
      shotgun: createWeaponState('shotgun')
    },
    fireCooldownTicks: 0,
    dashTicks: 0,
    dashCooldownTicks: 0,
    respawnTicks: 0,
    kills: 0,
    deaths: 0,
    damageDealt: 0,
    damageTaken: 0,
    lives: mode === 'deathmatch' ? PVP_COMBAT_MODES.deathmatch.startLives : 1,
    mapId,
    lastInput: normalizeCombatInput(),
    lastProcessedInputSeq: 0
  };
}

function cloneScoreboard(state) {
  if (state.mode === 'duel') {
    return {
      wins: { ...state.wins }
    };
  }

  return {
    lives: Object.fromEntries(
      state.players.map((player) => [
        player.team,
        {
          lives: player.lives,
          kills: player.kills,
          deaths: player.deaths
        }
      ])
    )
  };
}

function getWeaponState(player, weaponId = player.weaponId) {
  return player.weapons[weaponId];
}

function resetPlayerForSpawn(player, mode, seatIndex = player.seat, options = {}) {
  const placement = chooseSpawnPlacement(mode, seatIndex, options.mapId || player.mapId || PVP_DEFAULT_MAP_ID, {
    state: options.state,
    excludeUserKey: player.userKey,
    reservedSpawnIndexes: options.reservedSpawnIndexes
  });
  const spawn = placement.spawn;
  player.spawn = { x: spawn.x, z: spawn.z };
  player.x = spawn.x;
  player.z = spawn.z;
  player.vx = 0;
  player.vz = 0;
  player.dashDirX = 0;
  player.dashDirZ = 1;
  player.yaw = placement.yaw;
  player.hp = PVP_COMBAT_PLAYER.hp;
  player.alive = true;
  player.eliminated = false;
  player.respawnTicks = 0;
  player.weaponId = 'pistol';
  player.pendingWeaponId = null;
  player.weaponSwitchTicks = 0;
  player.fireCooldownTicks = 0;
  player.dashTicks = 0;
  player.dashCooldownTicks = 0;
  player.weapons = {
    pistol: createWeaponState('pistol'),
    smg: createWeaponState('smg'),
    shotgun: createWeaponState('shotgun')
  };
}

function updateReload(player) {
  const weaponState = getWeaponState(player);
  if (!weaponState || weaponState.reloadTicks <= 0) {
    return false;
  }

  weaponState.reloadTicks -= 1;
  if (weaponState.reloadTicks > 0) {
    return false;
  }

  const weapon = PVP_COMBAT_WEAPONS[player.weaponId];
  if (!weapon) {
    return false;
  }

  if (weapon.reloadType === 'shell') {
    if (weaponState.reserve > 0 && weaponState.ammo < weapon.magSize) {
      weaponState.ammo += 1;
      weaponState.reserve -= 1;
      if (weaponState.ammo < weapon.magSize && weaponState.reserve > 0) {
        weaponState.reloadTicks = weapon.reloadTicks;
      }
    }
    return true;
  }

  const needed = Math.max(0, weapon.magSize - weaponState.ammo);
  const amount = Math.min(needed, weaponState.reserve);
  weaponState.ammo += amount;
  weaponState.reserve -= amount;
  return true;
}

function startReload(player) {
  const weapon = PVP_COMBAT_WEAPONS[player.weaponId];
  const weaponState = getWeaponState(player);
  if (!weapon || !weaponState) return false;
  if (!player.alive || player.eliminated) return false;
  if (player.weaponSwitchTicks > 0) return false;
  if (weaponState.reloadTicks > 0) return false;
  if (weaponState.reserve <= 0) return false;
  if (weaponState.ammo >= weapon.magSize) return false;
  weaponState.reloadTicks = weapon.reloadTicks;
  return true;
}

function requestWeaponSwitch(player, weaponId) {
  if (!VALID_WEAPON_IDS.has(weaponId)) return false;
  if (!player.alive || player.eliminated) return false;
  if (player.weaponId === weaponId) return false;
  if (player.weaponSwitchTicks > 0) return false;
  const nextState = getWeaponState(player, weaponId);
  if (!nextState?.unlocked) return false;
  if (nextState.ammo <= 0 && nextState.reserve <= 0) return false;
  player.pendingWeaponId = weaponId;
  player.weaponSwitchTicks = Math.max(2, Math.round(COMBAT_TICK_RATE * 0.08));
  return true;
}

function updateWeaponSwitch(player) {
  if (player.weaponSwitchTicks <= 0) return false;
  player.weaponSwitchTicks -= 1;
  if (player.weaponSwitchTicks > 0 || !player.pendingWeaponId) return false;
  player.weaponId = player.pendingWeaponId;
  player.pendingWeaponId = null;
  return true;
}

function getForwardVector(yaw) {
  return {
    x: Math.sin(yaw),
    z: Math.cos(yaw)
  };
}

function getRightVector(yaw) {
  return {
    x: Math.cos(yaw),
    z: -Math.sin(yaw)
  };
}

function approach(current, target, delta) {
  if (Math.abs(target - current) <= delta) {
    return target;
  }
  return current + Math.sign(target - current) * delta;
}

function resolveBounds(player, mapId = PVP_DEFAULT_MAP_ID) {
  const arena = getCombatArena(mapId);
  player.x = clamp(
    player.x,
    arena.bounds.minX + PVP_COMBAT_PLAYER.radius,
    arena.bounds.maxX - PVP_COMBAT_PLAYER.radius
  );
  player.z = clamp(
    player.z,
    arena.bounds.minZ + PVP_COMBAT_PLAYER.radius,
    arena.bounds.maxZ - PVP_COMBAT_PLAYER.radius
  );
}

function separatePlayers(players, mapId = PVP_DEFAULT_MAP_ID) {
  for (let index = 0; index < players.length; index += 1) {
    for (let inner = index + 1; inner < players.length; inner += 1) {
      const left = players[index];
      const right = players[inner];
      if (!left.alive || !right.alive) continue;

      const dx = right.x - left.x;
      const dz = right.z - left.z;
      const distSq = dx * dx + dz * dz;
      const minDistance = PVP_COMBAT_PLAYER.radius * 2;
      if (distSq <= 0.0001 || distSq >= minDistance * minDistance) {
        continue;
      }

      const distance = Math.sqrt(distSq);
      const push = (minDistance - distance) * 0.5;
      const nx = dx / distance;
      const nz = dz / distance;

      left.x -= nx * push;
      left.z -= nz * push;
      right.x += nx * push;
      right.z += nz * push;

      resolveBounds(left, mapId);
      resolveBounds(right, mapId);
    }
  }
}

function rayCircleHit(originX, originZ, dirX, dirZ, maxDistance, target) {
  const toTargetX = target.x - originX;
  const toTargetZ = target.z - originZ;
  const projection = toTargetX * dirX + toTargetZ * dirZ;
  if (projection <= 0 || projection > maxDistance) {
    return null;
  }

  const closestX = originX + dirX * projection;
  const closestZ = originZ + dirZ * projection;
  const hitRadius = PVP_COMBAT_PLAYER.radius + 0.2;
  const missSq = distanceSq(closestX, closestZ, target.x, target.z);
  if (missSq > hitRadius * hitRadius) {
    return null;
  }

  return {
    distance: projection,
    x: closestX,
    z: closestZ
  };
}

function resolveFire(state, attacker, input, events) {
  const weapon = PVP_COMBAT_WEAPONS[attacker.weaponId];
  const weaponState = getWeaponState(attacker);
  if (!weapon || !weaponState) return;
  if (!attacker.alive || attacker.eliminated) return;
  if (attacker.weaponSwitchTicks > 0) return;
  if (weaponState.reloadTicks > 0) return;
  if (attacker.fireCooldownTicks > 0) return;
  if (weaponState.ammo <= 0) return;

  const shouldFire = weapon.auto
    ? Boolean(input.fire)
    : Boolean(input.fire && !attacker.lastInput.fire);
  if (!shouldFire) {
    return;
  }

  const forward = getForwardVector(attacker.yaw);
  const originX = attacker.x + forward.x * 0.55;
  const originZ = attacker.z + forward.z * 0.55;
  const damageByTarget = new Map();

  for (const angle of weapon.spreadAngles) {
    const dirYaw = attacker.yaw + angle;
    const dirX = Math.sin(dirYaw);
    const dirZ = Math.cos(dirYaw);
    const obstacleHit = getClosestObstacleHit(originX, originZ, dirX, dirZ, weapon.range, state.mapId);

    let bestTarget = null;
    let bestHit = null;
    for (const target of state.players) {
      if (target.userKey === attacker.userKey) continue;
      if (!target.alive || target.eliminated) continue;
      const hit = rayCircleHit(originX, originZ, dirX, dirZ, weapon.range, target);
      if (!hit) continue;
      if (obstacleHit && hit.distance >= obstacleHit.distance - 0.0001) continue;
      if (!bestHit || hit.distance < bestHit.distance) {
        bestHit = hit;
        bestTarget = target;
      }
    }

    if (!bestTarget || !bestHit) {
      continue;
    }

    const aggregate = damageByTarget.get(bestTarget.userKey) || {
      target: bestTarget,
      damage: 0,
      x: bestHit.x,
      z: bestHit.z
    };
    aggregate.damage += weapon.damage;
    aggregate.x = bestHit.x;
    aggregate.z = bestHit.z;
    damageByTarget.set(bestTarget.userKey, aggregate);
  }

  weaponState.ammo -= 1;
  attacker.fireCooldownTicks = Math.max(1, Math.round(COMBAT_TICK_RATE / weapon.fireRate));
  events.push(
    createEvent(state, 'fire', {
      attackerUserId: attacker.userId,
      attackerTeam: attacker.team,
      weaponId: weapon.id,
      origin: {
        x: roundValue(originX),
        z: roundValue(originZ)
      },
      yaw: roundValue(attacker.yaw, 4)
    })
  );

  for (const entry of damageByTarget.values()) {
    applyDamage(state, attacker, entry.target, entry.damage, events, {
      weaponId: weapon.id,
      x: entry.x,
      z: entry.z
    });
  }
}

function applyDamage(state, attacker, target, damage, events, context = {}) {
  if (!target.alive || target.eliminated) return;
  const dealt = Math.max(0, Math.round(Number(damage) || 0));
  if (dealt <= 0) return;

  target.hp = Math.max(0, target.hp - dealt);
  target.damageTaken += dealt;
  attacker.damageDealt += dealt;

  events.push(
    createEvent(state, 'hit', {
      attackerUserId: attacker.userId,
      targetUserId: target.userId,
      attackerTeam: attacker.team,
      targetTeam: target.team,
      weaponId: context.weaponId || attacker.weaponId,
      damage: dealt,
      hpLeft: target.hp,
      point: {
        x: roundValue(context.x ?? target.x),
        z: roundValue(context.z ?? target.z)
      }
    })
  );

  if (target.hp <= 0) {
    resolveKill(state, attacker, target, events, context);
  }
}

function resolveKill(state, attacker, target, events, context = {}) {
  if (!target.alive) return;
  target.alive = false;
  target.deaths += 1;
  attacker.kills += 1;

  events.push(
    createEvent(state, 'kill', {
      attackerUserId: attacker.userId,
      attackerTeam: attacker.team,
      targetUserId: target.userId,
      targetTeam: target.team,
      weaponId: context.weaponId || attacker.weaponId
    })
  );

  if (state.mode === 'duel') {
    state.wins[attacker.team] = (state.wins[attacker.team] || 0) + 1;
    state.roundState = 'between_rounds';
    state.roundResetTicks = PVP_COMBAT_PLAYER.roundResetTicks;
    events.push(
      createEvent(state, 'round_end', {
        winnerTeam: attacker.team,
        round: state.round,
        wins: { ...state.wins }
      })
    );

    if (state.suddenDeath || state.wins[attacker.team] >= PVP_COMBAT_MODES.duel.roundWinsToWin) {
      finishMatch(state, attacker.team, state.suddenDeath ? 'sudden_death' : 'score_limit', events);
    }
    return;
  }

  target.lives = Math.max(0, target.lives - 1);
  if (target.lives > 0) {
    target.respawnTicks = PVP_COMBAT_PLAYER.respawnTicks;
  } else {
    target.eliminated = true;
  }

  const aliveContenders = state.players.filter((player) => !player.eliminated);
  if (state.suddenDeath) {
    const livingSuddenDeath = aliveContenders.filter((player) => player.alive);
    if (livingSuddenDeath.length <= 1) {
      const winner = livingSuddenDeath[0] || aliveContenders[0] || attacker;
      finishMatch(state, winner.team, 'sudden_death', events);
    }
    return;
  }

  if (aliveContenders.length <= 1) {
    const winner = aliveContenders[0] || attacker;
    finishMatch(state, winner.team, 'last_player_standing', events);
  }
}

function respawnPlayer(state, player, events, options = {}) {
  resetPlayerForSpawn(player, state.mode, player.seat, {
    state,
    reservedSpawnIndexes: options.reservedSpawnIndexes,
    mapId: state.mapId
  });
  if (state.mode === 'deathmatch') {
    player.lives = Math.max(1, player.lives);
  }
  events.push(
    createEvent(state, 'respawn', {
      userId: player.userId,
      team: player.team,
      x: roundValue(player.x),
      z: roundValue(player.z)
    })
  );
}

function startSuddenDeath(state, contenders, events) {
  state.suddenDeath = true;
  state.roundState = 'live';
  state.roundResetTicks = 0;

  if (state.mode === 'duel') {
    state.round += 1;
    state.players.forEach((player, index) => {
      resetPlayerForSpawn(player, state.mode, index, { state, mapId: state.mapId });
    });
  } else {
    const contenderKeys = new Set(contenders.map((player) => player.userKey));
    const reservedSpawnIndexes = new Set();
    state.players.forEach((player, index) => {
      if (!contenderKeys.has(player.userKey)) {
        player.alive = false;
        player.eliminated = true;
        player.hp = 0;
        player.respawnTicks = 0;
        return;
      }
      resetPlayerForSpawn(player, state.mode, index, {
        state,
        reservedSpawnIndexes,
        mapId: state.mapId
      });
      player.lives = 1;
    });
  }

  events.push(
    createEvent(state, 'sudden_death', {
      round: state.round,
      contenders: contenders.map((player) => ({
        userId: player.userId,
        team: player.team
      }))
    })
  );
}

function finishMatch(state, winnerTeam, endedReason, events) {
  if (state.status === 'ended') return;
  state.status = 'ended';
  state.roundState = 'ended';
  state.winnerTeam = winnerTeam || null;
  state.endedReason = endedReason || 'completed';
  state.endedAtMs = state.startedAtMs + state.tick * COMBAT_TICK_MS;
  state.result = buildCombatResult(state, endedReason);
  events.push(
    createEvent(state, 'match_end', {
      winnerTeam: state.result.winnerTeam,
      endedReason: state.result.endedReason
    })
  );
}

function resolveTimeExpiry(state, events) {
  if (state.status !== 'active') return;

  if (state.mode === 'duel') {
    const winsEntries = Object.entries(state.wins);
    const sorted = winsEntries.slice().sort((left, right) => right[1] - left[1]);
    if (sorted[0]?.[1] > (sorted[1]?.[1] ?? -1)) {
      finishMatch(state, sorted[0][0], 'time_limit', events);
      return;
    }
    startSuddenDeath(state, state.players.slice(), events);
    return;
  }

  const activePlayers = state.players.filter((player) => !player.eliminated);
  if (!activePlayers.length) {
    finishMatch(state, null, 'time_limit', events);
    return;
  }

  const highestLives = Math.max(...activePlayers.map((player) => player.lives));
  const leaders = activePlayers.filter((player) => player.lives === highestLives);
  if (leaders.length === 1) {
    finishMatch(state, leaders[0].team, 'time_limit', events);
    return;
  }
  startSuddenDeath(state, leaders, events);
}

function updateDeathmatchRespawns(state, events) {
  const reservedSpawnIndexes = new Set();
  for (const player of state.players) {
    if (!player.alive && !player.eliminated && player.respawnTicks > 0) {
      player.respawnTicks -= 1;
      if (player.respawnTicks <= 0) {
        respawnPlayer(state, player, events, { reservedSpawnIndexes });
      }
    }
  }
}

function updateDuelRoundReset(state, events) {
  if (state.mode !== 'duel' || state.roundState !== 'between_rounds') {
    return;
  }

  if (state.status === 'ended') {
    return;
  }

  state.roundResetTicks = Math.max(0, state.roundResetTicks - 1);
  if (state.roundResetTicks > 0) {
    return;
  }

  state.round += 1;
  state.roundState = 'live';
  state.players.forEach((player, index) => {
    resetPlayerForSpawn(player, state.mode, index, { state, mapId: state.mapId });
  });

  events.push(
    createEvent(state, 'round_start', {
      round: state.round,
      wins: { ...state.wins },
      suddenDeath: Boolean(state.suddenDeath)
    })
  );
}

function updatePlayerTimers(player) {
  if (player.fireCooldownTicks > 0) player.fireCooldownTicks -= 1;
  if (player.dashCooldownTicks > 0) player.dashCooldownTicks -= 1;
  if (player.dashTicks > 0) player.dashTicks -= 1;
}

function applyMovement(player, input, mapId = PVP_DEFAULT_MAP_ID) {
  const axesLength = Math.hypot(input.moveX, input.moveY);
  const forward = getForwardVector(player.yaw);
  const right = getRightVector(player.yaw);
  const moveX = axesLength > 1 ? input.moveX / axesLength : input.moveX;
  const moveY = axesLength > 1 ? input.moveY / axesLength : input.moveY;

  let desiredX = right.x * moveX + forward.x * moveY;
  let desiredZ = right.z * moveX + forward.z * moveY;
  const desiredLength = Math.hypot(desiredX, desiredZ);
  if (desiredLength > 0.001) {
    desiredX = (desiredX / desiredLength) * PVP_COMBAT_PLAYER.moveSpeed;
    desiredZ = (desiredZ / desiredLength) * PVP_COMBAT_PLAYER.moveSpeed;
  }

  if (player.dashTicks > 0) {
    player.vx = player.dashDirX * PVP_COMBAT_PLAYER.dashSpeed;
    player.vz = player.dashDirZ * PVP_COMBAT_PLAYER.dashSpeed;
  } else {
    const accel = desiredLength > 0.001 ? PVP_COMBAT_PLAYER.accel : PVP_COMBAT_PLAYER.decel;
    const accelPerTick = accel / COMBAT_TICK_RATE;
    player.vx = approach(player.vx, desiredX, accelPerTick);
    player.vz = approach(player.vz, desiredZ, accelPerTick);
  }

  player.x += player.vx / COMBAT_TICK_RATE;
  player.z += player.vz / COMBAT_TICK_RATE;
  resolveBounds(player, mapId);
  resolveObstacleCollisions(player, mapId);
}

function maybeStartDash(player, input) {
  if (!input.dash || player.lastInput.dash) return false;
  if (!player.alive || player.eliminated) return false;
  if (player.dashCooldownTicks > 0 || player.dashTicks > 0) return false;

  const axesLength = Math.hypot(input.moveX, input.moveY);
  if (axesLength > 0.05) {
    const forward = getForwardVector(player.yaw);
    const right = getRightVector(player.yaw);
    const dirX = right.x * input.moveX + forward.x * input.moveY;
    const dirZ = right.z * input.moveX + forward.z * input.moveY;
    const length = Math.hypot(dirX, dirZ) || 1;
    player.dashDirX = dirX / length;
    player.dashDirZ = dirZ / length;
  } else {
    const forward = getForwardVector(player.yaw);
    player.dashDirX = forward.x;
    player.dashDirZ = forward.z;
  }

  player.dashTicks = PVP_COMBAT_PLAYER.dashDurationTicks;
  player.dashCooldownTicks = PVP_COMBAT_PLAYER.dashCooldownTicks;
  return true;
}

function updatePlayer(state, player, input, events) {
  player.lastProcessedInputSeq = input.inputSeq;

  if (!player.alive || player.eliminated) {
    player.lastInput = input;
    return;
  }

  player.yaw = normalizeAngle(input.aimYaw);

  updatePlayerTimers(player);
  updateReload(player);
  updateWeaponSwitch(player);

  if (input.weaponId && input.weaponId !== player.weaponId) {
    requestWeaponSwitch(player, input.weaponId);
  }

  if (input.reload && !player.lastInput.reload) {
    startReload(player);
  }

  maybeStartDash(player, input);
  applyMovement(player, input, state.mapId);
  resolveFire(state, player, input, events);
  player.lastInput = input;
}

function computeDefaultWinnerTeam(state) {
  if (state.mode === 'duel') {
    const sorted = Object.entries(state.wins).sort((left, right) => right[1] - left[1]);
    return sorted[0]?.[0] || null;
  }

  const sorted = state.players
    .slice()
    .sort((left, right) => {
      const livesDiff = right.lives - left.lives;
      if (livesDiff !== 0) return livesDiff;
      const killDiff = right.kills - left.kills;
      if (killDiff !== 0) return killDiff;
      const damageDiff = right.damageDealt - left.damageDealt;
      if (damageDiff !== 0) return damageDiff;
      return right.hp - left.hp;
    });
  return sorted[0]?.team || null;
}

function computeMvpPlayer(state, winnerTeam = null) {
  const candidates = state.players.slice();
  if (!candidates.length) return null;

  return candidates.sort((left, right) => {
    const teamBiasLeft = winnerTeam && left.team === winnerTeam ? 1 : 0;
    const teamBiasRight = winnerTeam && right.team === winnerTeam ? 1 : 0;
    if (teamBiasRight !== teamBiasLeft) return teamBiasRight - teamBiasLeft;
    const killDiff = right.kills - left.kills;
    if (killDiff !== 0) return killDiff;
    const damageDiff = right.damageDealt - left.damageDealt;
    if (damageDiff !== 0) return damageDiff;
    const livesDiff = right.lives - left.lives;
    if (livesDiff !== 0) return livesDiff;
    return right.hp - left.hp;
  })[0];
}

function roundValue(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

export function normalizeCombatMode(value, fallback = 'duel') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (VALID_MODES.has(normalized)) {
    return normalized;
  }
  return fallback;
}

export function normalizeCombatInput(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const weaponId = VALID_WEAPON_IDS.has(source.weaponId) ? source.weaponId : null;
  return {
    inputSeq: Math.max(0, Math.floor(Number(source.inputSeq) || 0)),
    moveX: clamp(Number(source.moveX) || 0, -1, 1),
    moveY: clamp(Number(source.moveY) || 0, -1, 1),
    aimYaw: normalizeAngle(source.aimYaw),
    fire: Boolean(source.fire),
    reload: Boolean(source.reload),
    dash: Boolean(source.dash),
    weaponId
  };
}

export function createInitialCombatState({
  matchId,
  roomId = null,
  roomCode = null,
  mode,
  mapId = PVP_DEFAULT_MAP_ID,
  players,
  startedAtMs = Date.now()
}) {
  const normalizedMode = normalizeCombatMode(mode, 'duel');
  const normalizedMapId = normalizePvpMapId(mapId, PVP_DEFAULT_MAP_ID);
  const rules = PVP_COMBAT_MODES[normalizedMode];
  const normalizedPlayers = Array.isArray(players) ? players : [];
  const combatPlayers = normalizedPlayers
    .slice(0, rules.capacity)
    .map((player, index) => createPlayerState(player, index, normalizedMode, normalizedMapId));

  return {
    matchId: String(matchId || ''),
    roomId: roomId || null,
    roomCode: roomCode || null,
    mode: normalizedMode,
    mapId: normalizedMapId,
    tick: 0,
    status: 'active',
    roundState: 'live',
    round: 1,
    startedAtMs: Number.isFinite(Number(startedAtMs)) ? Number(startedAtMs) : Date.now(),
    endedAtMs: null,
    timeLeftMs: rules.matchDurationMs,
    eventCursor: 0,
    winnerTeam: null,
    endedReason: null,
    result: null,
    suddenDeath: false,
    roundResetTicks: 0,
    wins:
      normalizedMode === 'duel'
        ? Object.fromEntries(combatPlayers.map((player) => [player.team, 0]))
        : {},
    players: combatPlayers
  };
}

export function buildCombatSnapshot(state) {
  return {
    matchId: state.matchId,
    mode: state.mode,
    mapId: normalizePvpMapId(state.mapId, PVP_DEFAULT_MAP_ID),
    tick: state.tick,
    status: state.status,
    timeLeft: Math.max(0, roundValue(state.timeLeftMs / 1000, 2)),
    round: state.round,
    wins: state.mode === 'duel' ? { ...state.wins } : null,
    suddenDeath: Boolean(state.suddenDeath),
    players: state.players.map((player) => {
      const weaponState = getWeaponState(player);
      return {
        userId: player.userId,
        team: player.team,
        x: roundValue(player.x),
        z: roundValue(player.z),
        yaw: roundValue(player.yaw, 4),
        hp: roundValue(player.hp, 2),
        alive: Boolean(player.alive),
        eliminated: Boolean(player.eliminated),
        connected: Boolean(player.connected),
        weaponId: player.weaponId,
        ammo: weaponState?.ammo ?? 0,
        reserve: weaponState?.reserve ?? 0,
        dashCooldown: roundValue(player.dashCooldownTicks / COMBAT_TICK_RATE, 2),
        respawnSeconds: roundValue(player.respawnTicks / COMBAT_TICK_RATE, 2),
        reloadSeconds: roundValue((weaponState?.reloadTicks || 0) / COMBAT_TICK_RATE, 2),
        weaponSwitchSeconds: roundValue(player.weaponSwitchTicks / COMBAT_TICK_RATE, 2),
        kills: player.kills,
        deaths: player.deaths,
        lives: player.lives,
        username: player.username,
        displayName: player.displayName
      };
    })
  };
}

export function buildCombatResult(state, endedReason = state.endedReason || 'completed') {
  const winnerTeam = state.winnerTeam || computeDefaultWinnerTeam(state);
  const mvpPlayer = computeMvpPlayer(state, winnerTeam);

  return {
    matchId: state.matchId,
    mode: state.mode,
    mapId: normalizePvpMapId(state.mapId, PVP_DEFAULT_MAP_ID),
    winnerTeam,
    mvpUserId: mvpPlayer?.userId || null,
    endedReason,
    stats: state.players.map((player) => ({
      userId: player.userId,
      username: player.username,
      displayName: player.displayName,
      team: player.team,
      kills: player.kills,
      deaths: player.deaths,
      damageDealt: roundValue(player.damageDealt, 2),
      damageTaken: roundValue(player.damageTaken, 2),
      lives: player.lives,
      won: Boolean(winnerTeam && player.team === winnerTeam),
      alive: Boolean(player.alive),
      eliminated: Boolean(player.eliminated)
    }))
  };
}

export function predictLocalPlayerState(
  snapshotPlayer,
  input,
  dtSeconds = 1 / COMBAT_TICK_RATE,
  mapId = PVP_DEFAULT_MAP_ID
) {
  const player = {
    x: Number(snapshotPlayer?.x) || 0,
    z: Number(snapshotPlayer?.z) || 0,
    yaw: normalizeAngle(snapshotPlayer?.yaw),
    vx: 0,
    vz: 0,
    dashTicks: 0,
    dashCooldownTicks: Math.round((Number(snapshotPlayer?.dashCooldown) || 0) * COMBAT_TICK_RATE),
    dashDirX: 0,
    dashDirZ: 1,
    alive: Boolean(snapshotPlayer?.alive),
    eliminated: Boolean(snapshotPlayer?.eliminated),
    lastInput: normalizeCombatInput(),
    weaponId: snapshotPlayer?.weaponId || 'pistol',
    weapons: {
      pistol: { ammo: 0, reserve: 0, reloadTicks: 0, unlocked: true },
      smg: { ammo: 0, reserve: 0, reloadTicks: 0, unlocked: true },
      shotgun: { ammo: 0, reserve: 0, reloadTicks: 0, unlocked: true }
    },
    weaponSwitchTicks: 0,
    fireCooldownTicks: 0
  };
  const normalizedInput = normalizeCombatInput(input);
  player.yaw = normalizedInput.aimYaw;
  maybeStartDash(player, normalizedInput);
  applyMovement(player, normalizedInput, mapId);
  return {
    x: roundValue(player.x),
    z: roundValue(player.z),
    yaw: roundValue(player.yaw, 4)
  };
}

export function stepCombatState(state, inputByUserKey = new Map()) {
  const events = [];
  const inputMap =
    inputByUserKey instanceof Map ? inputByUserKey : new Map(Object.entries(inputByUserKey || {}));

  if (state.status === 'ended') {
    return {
      events,
      snapshot: buildCombatSnapshot(state),
      ended: true,
      result: state.result || buildCombatResult(state)
    };
  }

  state.tick += 1;

  if (!state.suddenDeath) {
    state.timeLeftMs = Math.max(0, state.timeLeftMs - COMBAT_TICK_MS);
  }

  if (state.mode === 'duel') {
    updateDuelRoundReset(state, events);
  } else {
    updateDeathmatchRespawns(state, events);
  }

  if (state.roundState === 'live') {
    for (const player of state.players) {
      const input = normalizeCombatInput(inputMap.get(player.userKey) || player.lastInput);
      updatePlayer(state, player, input, events);
    }
    separatePlayers(state.players, state.mapId);
  }

  if (state.timeLeftMs <= 0 && !state.suddenDeath && state.status === 'active') {
    resolveTimeExpiry(state, events);
  }

  if (state.status === 'ended' && !state.result) {
    state.result = buildCombatResult(state, state.endedReason);
  }

  return {
    events,
    snapshot: buildCombatSnapshot(state),
    ended: state.status === 'ended',
    result: state.status === 'ended' ? state.result : null,
    serverTime: state.startedAtMs + state.tick * COMBAT_TICK_MS,
    scoreboard: cloneScoreboard(state)
  };
}

export function markCombatPlayerDisconnected(state, userKey, reconnectDeadlineMs = null) {
  const player = state.players.find((entry) => entry.userKey === userKey);
  if (!player) return null;
  player.connected = false;
  player.reconnectDeadline = reconnectDeadlineMs ?? null;
  player.lastInput = normalizeCombatInput();
  return player;
}

export function markCombatPlayerReconnected(state, userKey) {
  const player = state.players.find((entry) => entry.userKey === userKey);
  if (!player) return null;
  player.connected = true;
  player.reconnectDeadline = null;
  return player;
}

export function forceCombatForfeit(state, userKey, reason = 'disconnect_timeout') {
  if (state.status === 'ended') {
    return {
      events: [],
      result: state.result || buildCombatResult(state, state.endedReason)
    };
  }

  const player = state.players.find((entry) => entry.userKey === userKey);
  if (!player || player.eliminated) {
    return {
      events: [],
      result: state.result || buildCombatResult(state, state.endedReason)
    };
  }

  const events = [];
  player.connected = false;
  player.reconnectDeadline = null;

  if (state.mode === 'duel') {
    player.alive = false;
    player.hp = 0;
    const opponent = state.players.find((entry) => entry.userKey !== userKey) || null;
    finishMatch(state, opponent?.team || null, reason, events);
  } else {
    player.alive = false;
    player.hp = 0;
    player.lives = 0;
    player.eliminated = true;
    const contenders = state.players.filter((entry) => !entry.eliminated);
    if (contenders.length <= 1) {
      finishMatch(state, contenders[0]?.team || null, reason, events);
    }
  }

  if (!state.result) {
    state.result = buildCombatResult(state, state.endedReason || reason);
  }

  return {
    events,
    result: state.result
  };
}
