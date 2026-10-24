fn main() {
    // Keep one resource compiler for icons/version and one manifest per target.
    const WINDOWS_APP_MANIFEST: &str = r#"
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
      <supportedOS Id="{1f676c76-80e1-4239-95bb-83d0f6d0da78}"/>
      <supportedOS Id="{4a2f28e3-53b9-4441-ba9c-d69d4a4a6e38}"/>
      <supportedOS Id="{35138b9a-5d96-4fbd-8e2d-a2440225f93a}"/>
      <supportedOS Id="{e2011457-1546-43c5-a5fe-008deee3d3f0}"/>
    </application>
  </compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness>
    </windowsSettings>
  </application>
</assembly>
"#;

    // An application manifest enables ACL checks for ALL app commands. Keep this
    // list aligned with invoke_handler;
    // tests/tauri-command-acl.test.mjs verifies coverage and per-window grants.
    const APP_COMMANDS: &[&str] = &[
        "gateway_legacy_inspect",
        "gateway_legacy_restore",
        "gateway_set_model_access",
        "gateway_status",
        "gateway_list_providers",
        "gateway_upsert_provider",
        "gateway_set_provider_key",
        "gateway_delete_provider",
        "gateway_recent_requests",
        "gateway_codex_inspect",
        "gateway_codex_preview",
        "gateway_codex_apply",
        "gateway_codex_restore",
        "gateway_agent_inspect",
        "gateway_agent_preview",
        "gateway_agent_apply",
        "gateway_agent_restore",
        "gateway_list_routing_groups",
        "gateway_upsert_routing_group",
        "gateway_delete_routing_group",
        "gateway_recent_route_decisions",
        "gateway_routing_cooldowns",
        "gateway_provider_health",
        "gateway_routing_feed",
        "gateway_external_feed",
        "gateway_reveal_local_token",
        "get_app_version",
        "get_claude_statusline_command",
        "get_claude_quota_setup",
        "detect_quota_sources",
        "list_quota_balance_sources",
        "set_quota_balance_source",
        "list_quota_experimental_plans",
        "set_quota_experimental_plan",
        "preview_claude_statusline_setup",
        "apply_claude_statusline_setup",
        "restore_claude_statusline_setup",
        "get_settings",
        "save_settings",
        "autostart_supported",
        "get_cost_profile",
        "validate_cost_profile",
        "save_cost_profile",
        "clear_cost_profile",
        "get_quota_providers",
        "get_local_quota_providers",
        "retry_quota_providers",
        "retry_local_quota_providers",
        "list_custom_quota_endpoints",
        "upsert_custom_quota_endpoint",
        "delete_custom_quota_endpoint",
        "authorize_claude_native_quota",
        "authorize_antigravity_quota",
        "get_quota_alert_settings",
        "set_quota_alert_settings",
        "get_budget_settings",
        "set_budget_settings",
        "get_budget_status",
        "get_usage_anomalies",
        "get_usage_anomaly_settings",
        "set_usage_anomaly_settings",
        "get_quota_snapshot_sync_status",
        "set_quota_snapshot_sync_enabled",
        "sync_quota_snapshots_now",
        "delete_quota_snapshot_provider",
        "clear_quota_snapshots",
        "get_prices",
        "save_prices",
        "reset_prices",
        "get_price_migration_notice",
        "dismiss_price_migration_notice",
        "search_models_dev_prices",
        "get_db_info",
        "export_db_csv",
        "export_usage_csv",
        "cleanup_db",
        "reset_local_sync",
        "refresh_scan",
        "get_usage_details",
        "get_local_behavior_analysis",
        "get_project_dimension_status",
        "set_project_dimension",
        "rebuild_project_index",
        "magpie_import_status",
        "magpie_import_run",
        "magpie_import_clear",
        "peer_sync_get_config",
        "peer_sync_save_config",
        "peer_sync_clear_config",
        "peer_sync_preview",
        "peer_sync_import_providers",
        "peer_sync_shared_list",
        "peer_sync_shared_pull",
        "peer_sync_shared_clear",
        "local_backup_status",
        "local_backup_export",
        "local_backup_list",
        "local_backup_preview",
        "local_backup_apply",
        "local_backup_save_auto",
        "local_backup_run_auto_now",
        "local_backup_db_check",
        "local_backup_db_repair",
        "local_backup_quit",
        "peer_live_snapshot",
        "routing_publish_status",
        "get_local_session_analysis",
        "cancel_local_session_analysis",
        "get_entity_dashboard",
        "update_wallpaper",
        "preview_wallpaper",
        "get_cloud_config",
        "save_cloud_config",
        "get_cloud_status",
        "supabase_sign_in",
        "supabase_sign_up",
        "supabase_sign_out",
        "sync_to_supabase",
        "get_cached_stats",
        "cleanup_wallpaper",
        "reclaim_db_space",
        "show_widget_window",
        "hide_widget_window",
        "toggle_widget_window",
        "widget_pointer_hover",
        "set_desktop_widget_enabled",
        "focus_main_window",
        "open_main_settings",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(windows_attributes(WINDOWS_APP_MANIFEST))
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to build Tauri ACL manifest");
}

fn windows_attributes(manifest: &str) -> tauri_build::WindowsAttributes {
    // Build-script cfg describes the host; Cargo target variables also cover
    // cross-compilation and keep MSVC linker flags away from GNU/non-Windows.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").expect("Cargo target OS is required");
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os == "windows" && target_env == "msvc" {
        // tauri-winres links resources to bins only. Generic link-arg also reaches
        // the lib unit-test executable, which needs Common Controls v6 at load.
        let out_dir = std::env::var_os("OUT_DIR").expect("Cargo OUT_DIR is required");
        let manifest_path = std::path::PathBuf::from(out_dir).join("tokenledger-app-manifest.xml");
        std::fs::write(&manifest_path, manifest)
            .expect("failed to write Windows application manifest");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg=/MANIFESTINPUT:{}",
            manifest_path.display()
        );
        tauri_build::WindowsAttributes::new_without_app_manifest()
            .window_icon_path("icons/icon.ico")
    } else {
        tauri_build::WindowsAttributes::new()
            .window_icon_path("icons/icon.ico")
            .app_manifest(manifest)
    }
}
