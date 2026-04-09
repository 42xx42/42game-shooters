import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const indexPath = path.join(rootDir, 'index.html');
const visualModulePath = path.join(rootDir, 'src', 'visual-tuning.js');
const browserTestPath = path.join(rootDir, 'scripts', 'visual-system.browser.test.mjs');

const REQUIRED_EVENTS = [
  'shot_fired',
  'player_hit',
  'kill',
  'headshot',
  'environment_hit',
  'near_miss',
  'damage_taken',
  'low_hp',
  'round_transition'
];

const REQUIRED_SEVERITIES = ['pressure', 'warning', 'critical', 'swing'];

test('visual system contract exposes unified tuning and runtime seams', async () => {
  await access(indexPath);
  await access(visualModulePath);
  await access(browserTestPath);

  const html = await readFile(indexPath, 'utf8');
  const visualModule = await import(pathToFileURL(visualModulePath).href);

  assert.ok(Array.isArray(visualModule.visualEventTypes), 'visualEventTypes must be exported');
  assert.deepEqual(visualModule.visualEventTypes, REQUIRED_EVENTS);
  assert.ok(visualModule.visualTuning, 'visualTuning must be exported');
  assert.ok(visualModule.shotViewProfiles, 'shotViewProfiles must be exported');
  assert.ok(visualModule.impactVisualProfiles, 'impactVisualProfiles must be exported');
  assert.ok(Array.isArray(visualModule.dangerSeverityOrder), 'dangerSeverityOrder must be exported');
  assert.deepEqual(visualModule.dangerSeverityOrder, REQUIRED_SEVERITIES);
  assert.ok(visualModule.dangerSeverityMatrix, 'dangerSeverityMatrix must be exported');
  assert.ok(visualModule.eventSeverityMap, 'eventSeverityMap must be exported');
  assert.equal(typeof visualModule.getShotViewProfile, 'function', 'getShotViewProfile must be exported');
  assert.equal(typeof visualModule.getImpactVisualProfile, 'function', 'getImpactVisualProfile must be exported');

  for (const modeId of ['duel', 'deathmatch']) {
    assert.ok(visualModule.visualTuning[modeId], `visualTuning.${modeId} must exist`);
    assert.ok(visualModule.dangerSeverityMatrix[modeId], `dangerSeverityMatrix.${modeId} must exist`);
    assert.ok(visualModule.shotViewProfiles[modeId], `shotViewProfiles.${modeId} must exist`);
    assert.ok(visualModule.impactVisualProfiles[modeId], `impactVisualProfiles.${modeId} must exist`);
    for (const severity of REQUIRED_SEVERITIES) {
      const severityProfile = visualModule.dangerSeverityMatrix[modeId][severity];
      assert.ok(severityProfile, `dangerSeverityMatrix.${modeId}.${severity} must exist`);
      for (const key of [
        'priority',
        'badgePulseHz',
        'badgePulseAmp',
        'pulseOpacity',
        'pulseScale',
        'feedDuration',
        'feedLift',
        'feedScale',
        'vignetteOpacity',
        'vignettePulseHz',
        'vignettePulseAmp',
        'cameraFovBias',
        'cameraShakeMul'
      ]) {
        assert.ok(
          Object.hasOwn(severityProfile, key),
          `dangerSeverityMatrix.${modeId}.${severity}.${key} must exist`
        );
      }
    }
    for (const weaponId of ['pistol', 'smg', 'shotgun']) {
      const profile = visualModule.visualTuning[modeId][weaponId];
      assert.ok(profile, `visualTuning.${modeId}.${weaponId} must exist`);
      for (const eventType of ['shot_fired', 'player_hit', 'kill', 'headshot', 'environment_hit']) {
        assert.ok(profile[eventType], `visualTuning.${modeId}.${weaponId}.${eventType} must exist`);
      }
      for (const key of [
        'streakLength',
        'streakWidth',
        'travelHintLength',
        'travelHintOpacity',
        'sampleEvery'
      ]) {
        assert.ok(
          Object.hasOwn(profile.shot_fired, key),
          `visualTuning.${modeId}.${weaponId}.shot_fired.${key} must exist`
        );
      }
    }
    for (const viewMode of ['topdown', 'fps']) {
      const shotViewProfile = visualModule.shotViewProfiles[modeId][viewMode];
      assert.ok(shotViewProfile, `shotViewProfiles.${modeId}.${viewMode} must exist`);
      for (const key of ['lengthMul', 'widthMul', 'opacityMul', 'travelHintMul', 'fadeMul']) {
        assert.ok(
          Object.hasOwn(shotViewProfile, key),
          `shotViewProfiles.${modeId}.${viewMode}.${key} must exist`
        );
      }
    }
    for (const impactKind of ['player', 'cover', 'barrel', 'near_miss']) {
      const impactProfile = visualModule.impactVisualProfiles[modeId][impactKind];
      assert.ok(impactProfile, `impactVisualProfiles.${modeId}.${impactKind} must exist`);
      for (const key of ['flashSize', 'flashLife', 'sparkCount', 'sparkSpeed']) {
        assert.ok(
          Object.hasOwn(impactProfile, key),
          `impactVisualProfiles.${modeId}.${impactKind}.${key} must exist`
        );
      }
    }
    const globalProfile = visualModule.visualTuning[modeId].global;
    assert.ok(globalProfile, `visualTuning.${modeId}.global must exist`);
    for (const eventType of ['near_miss', 'damage_taken', 'low_hp', 'round_transition']) {
      assert.ok(globalProfile[eventType], `visualTuning.${modeId}.global.${eventType} must exist`);
    }
    assert.ok(globalProfile.hud, `visualTuning.${modeId}.global.hud must exist`);
    assert.ok(globalProfile.menu, `visualTuning.${modeId}.global.menu must exist`);
  }

  for (const eventType of ['damage_taken', 'near_miss', 'low_hp', 'kill', 'headshot', 'round_transition']) {
    assert.ok(
      visualModule.eventSeverityMap[eventType],
      `eventSeverityMap.${eventType} must exist`
    );
  }

  assert.match(html, /function\s+presentCombatFeedback\s*\(/, 'index.html must define presentCombatFeedback()');
  assert.match(html, /function\s+resolveDangerProfile\s*\(/, 'index.html must define resolveDangerProfile()');
  assert.match(html, /visualState\s*:/, 'render_game_to_text() must expose visualState');
  assert.match(html, /severity\s*:/, 'visualState must expose severity');
  assert.match(html, /persistentDanger\s*:/, 'visualState must expose persistentDanger');
  assert.match(html, /lastDangerSource\s*:/, 'visualState must expose lastDangerSource');
  assert.match(html, /foregroundSeverity\s*:/, 'visualState must expose foregroundSeverity');
  assert.match(html, /backgroundSeverity\s*:/, 'visualState must expose backgroundSeverity');
  assert.match(html, /layerSeverities\s*:/, 'visualState must expose layerSeverities');
  assert.match(html, /activeLayers\s*:/, 'visualState must expose activeLayers');
  assert.match(html, /shotFx\s*:/, 'visualState must expose shotFx metrics');
  assert.match(html, /viewMode\s*:/, 'render_game_to_text must expose current viewMode');
  assert.match(html, /window\.advanceTime\s*=/, 'index.html must expose window.advanceTime for deterministic stepping');
  assert.match(
    html,
    /bannerVisible\s*:/,
    'visualState must expose bannerVisible for hero feed regression capture'
  );

  const browserTestSource = await readFile(browserTestPath, 'utf8');
  assert.match(
    browserTestSource,
    /critical-plus-swing-peak\.png/,
    'browser regression must capture a peak hero feed screenshot'
  );
  assert.match(
    browserTestSource,
    /peakFeedOpacity/,
    'browser regression must record peakFeedOpacity metadata'
  );
  assert.match(
    browserTestSource,
    /peakScreenshot/,
    'browser regression must record peakScreenshot metadata'
  );
  assert.match(
    browserTestSource,
    /peakFrameOffsetMs/,
    'browser regression must record peakFrameOffsetMs metadata'
  );
  assert.match(
    browserTestSource,
    /topdown-pistol-shot-visual/,
    'browser regression must cover topdown shot visuals'
  );
  assert.match(
    browserTestSource,
    /fps-pistol-shot-visual/,
    'browser regression must cover fps shot visuals'
  );
  assert.match(
    browserTestSource,
    /smg-density-shot-visual/,
    'browser regression must cover smg shot-visual density'
  );
  assert.match(
    browserTestSource,
    /barrel-impact-shot-visual/,
    'browser regression must cover barrel impact shot visuals'
  );
  assert.match(
    browserTestSource,
    /near-miss-shot-visual/,
    'browser regression must cover near-miss shot visuals'
  );
});
