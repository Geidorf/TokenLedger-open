use std::fs;
use std::path::{Path, PathBuf};

const APP_ID: &str = "com.jeidorf.tokenledger";

#[derive(Debug, Clone)]
pub struct AppContext {
    app_data_dir: PathBuf,
}

impl AppContext {
    pub fn new() -> Self {
        let app_data_dir = resolve_app_data_dir();
        let _ = fs::create_dir_all(&app_data_dir);
        Self { app_data_dir }
    }

    pub fn app_data_dir(&self) -> &Path {
        &self.app_data_dir
    }

    #[cfg(test)]
    pub(crate) fn for_test(app_data_dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&app_data_dir);
        Self { app_data_dir }
    }
}

impl Default for AppContext {
    fn default() -> Self {
        Self::new()
    }
}

pub(crate) fn resolve_app_data_dir() -> PathBuf {
    if let Some(path) = std::env::var_os("TOKENLEDGER_APPDATA") {
        return PathBuf::from(path);
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(path) = std::env::var_os("APPDATA") {
            return PathBuf::from(path).join(APP_ID);
        }
        dirs::data_dir()
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
            .join(APP_ID)
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join(APP_ID);
        }
        dirs::data_dir()
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
            .join(APP_ID)
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        dirs::data_dir()
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
            .join(APP_ID)
    }
}
