import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);

function text(path: string): string {
  return readFileSync(new URL(path, root), 'utf8');
}

void describe('docs package integration contract', () => {
  void it('declares docs scripts, prepack gates, and packaged docs payload', () => {
    const pkg = JSON.parse(text('package.json')) as {
      files: string[];
      scripts: Record<string, string>;
      pi?: { image?: string };
    };
    assert.ok(pkg.files.includes('docs/'));
    assert.ok(pkg.files.includes('BACKGROUND-TASKS-INSTRUCTIONS.md'));
    assert.ok(pkg.files.includes('logo.png'));
    assert.equal(
      pkg.pi?.image,
      'https://raw.githubusercontent.com/ismailsaleekh/pi-background-tasks/main/logo.png',
    );
    assert.equal(
      pkg.scripts['docs:generate'],
      'node scripts/docs/generate.mjs',
    );
    assert.equal(pkg.scripts['docs:verify'], 'node scripts/docs/verify.mjs');
    assert.equal(
      pkg.scripts['docs:verify:attestations'],
      'node scripts/docs/verify.mjs --require-attestations',
    );
    assert.equal(
      pkg.scripts['docs:attest/record'],
      'node scripts/docs/attest.mjs',
    );
    assert.equal(
      pkg.scripts['test:docs'],
      'tsx --test tests/unit/docs-gate.test.ts tests/package/docs-contract.test.ts',
    );
    assert.equal(
      pkg.scripts['payload:check'],
      'npm run build:runtime && node scripts/check-package-payload.mjs',
    );
    assert.equal(
      pkg.scripts['release:check-version'],
      'node scripts/check-release-version.mjs',
    );
    assert.match(pkg.scripts['prepack'] ?? '', /build:runtime/);
    assert.match(pkg.scripts['prepack'] ?? '', /docs:verify/);
    assert.match(pkg.scripts['prepack'] ?? '', /check-package-payload/);
    for (const path of [
      'docs/INDEX.md',
      'docs/read-before-edit.md',
      'docs/manifest.json',
      'docs/attestations.json',
      'docs/subsystems/docs-freshness-gate.md',
    ]) {
      assert.ok(existsSync(new URL(path, root)), `${path} must exist`);
    }
  });

  void it('publishes required process surfaces and finite dock availability from runtime source', () => {
    const manifest = JSON.parse(text('docs/manifest.json')) as {
      default_public_surface_ids?: string[];
      public_surfaces?: Record<
        string,
        Array<{
          id?: string;
          availability?: string;
          default_available?: boolean;
        }>
      >;
    };
    assert.ok(Array.isArray(manifest.default_public_surface_ids));
    const surfaces = Object.values(manifest.public_surfaces ?? {}).flat();
    const byId = new Map(surfaces.map((surface) => [surface.id, surface]));
    assert.equal(byId.get('tool:bash')?.availability, 'always');
    assert.equal(byId.get('tool:bg_status')?.availability, 'always');
    assert.equal(byId.get('tool:bg_logs')?.availability, 'always');
    assert.equal(byId.get('tool:bg_kill')?.availability, 'always');
    assert.equal(byId.get('command:bg-clear')?.availability, 'always');
    assert.equal(byId.get('command:bg-jobs')?.availability, 'always');
    assert.equal(byId.get('command:bg-logs')?.availability, 'always');
    assert.equal(byId.get('command:bg-kill')?.availability, 'always');
    assert.equal(
      byId.get('shortcut:shift+down')?.availability,
      'dock:shift+down',
    );
    assert.equal(
      byId.get('shortcut:ctrl+alt+b')?.availability,
      'dock:ctrl+alt+b',
    );
    assert.equal(byId.get('shortcut:shift+down')?.default_available, true);
    assert.equal(byId.get('shortcut:ctrl+alt+b')?.default_available, false);
    assert.ok(
      manifest.default_public_surface_ids?.includes('shortcut:shift+down'),
    );
    assert.equal(
      manifest.default_public_surface_ids?.includes('shortcut:ctrl+alt+b'),
      false,
    );

    assert.match(text('docs/INDEX.md'), /Availability \| Default/);
    assert.match(text('docs/reference/shortcuts-and-dock.md'), /ctrl\+alt\+b/);
    assert.match(
      text('docs/operations/configuration.md'),
      /PI_BG_DOCK_SHORTCUT/,
    );
  });

  void it('states the initialized-host SDK boundary without narrowing the blocker', () => {
    const gettingStarted = text('docs/getting-started.md');
    const configuration = text('docs/operations/configuration.md');
    const eventBus = text('docs/api/eventbus-v1.md');

    assert.match(gettingStarted, /SDK embedding requirement/i);
    assert.match(gettingStarted, /at least one counted binding/i);
    assert.match(configuration, /bindExtensions\(\)/);
    assert.match(configuration, /after every `reload\(\)`/i);
    assert.match(eventBus, /normal Pi TUI, RPC, print, and JSON modes/i);
    for (const prose of [gettingStarted, configuration, eventBus]) {
      assert.match(prose, /initialized-host contract/i);
      assert.match(prose, /not a pre-bind availability guarantee/i);
    }
  });

  void it('pins reviewed runtime and generated artifact semantics', () => {
    assert.match(
      text('docs/api/eventbus-v1.md'),
      /at least once under emission failure/,
    );
    assert.match(
      text('docs/api/eventbus-v1.md'),
      /requests first emitted after close are not handled and receive no service response/,
    );
    assert.match(
      text('docs/api/eventbus-v1.md'),
      /request already accepted before close may receive one error response, but never a post-close success/,
    );
    assert.match(
      text('docs/subsystems/background-task-runtime.md'),
      /rather than issuing `fsync`/,
    );
    assert.match(
      text('docs/subsystems/background-task-runtime.md'),
      /may occur after the completion notification/,
    );
    assert.match(
      text('docs/subsystems/host-ui-and-telemetry.md'),
      /detail view is opened/,
    );
    assert.match(
      text('docs/subsystems/host-ui-and-telemetry.md'),
      /dock is closed/,
    );
    assert.doesNotMatch(
      text('docs/reference/shortcuts-and-dock.md'),
      /Opening or closing the dock does not clear them/,
    );
  });
});
