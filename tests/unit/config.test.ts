import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  dockShortcutFooterHint,
  parseBackgroundTasksConfig,
  PI_BG_DEFAULT_DOCK_SHORTCUT,
  PI_BG_DEFAULT_FEATURES,
  PI_BG_DOCK_SHORTCUT_VALUES,
  PI_BG_FEATURE_VALUES,
} from '../../src/core/config.js';

void describe('background task capability configuration', () => {
  void it('keeps the single mandatory process capability and Shift+Down as defaults', () => {
    const config = parseBackgroundTasksConfig({});
    assert.deepEqual(PI_BG_FEATURE_VALUES, ['process']);
    assert.deepEqual(PI_BG_DEFAULT_FEATURES, ['process']);
    assert.equal(PI_BG_DEFAULT_DOCK_SHORTCUT, 'shift+down');
    assert.deepEqual(config.features, { process: true });
    assert.equal(config.dockShortcut, 'shift+down');
    assert.equal(dockShortcutFooterHint(config.dockShortcut), 'Shift↓');
  });

  void it('ignores any legacy feature-selection value', () => {
    for (const value of [
      '',
      'process',
      'delegate',
      'process,delegate',
      'PROCESS',
      'garbage',
    ]) {
      const config = parseBackgroundTasksConfig({ PI_BG_FEATURES: value });
      assert.deepEqual(config.features, { process: true }, value);
    }
  });

  void it('accepts only the three finite dock choices and derives their hints', () => {
    assert.deepEqual(PI_BG_DOCK_SHORTCUT_VALUES, [
      'shift+down',
      'ctrl+alt+b',
      'off',
    ]);
    assert.deepEqual(
      PI_BG_DOCK_SHORTCUT_VALUES.map((shortcut) => [
        parseBackgroundTasksConfig({ PI_BG_DOCK_SHORTCUT: shortcut })
          .dockShortcut,
        dockShortcutFooterHint(shortcut),
      ]),
      [
        ['shift+down', 'Shift↓'],
        ['ctrl+alt+b', 'CtrlAltB'],
        ['off', '/bg-jobs'],
      ],
    );
  });

  void it('rejects malformed dock values without fallback', () => {
    assert.throws(
      () => parseBackgroundTasksConfig({ PI_BG_DOCK_SHORTCUT: 'shift+up' }),
      /pi_bg_config_invalid: PI_BG_DOCK_SHORTCUT.*shift\+down,ctrl\+alt\+b,off/,
    );
  });
});
