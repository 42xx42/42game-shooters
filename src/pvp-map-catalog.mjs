export const PVP_MAP_SELECTION_RANDOM = 'random';
export const PVP_DEFAULT_MAP_ID = 'classic';
export const PVP_DEFAULT_MAP_SELECTION = PVP_DEFAULT_MAP_ID;

function freezeVector2(x, z) {
  return Object.freeze({ x, z });
}

function freezeVector3(x, y, z) {
  return Object.freeze({ x, y, z });
}

function freezePlacement(key, x, z, rot, sizeX, sizeZ) {
  return Object.freeze({ key, x, z, rot, sizeX, sizeZ });
}

function freezeDecor(key, x, z, rot) {
  return Object.freeze({ key, pos: Object.freeze([x, 0, z]), rot });
}

const CLASSIC_ARENA = Object.freeze({
  width: 26,
  depth: 18,
  bounds: Object.freeze({
    minX: -13,
    maxX: 13,
    minZ: -9,
    maxZ: 9
  }),
  ground: Object.freeze({
    width: 36,
    depth: 26
  })
});

const CLASSIC_FALLBACK_SIZES = Object.freeze({
  Tank: Object.freeze([4.5, 2.5, 3.0]),
  Debris_BrokenCar: Object.freeze([3.5, 1.5, 2.0]),
  Container_Small: Object.freeze([4.2, 2.0, 2.2]),
  Barrier_Large: Object.freeze([3.6, 1.2, 1.2]),
  Crate: Object.freeze([1.2, 1.2, 1.2]),
  SackTrench: Object.freeze([2.4, 0.8, 1.2]),
  Sofa: Object.freeze([2.0, 1.0, 1.0]),
  Structure_1: Object.freeze([2.5, 2.0, 2.5]),
  Pallet: Object.freeze([1.4, 0.2, 1.4]),
  CardboardBoxes_1: Object.freeze([1.1, 0.8, 1.1]),
  CardboardBoxes_2: Object.freeze([1.1, 0.8, 1.1]),
  CardboardBoxes_3: Object.freeze([1.1, 0.8, 1.1]),
  CardboardBoxes_4: Object.freeze([1.1, 0.8, 1.1])
});

const CLASSIC_COVER_LAYOUT = Object.freeze([
  freezePlacement('Tank', 0, -0.6, Math.PI * 0.6, 4.5, 3.0),
  freezePlacement('Barrier_Large', -11.2, -4.2, Math.PI / 2, 3.6, 1.2),
  freezePlacement('Barrier_Large', -11.2, 4.2, Math.PI / 2, 3.6, 1.2),
  freezePlacement('Barrier_Large', 11.2, -4.2, -Math.PI / 2, 3.6, 1.2),
  freezePlacement('Barrier_Large', 11.2, 4.2, -Math.PI / 2, 3.6, 1.2),
  freezePlacement('SackTrench', -7.4, 0.8, 0, 2.4, 1.2),
  freezePlacement('SackTrench', 7.4, -0.8, Math.PI, 2.4, 1.2),
  freezePlacement('Container_Small', -10.2, -7.2, 0.1, 4.2, 2.2),
  freezePlacement('Container_Small', 10.2, 7.2, -Math.PI + 0.1, 4.2, 2.2),
  freezePlacement('Structure_1', -10.3, 7.1, 0, 2.5, 2.5),
  freezePlacement('Structure_1', 10.3, -7.1, Math.PI, 2.5, 2.5),
  freezePlacement('Crate', -3.2, 0, 0.2, 1.2, 1.2),
  freezePlacement('Crate', 3.2, 0, -0.2, 1.2, 1.2),
  freezePlacement('Crate', 0, 5.1, 0.5, 1.2, 1.2),
  freezePlacement('Crate', 0, -5.1, -0.4, 1.2, 1.2),
  freezePlacement('Pallet', -6.2, -1.6, 0.15, 1.4, 1.4),
  freezePlacement('Pallet', 6.2, 1.6, -0.15, 1.4, 1.4),
  freezePlacement('Sofa', -8.3, 5.9, Math.PI / 4, 2.0, 1.0),
  freezePlacement('Sofa', 8.3, -5.9, -Math.PI / 4, 2.0, 1.0),
  freezePlacement('CardboardBoxes_2', -2.2, -6.6, 0.2, 1.1, 1.1),
  freezePlacement('CardboardBoxes_3', 2.2, 6.6, -0.2, 1.1, 1.1)
]);

