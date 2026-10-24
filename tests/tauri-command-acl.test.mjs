import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Read production sources, not duplicated/generated fixtures. No Tauri mock can
// detect a missing app ACL grant: it bypasses the native runtime authority.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const sorted = (values) => [...values].sort();
const quoteValues = (source) => [...source.matchAll(/"([a-z][a-z0-9_]*)"/g)].map((match) => match[1]);
const allow = (command) => `allow-${command.replaceAll('_', '-')}`;

function validateWindowsResources(build) {
  assert.doesNotMatch(build, /\bwinres::|\bres\.compile\s*\(/, 'do not compile a second Windows resource library');
  assert.equal([...build.matchAll(/tauri_build::(?:try_build|build)\s*\(/g)].length, 1, 'compile Tauri resources exactly once');
  assert.match(build, /\.windows_attributes\(windows_attributes\(WINDOWS_APP_MANIFEST\)\)/);
  assert.match(build, /let target_os = std::env::var\("CARGO_CFG_TARGET_OS"\)/);
  assert.match(build, /let target_env = std::env::var\("CARGO_CFG_TARGET_ENV"\)/);
  const branches = build.match(/if target_os == "windows" && target_env == "msvc" \{([\s\S]*?)\n    \} else \{([\s\S]*?)\n    \}/);
  assert.ok(branches, 'manifest linker flags must be scoped to Windows MSVC targets');
  const [, msvc, fallback] = branches;
  assert.match(msvc, /std::fs::write\(&manifest_path, manifest\)/);
  assert.match(msvc, /var_os\("OUT_DIR"\)/);
  assert.match(msvc, /cargo:rustc-link-arg=\/MANIFEST:EMBED/);
  assert.match(msvc, /cargo:rustc-link-arg=\/MANIFESTINPUT:\{\}/);
  assert.doesNotMatch(build, /cargo:rustc-link-arg-(?:bins|tests|bin)=/, 'lib unit tests need a generic link argument');
  assert.match(msvc, /WindowsAttributes::new_without_app_manifest\(\)\s*\.window_icon_path\("icons\/icon\.ico"\)/);
  assert.doesNotMatch(msvc, /\.app_manifest\(/, 'MSVC resource compilation must not embed a second manifest');
  assert.match(fallback, /WindowsAttributes::new\(\)\s*\.window_icon_path\("icons\/icon\.ico"\)\s*\.app_manifest\(manifest\)/);
  assert.doesNotMatch(fallback, /rustc-link-arg|new_without_app_manifest/, 'GNU and non-Windows retain the normal resource path');
  const manifest = build.match(/const WINDOWS_APP_MANIFEST: &str = r#"([\s\S]*?)"#;/);
  assert.ok(manifest, 'keep the existing custom Windows manifest');
  // Freeze the exact former winres XML: Common Controls v6, asInvoker,
  // supported Windows versions, and both legacy/PerMonitorV2 DPI declarations.
  assert.equal(createHash('sha256').update(manifest[1]).digest('hex'), 'e7b90a3e9242b6ef9f9a43116da43d6f034ada6b6f35325657cc96ba0372d8e3', 'the resource handoff must preserve the original manifest');
}

test('Tauri compiles Windows resources once with the existing icon and manifest', () => {
  validateWindowsResources(read('src-tauri/build.rs'));
});

test('resource guard rejects duplicate compilation, icon changes, and lost DPI declarations', () => {
  const build = read('src-tauri/build.rs');
  assert.throws(() => validateWindowsResources(`${build}\nwinres::WindowsResource::new().compile().unwrap();`), /second Windows resource/);
  assert.throws(() => validateWindowsResources(`${build}\ntauri_build::build();`), /exactly once/);
  assert.throws(() => validateWindowsResources(build.replace('icons/icon.ico', 'icons/other.ico')));
  assert.throws(() => validateWindowsResources(build.replace('PerMonitorV2', 'System')), /preserve the original manifest/);
});

test('manifest guard rejects test-only link arguments and MSVC flags leaking to other targets', () => {
  const build = read('src-tauri/build.rs');
  assert.throws(() => validateWindowsResources(build.replaceAll('cargo:rustc-link-arg=', 'cargo:rustc-link-arg-tests=')));
  assert.throws(() => validateWindowsResources(build.replace(' && target_env == "msvc"', '')));
  assert.throws(() => validateWindowsResources(build.replace('std::fs::write(&manifest_path, manifest)', 'std::fs::write(&manifest_path, "")')));
  assert.throws(() => validateWindowsResources(build.replace('new_without_app_manifest()', 'new()')));
});

function productionPolicy() {
  const build = read('src-tauri/build.rs');
  const handler = read('src-tauri/src/lib.rs').match(/generate_handler!\[([\s\S]*?)\]/);
  assert.ok(handler, 'the app must register an invoke handler');
  const manifest = build.match(/const APP_COMMANDS: &\[&str\] = &\[([\s\S]*?)\];/);
  assert.ok(manifest, 'declare every application command in APP_COMMANDS');
  assert.match(build, /AppManifest::new\(\)\.commands\(APP_COMMANDS\)/);
  const capabilitiesDirectory = path.join(root, 'src-tauri/capabilities');
  const capabilityFiles = fs.readdirSync(capabilitiesDirectory).filter((name) => /\.(json|toml)$/.test(name));
  // Deliberately fail closed if the format grows instead of skipping a new grant.
  assert.ok(capabilityFiles.every((name) => name.endsWith('.json')), 'audit TOML capabilities before adding them');
  const config = JSON.parse(read('src-tauri/tauri.conf.json'));
  assert.equal(config.app.security.capabilities, undefined, 'audit explicit/inline capability selection before adding it');
  return {
    registered: handler[1].split(',').map((name) => name.trim().split('::').at(-1)).filter(Boolean),
    generated: quoteValues(manifest[1]),
    capabilities: capabilityFiles.map((name) => JSON.parse(read(`src-tauri/capabilities/${name}`))),
  };
}

function grants(policy, label) {
  return new Set(policy.capabilities.filter((capability) => capability.windows.includes(label))
    .flatMap((capability) => capability.permissions)
    .filter((permission) => !permission.includes(':')));
}

const sharedWidget = ['get_settings', 'get_cached_stats', 'get_local_quota_providers', 'refresh_scan', 'focus_main_window', 'open_main_settings', 'gateway_routing_feed', 'gateway_external_feed'];
const surfaceCommands = {
  widget: [...sharedWidget, 'hide_widget_window', 'widget_pointer_hover'],
  'desktop-widget': [...sharedWidget, 'set_desktop_widget_enabled'],
  wallpaper: ['get_settings', 'get_cached_stats'],
};
// Retired with the settings 「API 配置」 section (U-99, T10.272); they must not come back unreviewed.
const retiredApiProfileCommands = [
  'inspect_api_profiles', 'upsert_api_profile', 'delete_api_profile', 'probe_api_profile',
  'cancel_api_profile_operation', 'inspect_codex_provider_switch', 'preview_codex_provider_switch',
  'apply_codex_provider_switch', 'restore_codex_provider_switch', 'inspect_agent_install_inventory',
];

function validatePolicy(policy) {
  assert.equal(new Set(policy.registered).size, policy.registered.length, 'duplicate invoke command');
  assert.equal(new Set(policy.generated).size, policy.generated.length, 'duplicate generated permission');
  assert.deepEqual(sorted(policy.generated), sorted(policy.registered), 'manifest and invoke handler must cover exactly the same commands');
  const available = new Set(policy.generated.map(allow));
  const identifiers = new Set();
  for (const capability of policy.capabilities) {
    assert.ok(!identifiers.has(capability.identifier), 'duplicate capability identifier');
    identifiers.add(capability.identifier);
    assert.equal(capability.remote, undefined, 'no remote origins');
    assert.notEqual(capability.local, false, 'local windows must retain their grants');
    assert.equal(capability.webviews, undefined, 'audit webview-specific grants before adding them');
    assert.equal(capability.platforms, undefined, 'app ACL must cover every desktop target');
    assert.ok(capability.windows.length > 0);
    for (const label of capability.windows) {
      assert.ok(['main', 'widget', 'desktop-widget', 'wallpaper'].includes(label), `unreviewed or wildcard window ${label}`);
    }
    for (const permission of capability.permissions) {
      assert.equal(typeof permission, 'string', 'audit scoped permission objects before adding them');
      if (!permission.startsWith('core:')) assert.ok(available.has(permission), `undefined app permission ${permission}`);
    }
  }
  assert.deepEqual(sorted(grants(policy, 'main')), sorted(available), 'main must retain all registered application commands');
  for (const [label, commands] of Object.entries(surfaceCommands)) {
    assert.deepEqual(sorted(grants(policy, label)), sorted(commands.map(allow)), `${label} must have only its audited app commands`);
  }
  for (const label of ['main-evil', 'widget-evil', 'wallpaper-evil', 'untrusted']) {
    assert.deepEqual([...grants(policy, label)], [], `${label} must not inherit permissions`);
  }
}

test('all 124 registered commands have generated permissions and exact per-window grants', () => {
  const policy = productionPolicy();
  assert.equal(policy.registered.length, 127, 'review the surface matrix when adding or removing an application command');
  validatePolicy(policy);
});

test('main retains dashboard, scanner, settings, database, quota, and sync entry points', () => {
  const main = grants(productionPolicy(), 'main');
  for (const command of ['get_cached_stats', 'refresh_scan', 'get_settings', 'save_settings', 'get_db_info', 'get_usage_details', 'get_local_behavior_analysis', 'get_local_session_analysis', 'get_cloud_status', 'save_cloud_config', 'sync_to_supabase', 'get_quota_providers', 'sync_quota_snapshots_now']) {
    assert.ok(main.has(allow(command)), `${command} must remain callable from main`);
  }
});

test('settings and data writes remain main-only across every capability', () => {
  const policy = productionPolicy();
  for (const label of ['widget', 'desktop-widget', 'wallpaper']) {
    const actual = grants(policy, label);
    for (const command of ['save_settings', 'save_cloud_config', 'sync_to_supabase', 'cleanup_db', 'clear_quota_snapshots', 'update_wallpaper', 'preview_wallpaper', 'preview_claude_statusline_setup', 'apply_claude_statusline_setup', 'restore_claude_statusline_setup', 'detect_quota_sources', 'get_quota_alert_settings', 'set_quota_alert_settings', 'list_quota_balance_sources', 'set_quota_balance_source', 'list_quota_experimental_plans', 'set_quota_experimental_plan', 'local_backup_export', 'local_backup_preview', 'local_backup_apply', 'local_backup_save_auto', 'local_backup_run_auto_now', 'local_backup_db_repair', 'local_backup_quit']) {
      assert.ok(!actual.has(allow(command)), `${label} must not call ${command}`);
    }
  }
});

test('quota alerts notify from Rust only: no webview holds notification plugin permissions', () => {
  const policy = productionPolicy();
  assert.match(read('src-tauri/src/lib.rs'), /\.plugin\(tauri_plugin_notification::init\(\)\)/);
  for (const capability of policy.capabilities) {
    for (const permission of capability.permissions) {
      assert.ok(!permission.startsWith('notification:'), `${capability.identifier} must not grant ${permission}`);
    }
  }
  const main = grants(policy, 'main');
  for (const command of ['get_quota_alert_settings', 'set_quota_alert_settings']) {
    assert.ok(main.has(allow(command)), `${command} must remain callable from main`);
  }
});

test('retired API profile commands are neither registered nor granted', () => {
  const policy = productionPolicy();
  for (const command of retiredApiProfileCommands) {
    assert.ok(!policy.registered.includes(command), `${command} was retired by T10.272`);
    assert.ok(!policy.generated.includes(command), `${command} must not keep a manifest entry`);
  }
  assert.ok(!policy.capabilities.some((capability) => capability.identifier === 'api-profiles-main-only'));
});

const gatewayCommands = [
  'gateway_set_model_access', 'gateway_status', 'gateway_list_providers', 'gateway_upsert_provider',
  'gateway_set_provider_key', 'gateway_delete_provider', 'gateway_recent_requests',
  'gateway_codex_inspect', 'gateway_codex_preview', 'gateway_codex_apply', 'gateway_codex_restore',
  'gateway_agent_inspect', 'gateway_agent_preview', 'gateway_agent_apply', 'gateway_agent_restore',
  'gateway_list_routing_groups', 'gateway_upsert_routing_group', 'gateway_delete_routing_group',
  'gateway_recent_route_decisions', 'gateway_routing_cooldowns', 'gateway_provider_health', 'gateway_reveal_local_token',
];

test('gateway provider and key management stays main-only', () => {
  const policy = productionPolicy();
  for (const label of ['widget', 'desktop-widget', 'wallpaper']) {
    const actual = grants(policy, label);
    for (const command of gatewayCommands) assert.ok(!actual.has(allow(command)), `${label} must not call ${command}`);
  }
  const gateway = policy.capabilities.find((capability) => capability.identifier === 'gateway-main-only');
  assert.deepEqual(gateway.windows, ['main']);
  assert.deepEqual(sorted(gateway.permissions), sorted(gatewayCommands.map(allow)));
});

function frontendInvocations(file) {
  return [...read(file).matchAll(/\binvoke(?:<[^;]*?>)?\s*\(\s*['"]([a-z][a-z0-9_]*)['"]/g)].map((match) => match[1]);
}

test('restricted grants cover actual widget and wallpaper callers and actual native labels', () => {
  const widgetCommands = new Set(frontendInvocations('src/components/WidgetView.tsx'));
  assert.deepEqual(sorted(widgetCommands), sorted(new Set([...surfaceCommands.widget, ...surfaceCommands['desktop-widget']])));
  assert.deepEqual(sorted(new Set(frontendInvocations('src/components/LiveWallpaperView.tsx'))), sorted(surfaceCommands.wallpaper));
  const nativeWidget = read('src-tauri/src/widget_window.rs');
  assert.match(nativeWidget, /pub const WIDGET_LABEL: &str = "widget";/);
  assert.match(nativeWidget, /pub const DESKTOP_WIDGET_LABEL: &str = "desktop-widget";/);
  assert.match(read('src-tauri/src/macos_wallpaper_window.rs'), /WebviewWindowBuilder::new\(\s*app_handle,\s*"wallpaper"/);
  const primaryWindow = JSON.parse(read('src-tauri/tauri.conf.json')).app.windows[0];
  assert.equal(primaryWindow.label ?? 'main', 'main');
});

test('regression guard rejects missing legacy registration or grants and privilege widening', () => {
  const withoutManifestEntry = productionPolicy();
  withoutManifestEntry.generated = withoutManifestEntry.generated.filter((command) => command !== 'get_cached_stats');
  assert.throws(() => validatePolicy(withoutManifestEntry), /manifest and invoke handler/);

  const withoutMainGrant = productionPolicy();
  for (const capability of withoutMainGrant.capabilities) {
    if (capability.windows.includes('main')) capability.permissions = capability.permissions.filter((permission) => permission !== 'allow-refresh-scan');
  }
  assert.throws(() => validatePolicy(withoutMainGrant), /main must retain/);

  const leakedGateway = productionPolicy();
  leakedGateway.capabilities.find((capability) => capability.identifier === 'gateway-main-only').windows.push('widget');
  assert.throws(() => validatePolicy(leakedGateway), /widget must have only/);

  const wildcard = productionPolicy();
  wildcard.capabilities.find((capability) => capability.identifier === 'main-app').windows = ['*'];
  assert.throws(() => validatePolicy(wildcard), /wildcard window/);

  const undefinedPermission = productionPolicy();
  undefinedPermission.capabilities[0].permissions.push('allow-missing-command');
  assert.throws(() => validatePolicy(undefinedPermission), /undefined app permission/);
});
