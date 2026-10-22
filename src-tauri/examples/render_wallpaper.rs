// Standalone render harness for fast wallpaper-fidelity iteration.
// Usage: cargo run --example render_wallpaper -- <db_path> <out_dir> <width> <height>
use std::path::{Path, PathBuf};

#[allow(dead_code)]
#[path = "../src/wallpaper.rs"]
mod wallpaper;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let db_path = args.get(1).cloned().unwrap_or_else(|| {
        let base = std::env::var("APPDATA").unwrap_or_default();
        format!("{}/com.jeidorf.tokenledger/tokenboard.db", base)
    });
    let out_dir = args.get(2).cloned().unwrap_or_else(|| ".".to_string());
    let width: u32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(3440);
    let height: u32 = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(1440);

    let db = PathBuf::from(&db_path);
    println!(
        "DB: {}  out: {}  {}x{}",
        db.display(),
        out_dir,
        width,
        height
    );
    std::fs::create_dir_all(&out_dir).unwrap();

    if let Some(img2x) = wallpaper::draw_desktop_wallpaper_image(&db, width * 2, height * 2) {
        let img = image::imageops::resize(
            &img2x,
            width,
            height,
            image::imageops::FilterType::CatmullRom,
        );
        let p = Path::new(&out_dir).join("rs_desktop_new.png");
        img.save(&p).unwrap();
        println!("wrote {}", p.display());
    } else {
        eprintln!("desktop render failed");
    }

    if let Some(img2x) = wallpaper::draw_lockscreen_wallpaper_image(&db, width * 2, height * 2) {
        let img = image::imageops::resize(
            &img2x,
            width,
            height,
            image::imageops::FilterType::CatmullRom,
        );
        let p = Path::new(&out_dir).join("rs_lock_new.png");
        img.save(&p).unwrap();
        println!("wrote {}", p.display());
    } else {
        eprintln!("lockscreen render failed");
    }
}
