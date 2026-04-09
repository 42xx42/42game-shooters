import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCombatResult,
  buildCombatSnapshot,
  COMBAT_TICK_MS,
  PVP_COMBAT_ARENA,
  PVP_COMBAT_OBSTACLES,
  PVP_COMBAT_PLAYER,
  createInitialCombatState,
  stepCombatState
} from '../src/pvp-combat-core.mjs';

function aimToward(from, to) {
  return Math.atan2((to.x || 0) - (from.x || 0), (to.z || 0) - (from.z || 0));
}

function repeatStep(state, inputFactory, ticks) {
  for (let index = 0; index < ticks; index += 1) {
    const inputs = inputFactory(index) || new Map();
    stepCombatState(state, inputs);
  }
}

function makePlayers(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${index + 1}`,
    userKey: `u${index + 1}`,
    username: `user${index + 1}`,
    displayName: `User ${index + 1}`
  }));
}

function fireShot(state, attackerKey, input) {
  const map = new Map();
  map.set(attackerKey, { ...input, fire: true });
  stepCombatState(state, map);
  stepCombatState(state, new Map([[attackerKey, { ...input, fire: false }]]));
}

test('movement stays inside arena bounds', () => {
  const state = createInitialCombatState({
    matchId: 'movement-test',
    mode: 'duel',
    players: makePlayers(2)
  });
  assert.equal(state.mapId, 'classic');
  assert.equal(buildCombatSnapshot(state).mapId, 'classic');

  const player = state.players[0];
  player.x = PVP_COMBAT_ARENA.bounds.maxX - PVP_COMBAT_PLAYER.radius * 0.5;
  player.yaw = 0;

  repeatStep(
    state,
    () =>
      new Map([
        [
          player.userKey,
          {
            moveX: 1,
            moveY: 0,
            aimYaw: 0,
            fire: false,
            reload: false,
            dash: false
          }
        ]
      ]),
    90
  );

  assert.ok(player.x <= PVP_COMBAT_ARENA.bounds.maxX - PVP_COMBAT_PLAYER.radius + 0.001);
});

test('movement collides with combat obstacles instead of walking through cover', () => {
  const state = createInitialCombatState({
    matchId: 'movement-cover-test',
    mode: 'duel',
    players: makePlayers(2)
  });

  const tank = PVP_COMBAT_OBSTACLES.find((entry) => entry.key === 'Tank');
  assert.ok(tank);

  const player = state.players[0];
  player.x = tank.minX - PVP_COMBAT_PLAYER.radius - 0.3;
  player.z = -0.6;
  player.yaw = Math.PI / 2;

  repeatStep(
    state,
    () =>
      new Map([
        [
          player.userKey,
          {
            moveX: 0,
            moveY: 1,
            aimYaw: Math.PI / 2,
            fire: false,
            reload: false,
            dash: false
          }
        ]
      ]),
    90
  );

  assert.ok(player.x <= tank.minX - PVP_COMBAT_PLAYER.radius + 0.02);
});

test('weapon switch, reload and dash all work on the shared combat core', () => {
  const state = createInitialCombatState({
    matchId: 'weapons-test',
    mode: 'duel',
    players: makePlayers(2)
  });

  const player = state.players[0];

  stepCombatState(
    state,
    new Map([
      [
        player.userKey,
        {
          moveX: 0,
          moveY: 0,
          aimYaw: 0,
          fire: false,
          reload: false,
          dash: false,
          weaponId: 'smg'
        }
      ]
    ])
  );
  repeatStep(state, () => new Map([[player.userKey, { aimYaw: 0, weaponId: 'smg' }]]), 3);
  assert.equal(player.weaponId, 'smg');

  player.weapons.smg.ammo = 0;
  player.weapons.smg.reserve = 30;

  stepCombatState(
    state,
    new Map([
      [
        player.userKey,
        {
          moveX: 0,
          moveY: 0,
          aimYaw: 0,
          fire: false,
          reload: true,
          dash: false,
          weaponId: 'smg'
        }
      ]
    ])
  );
  repeatStep(state, () => new Map([[player.userKey, { aimYaw: 0, weaponId: 'smg' }]]), 40);
  assert.equal(player.weapons.smg.ammo, 30);
  assert.equal(player.weapons.smg.reserve, 0);

  stepCombatState(
    state,
    new Map([
      [
        player.userKey,
        {
          moveX: 1,
          moveY: 0,
          aimYaw: 0,
          fire: false,
          reload: false,
          dash: true,
          weaponId: 'smg'
        }
      ]
    ])
  );
  assert.ok(player.dashCooldownTicks > 0);
});

test('duel mode ends after one player reaches three round wins', () => {
  const state = createInitialCombatState({
    matchId: 'duel-test',
    mode: 'duel',
    players: makePlayers(2)
  });

  const left = state.players[0];
  const right = state.players[1];

  for (let round = 0; round < 3; round += 1) {
    left.x = -4;
    left.z = 3.4;
    right.x = 4;
    right.z = 3.4;
    const yaw = aimToward(left, right);
    left.weaponId = 'shotgun';
    left.weapons.shotgun.ammo = 4;
    left.weapons.shotgun.reserve = 12;

    for (let shot = 0; shot < 4; shot += 1) {
      fireShot(state, left.userKey, {
        moveX: 0,
        moveY: 0,
        aimYaw: yaw,
        reload: false,
        dash: false,
        weaponId: 'shotgun'
      });
      repeatStep(
        state,
        () => new Map([[left.userKey, { aimYaw: yaw, weaponId: 'shotgun' }]]),
        30
      );
      if (state.wins[left.team] > round || state.status === 'ended') {
        break;
      }
    }

    if (round < 2) {
      repeatStep(state, () => new Map(), 60);
    }
  }

  assert.equal(state.status, 'ended');
  assert.equal(state.winnerTeam, left.team);
  assert.equal(state.result?.winnerTeam, left.team);
  assert.equal(state.result?.mvpUserId, left.userId);
  assert.equal(state.result?.mapId, 'classic');
});

test('deathmatch respawns before elimination and time ties enter sudden death', () => {
  const state = createInitialCombatState({
    matchId: 'deathmatch-test',
    mode: 'deathmatch',
    players: makePlayers(4)
  });

  const killer = state.players[0];
  const victim = state.players[1];
  killer.weaponId = 'shotgun';
  killer.weapons.shotgun.ammo = 24;
  killer.weapons.shotgun.reserve = 0;

  for (let elimination = 0; elimination < 2; elimination += 1) {
    killer.x = -1.5;
    victim.x = 1.5;
    killer.z = 3.4;
    victim.z = 3.4;
    const yaw = aimToward(killer, victim);
    fireShot(state, killer.userKey, {
      moveX: 0,
      moveY: 0,
      aimYaw: yaw,
      reload: false,
      dash: false,
      weaponId: 'shotgun'
    });
    repeatStep(state, () => new Map(), 30);
    fireShot(state, killer.userKey, {
      moveX: 0,
      moveY: 0,
      aimYaw: yaw,
      reload: false,
      dash: false,
      weaponId: 'shotgun'
    });
    repeatStep(state, () => new Map(), 70);
  }

  assert.equal(victim.lives, 1);
  assert.equal(victim.eliminated, false);

  killer.x = -1.5;
  victim.x = 1.5;
  killer.z = 3.4;
  victim.z = 3.4;
  const yaw = aimToward(killer, victim);
  fireShot(state, killer.userKey, {
    moveX: 0,
    moveY: 0,
    aimYaw: yaw,
    reload: false,
    dash: false,
    weaponId: 'shotgun'
  });
  repeatStep(state, () => new Map(), 30);
  fireShot(state, killer.userKey, {
    moveX: 0,
    moveY: 0,
    aimYaw: yaw,
    reload: false,
    dash: false,
    weaponId: 'shotgun'
  });

  assert.equal(victim.lives, 0);
  assert.equal(victim.eliminated, true);

  state.timeLeftMs = COMBAT_TICK_MS;
  state.players.forEach((player) => {
    if (!player.eliminated) {
      player.lives = 1;
      player.alive = true;
      player.hp = 100;
    }
  });
  stepCombatState(state, new Map());
  assert.equal(state.suddenDeath, true);
  assert.equal(buildCombatSnapshot(state).mapId, 'classic');
});

test('deathmatch respawns choose the safest available spawn instead of the seat default', () => {
  const state = createInitialCombatState({
    matchId: 'deathmatch-safe-respawn',
    mode: 'deathmatch',
    players: makePlayers(4)
  });

  const respawningPlayer = state.players[0];
  const occupiedA = state.players[1];
  const occupiedB = state.players[2];
  const occupiedC = state.players[3];

  occupiedA.x = -9;
  occupiedA.z = -2;
  occupiedB.x = 9;
  occupiedB.z = 2;
  occupiedC.x = 0;
  occupiedC.z = -7.2;

  respawningPlayer.alive = false;
  respawningPlayer.eliminated = false;
  respawningPlayer.hp = 0;
  respawningPlayer.lives = 2;
  respawningPlayer.respawnTicks = 1;

  const result = stepCombatState(state, new Map());
  const respawnEvent = result.events.find(
    (event) => event.type === 'respawn' && event.userId === respawningPlayer.userId
  );

  assert.ok(respawnEvent);
  assert.equal(respawningPlayer.alive, true);
  assert.equal(respawningPlayer.lives, 2);
  assert.equal(respawningPlayer.x, 0);
  assert.equal(respawningPlayer.z, 7.2);
});

test('shots are blocked by combat obstacles before reaching the target', () => {
  const state = createInitialCombatState({
    matchId: 'cover-blocks-shots',
    mode: 'duel',
    players: makePlayers(2)
  });

  const attacker = state.players[0];
  const target = state.players[1];
  attacker.weaponId = 'pistol';
  attacker.weapons.pistol.ammo = 8;
  attacker.weapons.pistol.reserve = 0;

  attacker.x = -6;
  attacker.z = -0.6;
  target.x = 6;
  target.z = -0.6;

  const yaw = aimToward(attacker, target);
  fireShot(state, attacker.userKey, {
    moveX: 0,
    moveY: 0,
    aimYaw: yaw,
    reload: false,
    dash: false,
    weaponId: 'pistol'
  });

  assert.equal(target.hp, 100);
});

test('combat result summary preserves map id metadata', () => {
  const state = createInitialCombatState({
    matchId: 'map-result-test',
    mode: 'duel',
    players: makePlayers(2)
  });

  const result = buildCombatResult(state);
  assert.equal(result.mapId, 'classic');
});

test('non-default maps use their own spawn layout and preserve map metadata', () => {
  const state = createInitialCombatState({
    matchId: 'crossfire-map-test',
    mode: 'deathmatch',
    mapId: 'crossfire',
    players: makePlayers(4)
  });

  assert.equal(state.mapId, 'crossfire');
  assert.deepEqual(
    state.players.map((player) => [player.x, player.z]),
    [
      [-12.2, 0],
      [12.2, 0],
      [0, -9.4],
      [0, 9.4]
    ]
  );
  assert.equal(buildCombatSnapshot(state).mapId, 'crossfire');
});
