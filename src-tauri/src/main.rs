// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--claude-statusline")) {
        let line = app_lib::run_claude_statusline_helper()
            .unwrap_or_else(|_| "Claude quota waiting".to_string());
        println!("{line}");
        return;
    }
    app_lib::run();
}