const CLASSIC_DECORATIVE_PLACEMENTS = Object.freeze([
  freezeDecor('CardboardBoxes_1', -11, 5, 0.3),
  freezeDecor('CardboardBoxes_2', 11, -5, -0.4),
  freezeDecor('CardboardBoxes_3', -2, -7, 0.1),
  freezeDecor('CardboardBoxes_4', 2, 7, -0.2),
  freezeDecor('CardboardBoxes_1', 5, -6, 0.6),
  freezeDecor('CardboardBoxes_2', -5, 6, -0.5),
  freezeDecor('Debris_Tires', 4, -3, 0),
  freezeDecor('Debris_Tires', -4, -5, Math.PI / 3),
  freezeDecor('Debris_Tires', 8, 2, 0.8),
  freezeDecor('TrafficCone', -2, -2, 0),
  freezeDecor('TrafficCone', 2, 2, 0),
  freezeDecor('TrafficCone', -9, 0, 0.2),
  freezeDecor('TrafficCone', 9, 0, -0.1),
  freezeDecor('TrafficCone', 0, -8, 0.3),
  freezeDecor('TrafficCone', 0, 8, -0.2),
  freezeDecor('Debris_Pile', -10, 2, 0.5),
  freezeDecor('Debris_Pile', 10, -2, -0.3),
  freezeDecor('Debris_Pile', 3, -4, 0.7),
  freezeDecor('Debris_Papers_1', -1, -3, 0.8),
  freezeDecor('Debris_Papers_2', 1, 3, -0.6),
  freezeDecor('Debris_Papers_3', -6, -2, 0.4),
  freezeDecor('GasCan', -7, -4, 0.2),
  freezeDecor('GasCan', 7, 4, -0.3),
  freezeDecor('WoodPlanks', -3, 4, 0.6),
  freezeDecor('WoodPlanks', 3, -4, -0.5),
  freezeDecor('Pallet_Broken', 9, -4, 0.3),
  freezeDecor('Pallet_Broken', -9, 4, -0.4),
  freezeDecor('Pipes', -12, 0, Math.PI / 2),
  freezeDecor('Pipes', 12, 0, -Math.PI / 2),
  freezeDecor('TrashContainer', -12, -6, 0.1),
  freezeDecor('TrashContainer_Open', 12, 6, -0.1),
  freezeDecor('StreetLight', -12, 4, 0),
  freezeDecor('StreetLight', 12, -4, Math.PI),
  freezeDecor('Sign', -11, 7, -0.2),
  freezeDecor('Sign', 11, -7, 0.3)
]);

const CLASSIC_LOCAL_SPAWN_POINTS = Object.freeze([
  freezeVector3(-9, 0, 0),
  freezeVector3(9, 0, 0),
  freezeVector3(0, 0, -7),
  freezeVector3(0, 0, 7)
]);

const CLASSIC_LOCAL_BARREL_POSITIONS = Object.freeze([
  freezeVector3(-8.2, 0, -6.5),
  freezeVector3(8.2, 0, 6.5),
  freezeVector3(0, 0, 7)
]);

const CLASSIC_LOCAL_NAV_SEEDS = Object.freeze([
  freezeVector2(-8, 0),
  freezeVector2(8, 0),
  freezeVector2(0, -7),
  freezeVector2(0, 7)
]);

const CLASSIC_COMBAT_SPAWNS = Object.freeze({
  duel: Object.freeze([
    freezeVector2(-10, 0),
    freezeVector2(10, 0)
  ]),
  deathmatch: Object.freeze([
    freezeVector2(-9, -2),
    freezeVector2(9, 2),
    freezeVector2(0, -7.2),
    freezeVector2(0, 7.2)
  ])
});

const CROSSFIRE_ARENA = Object.freeze({
  width: 30,
  depth: 22,
  bounds: Object.freeze({
    minX: -15,
    maxX: 15,
    minZ: -11,
    maxZ: 11
  }),
  ground: Object.freeze({
    width: 40,
    depth: 30
  })
});

