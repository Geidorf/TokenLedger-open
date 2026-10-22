//! Settings-page preview of the static desktop wallpaper (T10.279, U-103).
//!
//! Draws with the same statistics source, screen size and renderer as
//! `perform_wallpaper_update`, then downsizes in memory. It never writes a
//! file, never calls the system wallpaper setter and does not require the
//! wallpaper automation consent, so it cannot trigger an OS permission prompt.

use std::sync::Arc;

use image::codecs::png::PngEncoder;
use image::imageops::{self, FilterType};
use image::{ExtendedColorType, ImageEncoder, RgbaImage};
use serde::Serialize;

use super::{get_screen_size, render_desktop_wallpaper, resolve_wallpaper_stats};
use crate::app_paths::AppContext;
use crate::{db, settings};

/// Wide enough to stay sharp on a 2x display at the settings card width.
pub(crate) const PREVIEW_MAX_WIDTH: u32 = 960;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperPreview {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
    /// Size the real wallpaper is rendered at.
    pub screen_width: u32,
    pub screen_height: u32,
}

#[tauri::command]
pub async fn preview_wallpaper(
    state: tauri::State<'_, Arc<AppContext>>,
) -> Result<WallpaperPreview, String> {
    let app = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || preview_wallpaper_impl(&app))
        .await
        .map_err(|error| format!("wallpaper preview task panicked: {error}"))?
}

pub(crate) fn preview_wallpaper_impl(app: &AppContext) -> Result<WallpaperPreview, String> {
    let settings = settings::load_settings(app);
    let (width, height) = get_screen_size();
    let stats = resolve_wallpaper_stats(app, &settings)?;
    let image = render_desktop_wallpaper(stats.as_ref(), &db::get_db_path(app), width, height)?;
    encode_preview(&image)
}

pub(crate) fn preview_thumbnail(image: &RgbaImage) -> RgbaImage {
    let (width, height) = image.dimensions();
    if width <= PREVIEW_MAX_WIDTH {
        return image.clone();
    }
    let thumb_height = ((u64::from(height) * u64::from(PREVIEW_MAX_WIDTH) + u64::from(width) / 2)
        / u64::from(width))
    .max(1) as u32;
    imageops::resize(image, PREVIEW_MAX_WIDTH, thumb_height, FilterType::Triangle)
}

pub(crate) fn encode_png(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            ExtendedColorType::Rgba8,
        )
        .map_err(|error| format!("wallpaper preview encoding failed: {error}"))?;
    Ok(png)
}