const CROSSFIRE_COVER_LAYOUT = Object.freeze([
  freezePlacement('Container_Small', 0, 0, Math.PI / 2, 4.2, 2.2),
  freezePlacement('Barrier_Large', -4.8, -3.2, 0, 3.6, 1.2),
  freezePlacement('Barrier_Large', 4.8, 3.2, Math.PI, 3.6, 1.2),
  freezePlacement('SackTrench', -4.8, 3.2, 0, 2.4, 1.2),
  freezePlacement('SackTrench', 4.8, -3.2, Math.PI, 2.4, 1.2),
  freezePlacement('Structure_1', -12.2, -7.6, 0, 2.5, 2.5),
  freezePlacement('Structure_1', 12.2, 7.6, Math.PI, 2.5, 2.5),
  freezePlacement('Container_Small', -11, 7.8, 0.12, 4.2, 2.2),
  freezePlacement('Container_Small', 11, -7.8, -Math.PI + 0.12, 4.2, 2.2),
  freezePlacement('Debris_BrokenCar', -7.2, 7, 0.35, 3.5, 2.0),
  freezePlacement('Debris_BrokenCar', 7.2, -7, -0.35, 3.5, 2.0),
  freezePlacement('Sofa', -9, 0, Math.PI / 2, 2.0, 1.0),
  freezePlacement('Sofa', 9, 0, -Math.PI / 2, 2.0, 1.0),
  freezePlacement('Crate', -1.8, 6, 0.3, 1.2, 1.2),
  freezePlacement('Crate', 1.8, -6, -0.3, 1.2, 1.2),
  freezePlacement('Pallet', -2.8, -8, 0.15, 1.4, 1.4),
  freezePlacement('Pallet', 2.8, 8, -0.15, 1.4, 1.4),
  freezePlacement('CardboardBoxes_2', -2.4, 8.9, 0.2, 1.1, 1.1),
  freezePlacement('CardboardBoxes_3', 2.4, -8.9, -0.2, 1.1, 1.1)
]);

const CROSSFIRE_DECORATIVE_PLACEMENTS = Object.freeze([
  freezeDecor('TrafficCone', -12, -1, 0.1),
  freezeDecor('TrafficCone', 12, 1, -0.1),
  freezeDecor('TrafficCone', -5, -10, 0.2),
  freezeDecor('TrafficCone', 5, 10, -0.2),
  freezeDecor('Debris_Tires', -13, 3, 0.6),
  freezeDecor('Debris_Tires', 13, -3, -0.6),
  freezeDecor('Debris_Pile', -8, -9, 0.4),
  freezeDecor('Debris_Pile', 8, 9, -0.4),
  freezeDecor('Debris_Papers_1', -2, 2, 0.8),
  freezeDecor('Debris_Papers_2', 2, -2, -0.6),
  freezeDecor('GasCan', -6, 8, 0.2),
  freezeDecor('GasCan', 6, -8, -0.3),
  freezeDecor('WoodPlanks', -1, -9, 0.6),
  freezeDecor('WoodPlanks', 1, 9, -0.5),
  freezeDecor('Pallet_Broken', 10, 5, 0.3),
  freezeDecor('Pallet_Broken', -10, -5, -0.4),
  freezeDecor('Pipes', -14, 0, Math.PI / 2),
  freezeDecor('Pipes', 14, 0, -Math.PI / 2),
  freezeDecor('TrashContainer', -13, -8, 0.1),
  freezeDecor('TrashContainer_Open', 13, 8, -0.1),
  freezeDecor('StreetLight', -14, 6, 0),
  freezeDecor('StreetLight', 14, -6, Math.PI),
  freezeDecor('Sign', -12, 9, -0.2),
  freezeDecor('Sign', 12, -9, 0.3)
]);

const CROSSFIRE_LOCAL_SPAWN_POINTS = Object.freeze([
  freezeVector3(-12.2, 0, 0),
  freezeVector3(12.2, 0, 0),
  freezeVector3(0, 0, -9.4),
  freezeVector3(0, 0, 9.4)
]);

const CROSSFIRE_LOCAL_BARREL_POSITIONS = Object.freeze([
  freezeVector3(-8.4, 0, -3.8),
  freezeVector3(8.4, 0, 3.8),
  freezeVector3(0, 0, 7.2)
]);

const CROSSFIRE_LOCAL_NAV_SEEDS = Object.freeze([
  freezeVector2(-11, 0),
  freezeVector2(11, 0),
  freezeVector2(0, -8.8),
  freezeVector2(0, 8.8),
  freezeVector2(-4.6, 6.6),
  freezeVector2(4.6, -6.6)
]);

const CROSSFIRE_COMBAT_SPAWNS = Object.freeze({
  duel: Object.freeze([
    freezeVector2(-12.2, 0),
    freezeVector2(12.2, 0)
  ]),
  deathmatch: Object.freeze([
    freezeVector2(-12.2, 0),
    freezeVector2(12.2, 0),
    freezeVector2(0, -9.4),
    freezeVector2(0, 9.4)
  ])
});

export const PVP_MAPS = Object.freeze({
  classic: Object.freeze({
    id: 'classic',
    name: 'Classic',
    arena: CLASSIC_ARENA,
    local: Object.freeze({
      spawnPoints: CLASSIC_LOCAL_SPAWN_POINTS,
      coverLayout: CLASSIC_COVER_LAYOUT,
      decorativePlacements: CLASSIC_DECORATIVE_PLACEMENTS,
      fallbackSizes: CLASSIC_FALLBACK_SIZES,
      barrelPositions: CLASSIC_LOCAL_BARREL_POSITIONS,
      navSeedPoints: CLASSIC_LOCAL_NAV_SEEDS,
      fence: Object.freeze({
        key: 'Fence_Long',
        offset: 0.4,
        scale: 1.1
      })
    }),
    combat: Object.freeze({
      arena: Object.freeze({
        width: CLASSIC_ARENA.width,
        depth: CLASSIC_ARENA.depth,
        bounds: CLASSIC_ARENA.bounds
      }),
      coverLayout: CLASSIC_COVER_LAYOUT,
      spawnByMode: CLASSIC_COMBAT_SPAWNS,
      fallbackSizes: CLASSIC_FALLBACK_SIZES
    })
  }),
  crossfire: Object.freeze({
    id: 'crossfire',
    name: 'Crossfire',
    arena: CROSSFIRE_ARENA,
    local: Object.freeze({
      spawnPoints: CROSSFIRE_LOCAL_SPAWN_POINTS,
      coverLayout: CROSSFIRE_COVER_LAYOUT,
      decorativePlacements: CROSSFIRE_DECORATIVE_PLACEMENTS,
      fallbackSizes: CLASSIC_FALLBACK_SIZES,
      barrelPositions: CROSSFIRE_LOCAL_BARREL_POSITIONS,
      navSeedPoints: CROSSFIRE_LOCAL_NAV_SEEDS,
      fence: Object.freeze({
        key: 'Fence_Long',
        offset: 0.4,
        scale: 1.1
      })
    }),
    combat: Object.freeze({
      arena: Object.freeze({
        width: CROSSFIRE_ARENA.width,
        depth: CROSSFIRE_ARENA.depth,
        bounds: CROSSFIRE_ARENA.bounds
      }),
      coverLayout: CROSSFIRE_COVER_LAYOUT,
      spawnByMode: CROSSFIRE_COMBAT_SPAWNS,
      fallbackSizes: CLASSIC_FALLBACK_SIZES
    })
  })
});

export const PVP_MAP_IDS = Object.freeze(Object.keys(PVP_MAPS));
export const PVP_MAP_SELECTION_OPTIONS = Object.freeze([
  ...PVP_MAP_IDS.map((mapId) =>
    Object.freeze({
      id: mapId,
      label: PVP_MAPS[mapId].name,
      kind: 'map'
    })
  ),
  Object.freeze({
    id: PVP_MAP_SELECTION_RANDOM,
    label: 'Random',
    kind: 'random'
  })
]);

function normalizeToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function hashSeed(seed) {
  const text = String(seed || '');
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash >>> 0;
}