pub(crate) fn encode_preview(image: &RgbaImage) -> Result<WallpaperPreview, String> {
    let thumb = preview_thumbnail(image);
    let png = encode_png(&thumb)?;
    Ok(WallpaperPreview {
        data_url: format!("data:image/png;base64,{}", base64_encode(&png)),
        width: thumb.width(),
        height: thumb.height(),
        screen_width: image.width(),
        screen_height: image.height(),
    })
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wallpaper::{self, WallStats};
    use chrono::{Local, TimeZone};
    use std::path::{Path, PathBuf};

    fn temp_context(label: &str) -> AppContext {
        let directory = std::env::temp_dir().join(format!(
            "tokenledger-wallpaper-preview-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ));
        AppContext::for_test(directory)
    }

    fn files_under(root: &Path) -> Vec<PathBuf> {
        let mut found = Vec::new();
        let mut pending = vec![root.to_path_buf()];
        while let Some(directory) = pending.pop() {
            for entry in std::fs::read_dir(&directory).expect("read dir").flatten() {
                let path = entry.path();
                if path.is_dir() {
                    pending.push(path);
                } else {
                    found.push(path);
                }
            }
        }
        found.sort();
        found
    }

    /// Tool and model splits each sum to `today_total` (input + output only).
    fn sample_stats() -> WallStats {
        let hourly: Vec<i64> = (0..24)
            .map(|hour| if hour <= 15 { 40_000 + hour * 9_000 } else { 0 })
            .collect();
        WallStats {
            today_total: hourly.iter().sum(),
            yesterday_total: 1_480_000,
            today_requests: 386,
            yesterday_requests: 342,
            hourly_trend: hourly,
            yesterday_hourly_trend: (0..24).map(|hour| 30_000 + hour * 4_000).collect(),
            tool_distribution: vec![
                ("claude".to_string(), 860_000),
                ("codex".to_string(), 650_000),
                ("cursor".to_string(), 210_000),
            ],
            model_ranking: vec![
                ("claude-sonnet-5".to_string(), 900_000),
                ("gpt-5.6".to_string(), 560_000),
                ("composer-2.5".to_string(), 260_000),
            ],
            heatmap: Vec::new(),
            generated_at: Local
                .with_ymd_and_hms(2026, 10, 4, 15, 30, 0)
                .single()
                .expect("fixed local time"),
        }
    }

    #[test]
    fn base64_matches_rfc4648_vectors() {
        for (input, expected) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64_encode(input.as_bytes()), expected);
        }
    }

    #[test]
    fn thumbnail_keeps_screen_ratio_and_never_upscales() {
        let wide = RgbaImage::new(1920, 1080);
        let thumb = preview_thumbnail(&wide);
        assert_eq!(thumb.dimensions(), (PREVIEW_MAX_WIDTH, 540));
        let preview = encode_preview(&RgbaImage::new(2560, 1600)).expect("encode");
        assert_eq!((preview.width, preview.height), (PREVIEW_MAX_WIDTH, 600));
        assert_eq!((preview.screen_width, preview.screen_height), (2560, 1600));
        assert!(preview.data_url.starts_with("data:image/png;base64,"));
        let small = RgbaImage::new(800, 500);
        assert_eq!(preview_thumbnail(&small).dimensions(), (800, 500));
    }

    #[test]
    fn preview_is_the_real_desktop_render_downscaled() {
        if !wallpaper::system_font_available() {
            eprintln!("skipping: no system font for the wallpaper renderer");
            return;
        }
        let stats = sample_stats();
        let (width, height) = get_screen_size();
        let real =
            render_desktop_wallpaper(Some(&stats), Path::new("unused.sqlite"), width, height)
                .expect("real render");
        let direct = wallpaper::draw_desktop_wallpaper_image_with_stats(&stats, width, height)
            .expect("direct render");
        assert_eq!(
            real.as_raw(),
            direct.as_raw(),
            "preview must reuse the update renderer"
        );
        let thumb = preview_thumbnail(&real);
        let png = encode_png(&thumb).expect("encode");
        let decoded = image::load_from_memory(&png).expect("decode").to_rgba8();
        assert_eq!(decoded.as_raw(), thumb.as_raw());
        if let Some(directory) = std::env::var_os("TOKENLEDGER_WALLPAPER_PREVIEW_EVIDENCE") {
            let directory = PathBuf::from(directory);
            std::fs::create_dir_all(&directory).expect("evidence dir");
            std::fs::write(directory.join("wallpaper-preview-thumb.png"), &png).expect("thumb");
            real.save(directory.join("wallpaper-real-render.png"))
                .expect("real");
        }
    }

    #[test]
    fn preview_has_no_file_or_settings_side_effects() {
        if !wallpaper::system_font_available() {
            eprintln!("skipping: no system font for the wallpaper renderer");
            return;
        }
        let app = temp_context("side-effects");
        db::init_db(&db::get_db_path(&app)).expect("init db");
        settings::save_settings_file(&app, &settings::AppSettings::default()).expect("settings");
        let before = files_under(app.app_data_dir());
        let settings_before = std::fs::read(app.app_data_dir().join("app_settings.json")).ok();

        let preview = preview_wallpaper_impl(&app).expect("local preview");

        assert!(preview.data_url.starts_with("data:image/png;base64,"));
        assert!(preview.width <= PREVIEW_MAX_WIDTH);
        assert_eq!(
            (preview.screen_width, preview.screen_height),
            get_screen_size()
        );
        assert!(!app.app_data_dir().join("wallpapers").exists());
        assert!(!app.app_data_dir().join("lockscreens").exists());
        let after = files_under(app.app_data_dir());
        assert!(
            after
                .iter()
                .all(|path| path.extension().is_none_or(|ext| ext != "png")),
            "preview must not write images: {after:?}"
        );
        let sqlite_sidecar = |path: &PathBuf| {
            let name = path.to_string_lossy();
            name.ends_with("-wal") || name.ends_with("-shm")
        };
        assert!(
            after
                .iter()
                .all(|path| before.contains(path) || sqlite_sidecar(path)),
            "preview must not create files: before={before:?} after={after:?}"
        );
        assert_eq!(
            std::fs::read(app.app_data_dir().join("app_settings.json")).ok(),
            settings_before
        );
        let _ = std::fs::remove_dir_all(app.app_data_dir());
    }
}