export function normalizePvpMapId(value, fallback = PVP_DEFAULT_MAP_ID) {
  const normalized = normalizeToken(value);
  if (normalized && PVP_MAPS[normalized]) {
    return normalized;
  }
  if (fallback === null) {
    return null;
  }
  return PVP_MAPS[fallback] ? fallback : PVP_DEFAULT_MAP_ID;
}

export function normalizePvpMapSelection(value, fallback = PVP_DEFAULT_MAP_SELECTION) {
  const normalized = normalizeToken(value);
  if (normalized === PVP_MAP_SELECTION_RANDOM) {
    return PVP_MAP_SELECTION_RANDOM;
  }
  if (normalized && PVP_MAPS[normalized]) {
    return normalized;
  }
  if (fallback === null) {
    return null;
  }
  return normalizePvpMapSelection(fallback, null) || PVP_DEFAULT_MAP_SELECTION;
}

export function getPvpMapDefinition(mapId, fallback = PVP_DEFAULT_MAP_ID) {
  const normalized = normalizePvpMapId(mapId, fallback);
  return PVP_MAPS[normalized] || PVP_MAPS[PVP_DEFAULT_MAP_ID];
}

export function getPvpMapLabel(value) {
  const normalizedSelection = normalizePvpMapSelection(value, null);
  if (normalizedSelection === PVP_MAP_SELECTION_RANDOM) {
    return 'Random';
  }
  const normalizedMapId = normalizePvpMapId(value, null);
  if (normalizedMapId) {
    return getPvpMapDefinition(normalizedMapId).name;
  }
  return getPvpMapDefinition(PVP_DEFAULT_MAP_ID).name;
}

export function getAvailablePvpMapIds(options = {}) {
  const source = Array.isArray(options.availableMapIds) ? options.availableMapIds : PVP_MAP_IDS;
  const result = [];
  for (const value of source) {
    const normalized = normalizePvpMapId(value, null);
    if (normalized && !result.includes(normalized)) {
      result.push(normalized);
    }
  }
  return result.length ? result : [...PVP_MAP_IDS];
}

export function isCompatiblePvpMapSelection(left, right) {
  const normalizedLeft = normalizePvpMapSelection(left, null);
  const normalizedRight = normalizePvpMapSelection(right, null);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  return (
    normalizedLeft === PVP_MAP_SELECTION_RANDOM ||
    normalizedRight === PVP_MAP_SELECTION_RANDOM ||
    normalizedLeft === normalizedRight
  );
}

export function resolvePreferredPvpMapSelection(selections, fallback = PVP_MAP_SELECTION_RANDOM) {
  const list = Array.isArray(selections) ? selections : [selections];
  const concreteSelections = [];
  for (const value of list) {
    const normalized = normalizePvpMapSelection(value, null);
    if (!normalized || normalized === PVP_MAP_SELECTION_RANDOM) {
      continue;
    }
    if (!concreteSelections.includes(normalized)) {
      concreteSelections.push(normalized);
    }
  }
  if (concreteSelections.length > 1) {
    return null;
  }
  if (concreteSelections.length === 1) {
    return concreteSelections[0];
  }
  return normalizePvpMapSelection(fallback, PVP_MAP_SELECTION_RANDOM);
}

export function resolvePvpMapSelection(mapSelection, options = {}) {
  const availableMapIds = getAvailablePvpMapIds(options);
  const normalizedSelection = normalizePvpMapSelection(mapSelection, PVP_DEFAULT_MAP_SELECTION);
  if (normalizedSelection !== PVP_MAP_SELECTION_RANDOM) {
    return availableMapIds.includes(normalizedSelection)
      ? normalizedSelection
      : normalizePvpMapId(availableMapIds[0], PVP_DEFAULT_MAP_ID);
  }

  const preferredMapId = normalizePvpMapId(options.preferredMapId, null);
  if (preferredMapId && availableMapIds.includes(preferredMapId)) {
    return preferredMapId;
  }

  if (availableMapIds.length <= 1) {
    return normalizePvpMapId(availableMapIds[0], PVP_DEFAULT_MAP_ID);
  }

  const seed = options.seed ?? '';
  const index = hashSeed(seed) % availableMapIds.length;
  return normalizePvpMapId(availableMapIds[index], PVP_DEFAULT_MAP_ID);
}
