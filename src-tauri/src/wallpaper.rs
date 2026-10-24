use ab_glyph::{Font, FontRef, ScaleFont};
use chrono::{DateTime, Datelike, Duration, Local, NaiveDateTime, Timelike};
use image::{ImageBuffer, Rgba, RgbaImage};
use std::fs;
use std::path::Path;
use std::sync::OnceLock;

// ============ COLOR CONFIG ============
const BG_TOP: Rgba<u8> = Rgba([22, 22, 28, 255]);
const BG_BOTTOM: Rgba<u8> = Rgba([6, 6, 10, 255]);
const TEXT_PRIMARY: Rgba<u8> = Rgba([245, 245, 247, 255]);
const TEXT_SECONDARY: Rgba<u8> = Rgba([174, 174, 180, 255]);

// APPLE_BLUE/APPLE_GREEN/APPLE_INDIGO/APPLE_PURPLE/APPLE_PINK removed
// (T10.195, T10.190 plan §4 P9 / §6.8): the trend line, model-ranking bar,
// change pill and background glow now draw from the non-tool accent
// constants ACCENT_PRIMARY/ACCENT_AXIS/ACCENT_NEUTRAL (defined near
// TOOL_CHART_SLOT_COLORS_DARK below, but — after the T10.195 review's P3-4
// fix round — deliberately NOT aliased to it, so a future edit to the tool
// slot table cannot silently recolour a non-tool element) instead of Apple
// system colours. APPLE_ORANGE/APPLE_YELLOW/APPLE_TEAL were already removed
// in T10.187; that change's only use was hud_tool_color's old, now-replaced
// Apple-colour table (T10.178 review P2-7).

// ============ WORDING (T10.195, T10.190 plan §6.8) ============
/// The headline metric on both the static wallpaper and the Windows lock
/// screen. Replaces the retired "今日消耗"/"今日使用 … Tokens" labels
/// (GLB-01: 有效 Token = input + output; cache stays a separate line and is
/// never folded into this number).
const METRIC_LABEL_EFFECTIVE_TOKENS: &str = "有效 Token";
/// Replaces the retired "请求次数"/"请求" label (GLB-02: the ledger-row count
/// is called 记录数 everywhere, not "请求次数").
const METRIC_LABEL_RECORD_COUNT: &str = "记录数";
/// The change pill's caption. Replaces "较昨日"/"对比昨日"/"vs 昨日": all three
/// named labels compared "today so far" against the whole of yesterday, which
/// is not a same-bucket comparison (GLB-01). The query behind this label is
/// cut at the same local time of day as "now" — see
/// `yesterday_same_time_window`.
const COMPARE_LABEL: &str = "较昨日同期";
/// Shown in place of a value or a change percentage that cannot be produced
/// honestly: either the read itself failed, or (for the change pill) there is
/// no baseline to compare against. Never replaced with a fake 0 (T10.190 plan
/// §4 P9).
const UNKNOWN_TEXT: &str = "不可得";

// ============ PIXEL DRAWING HELPERS ============

type PixelRect = (i32, i32, i32, i32);

/// Blend two colors with alpha.
#[inline]
fn blend_colors(bg: Rgba<u8>, fg: Rgba<u8>, fg_alpha: u8) -> Rgba<u8> {
    let a_fg = fg_alpha as f32 / 255.0;
    let a_bg = bg[3] as f32 / 255.0;
    let out_a = a_fg + a_bg * (1.0 - a_fg);
    if out_a == 0.0 {
        return Rgba([0, 0, 0, 0]);
    }
    let r = (fg[0] as f32 * a_fg + bg[0] as f32 * a_bg * (1.0 - a_fg)) / out_a;
    let g = (fg[1] as f32 * a_fg + bg[1] as f32 * a_bg * (1.0 - a_fg)) / out_a;
    let b = (fg[2] as f32 * a_fg + bg[2] as f32 * a_bg * (1.0 - a_fg)) / out_a;
    Rgba([r as u8, g as u8, b as u8, (out_a * 255.0) as u8])
}

/// Draws vertical background gradient.
fn draw_vertical_gradient(img: &mut RgbaImage, top: Rgba<u8>, bottom: Rgba<u8>) {
    let h = img.height();
    let w = img.width();
    for y in 0..h {
        let t = y as f32 / (h - 1) as f32;
        let color = Rgba([
            (top[0] as f32 + (bottom[0] as f32 - top[0] as f32) * t) as u8,
            (top[1] as f32 + (bottom[1] as f32 - top[1] as f32) * t) as u8,
            (top[2] as f32 + (bottom[2] as f32 - top[2] as f32) * t) as u8,
            255,
        ]);
        for x in 0..w {
            img.put_pixel(x, y, color);
        }
    }
}

/// Draws soft radial gradient (ambient blur blob).
fn draw_ambient_blob(
    img: &mut RgbaImage,
    cx: i32,
    cy: i32,
    radius: i32,
    color: Rgba<u8>,
    max_alpha: u8,
) {
    let w = img.width() as i32;
    let h = img.height() as i32;

    let x_start = (cx - radius).max(0);
    let x_end = (cx + radius).min(w - 1);
    let y_start = (cy - radius).max(0);
    let y_end = (cy + radius).min(h - 1);

    let radius_f = radius as f32;

    for y in y_start..=y_end {
        for x in x_start..=x_end {
            let dx = x - cx;
            let dy = y - cy;
            let dist = ((dx * dx + dy * dy) as f32).sqrt();
            if dist < radius_f {
                let factor = (1.0 - dist / radius_f).powf(1.6);
                let alpha = (max_alpha as f32 * factor) as u8;
                if alpha > 0 {
                    let pixel = img.get_pixel_mut(x as u32, y as u32);
                    *pixel = blend_colors(*pixel, color, alpha);
                }
            }
        }
    }
}

/// Helper to render rounded rectangle cards.
fn draw_card(
    img: &mut RgbaImage,
    bounds: PixelRect,
    radius: i32,
    fill: Rgba<u8>,
    border: Rgba<u8>,
) {
    let (x1, y1, x2, y2) = bounds;
    let w = img.width() as i32;
    let h = img.height() as i32;

    let card_w = x2 - x1;
    let card_h = y2 - y1;
    let half_w = card_w as f32 / 2.0;
    let half_h = card_h as f32 / 2.0;
    // A full capsule/pill (e.g. the model-ranking bar and the change-pill
    // background, both drawn with `radius = height / 2`) has `radius` exactly
    // equal to `half_h`; clamping here keeps the SDF below well-defined for
    // that case and for any caller that over-specifies the radius.
    let r_f = (radius as f32).max(0.0).min(half_w).min(half_h);
    let center_x = x1 as f32 + half_w;
    let center_y = y1 as f32 + half_h;

    let x_start = x1.max(0);
    let x_end = x2.min(w - 1);
    let y_start = y1.max(0);
    let y_end = y2.min(h - 1);

    for y in y_start..=y_end {
        for x in x_start..=x_end {
            let px = x as f32;
            let py = y as f32;

            // Signed distance to the rounded-rect boundary (<= 0 is inside),
            // via the standard rounded-box SDF (Inigo Quilez's `sdRoundBox`):
            // clamp each axis to >= 0 *before* combining them, rather than the
            // previous ad hoc branch on `dx > 0 && dy > 0`. The old branch
            // treated a point as "in the rounded corner" whenever both axes
            // were past the straight-edge zone — but when `radius == half_h`
            // (this capsule case), `half_h - r_f` is 0, so `qy` is >= 0 for
            // almost every row, misclassifying nearly the whole shape as
            // "corner" and letting the border colour (or a no-op transparent
            // border) cover the entire card instead of a thin ring (T10.210;
            // this is what made the model-ranking bar fail to draw at all).
            let qx = (px - center_x).abs() - (half_w - r_f);
            let qy = (py - center_y).abs() - (half_h - r_f);
            let dist = qx.max(0.0).hypot(qy.max(0.0)) + qx.max(qy).min(0.0) - r_f;

            if dist <= 0.0 {
                let pixel = img.get_pixel_mut(x as u32, y as u32);
                let on_border = dist > -1.5;
                if on_border {
                    *pixel = blend_colors(*pixel, border, border[3]);
                } else {
                    *pixel = blend_colors(*pixel, fill, fill[3]);
                }
            }
        }
    }
}

/// Draw a straight line with arbitrary thickness and alpha.
fn draw_line(
    img: &mut RgbaImage,
    x1: f32,
    y1: f32,
    x2: f32,
    y2: f32,
    color: Rgba<u8>,
    thickness: f32,
) {
    let w = img.width() as i32;
    let h = img.height() as i32;

    let min_x = (x1.min(x2) - thickness).floor() as i32;
    let max_x = (x1.max(x2) + thickness).ceil() as i32;
    let min_y = (y1.min(y2) - thickness).floor() as i32;
    let max_y = (y1.max(y2) + thickness).ceil() as i32;

    let min_x = min_x.max(0);
    let max_x = max_x.min(w - 1);
    let min_y = min_y.max(0);
    let max_y = max_y.min(h - 1);

    let l_vec_x = x2 - x1;
    let l_vec_y = y2 - y1;
    let l_len_sq = l_vec_x * l_vec_x + l_vec_y * l_vec_y;

    if l_len_sq == 0.0 {
        return;
    }

    for y in min_y..=max_y {
        for x in min_x..=max_x {
            let px = x as f32;
            let py = y as f32;

            let t = ((px - x1) * l_vec_x + (py - y1) * l_vec_y) / l_len_sq;
            let t_clamped = t.clamp(0.0, 1.0);

            let proj_x = x1 + t_clamped * l_vec_x;
            let proj_y = y1 + t_clamped * l_vec_y;

            let dx = px - proj_x;
            let dy = py - proj_y;
            let dist = (dx * dx + dy * dy).sqrt();

            if dist <= thickness {
                let alpha = if dist > thickness - 1.0 {
                    ((thickness - dist) * color[3] as f32) as u8
                } else {
                    color[3]
                };
                let pixel = img.get_pixel_mut(x as u32, y as u32);
                *pixel = blend_colors(*pixel, color, alpha);
            }
        }
    }
}

/// Draw a hollow donut chart segment using trigonometry.
fn draw_donut(
    img: &mut RgbaImage,
    cx: i32,
    cy: i32,
    inner_r: f32,
    outer_r: f32,
    slices: &[(f32, Rgba<u8>)],
) {
    let w = img.width() as i32;
    let h = img.height() as i32;

    let bounding_r = outer_r + 2.0;
    let x_start = (cx - bounding_r as i32).max(0);
    let x_end = (cx + bounding_r as i32).min(w - 1);
    let y_start = (cy - bounding_r as i32).max(0);
    let y_end = (cy + bounding_r as i32).min(h - 1);

    let cx_f = cx as f32;
    let cy_f = cy as f32;

    let total_val: f32 = slices.iter().map(|s| s.0).sum();
    if total_val == 0.0 {
        return;
    }

    let mut angle_bounds = Vec::new();
    let mut current_angle = -std::f32::consts::FRAC_PI_2; // Start from top
    for slice in slices {
        let sweep = (slice.0 / total_val) * 2.0 * std::f32::consts::PI;
        angle_bounds.push((current_angle, current_angle + sweep, slice.1));
        current_angle += sweep;
    }

    for y in y_start..=y_end {
        for x in x_start..=x_end {
            let dx = x as f32 - cx_f;
            let dy = y as f32 - cy_f;
            let dist = (dx * dx + dy * dy).sqrt();

            if dist >= inner_r && dist <= outer_r {
                let mut angle = dy.atan2(dx);
                if angle < -std::f32::consts::FRAC_PI_2 {
                    angle += 2.0 * std::f32::consts::PI;
                }

                for &(start, end, color) in &angle_bounds {
                    if angle >= start && angle < end {
                        let mut alpha = color[3];
                        if dist < inner_r + 1.0 {
                            alpha = ((dist - inner_r) * color[3] as f32) as u8;
                        } else if dist > outer_r - 1.0 {
                            alpha = ((outer_r - dist) * color[3] as f32) as u8;
                        }

                        let pixel = img.get_pixel_mut(x as u32, y as u32);
                        *pixel = blend_colors(*pixel, color, alpha);
                        break;
                    }
                }
            }
        }
    }
}

/// Draw filled polygon using ray casting (even-odd rule)
fn draw_polygon(img: &mut RgbaImage, points: &[(f32, f32)], color: Rgba<u8>) {
    if points.len() < 3 {
        return;
    }
    let w = img.width() as i32;
    let h = img.height() as i32;

    let mut min_x = w as f32;
    let mut max_x = 0.0_f32;
    let mut min_y = h as f32;
    let mut max_y = 0.0_f32;
    for &p in points {
        min_x = min_x.min(p.0);
        max_x = max_x.max(p.0);
        min_y = min_y.min(p.1);
        max_y = max_y.max(p.1);
    }

    let x_start = (min_x.floor() as i32).max(0);
    let x_end = (max_x.ceil() as i32).min(w - 1);
    let y_start = (min_y.floor() as i32).max(0);
    let y_end = (max_y.ceil() as i32).min(h - 1);

    for y in y_start..=y_end {
        for x in x_start..=x_end {
            let px = x as f32;
            let py = y as f32;

            let mut inside = false;
            let mut j = points.len() - 1;
            for i in 0..points.len() {
                let pi = points[i];
                let pj = points[j];
                if ((pi.1 > py) != (pj.1 > py))
                    && (px < (pj.0 - pi.0) * (py - pi.1) / (pj.1 - pi.1 + 0.00001) + pi.0)
                {
                    inside = !inside;
                }
                j = i;
            }

            if inside {
                let pixel = img.get_pixel_mut(x as u32, y as u32);
                *pixel = blend_colors(*pixel, color, color[3]);
            }
        }
    }
}

/// Draw a filled circle.
fn draw_circle(img: &mut RgbaImage, cx: i32, cy: i32, r: i32, color: Rgba<u8>) {
    let w = img.width() as i32;
    let h = img.height() as i32;
    for dy in -r..=r {
        for dx in -r..=r {
            if dx * dx + dy * dy <= r * r {
                let px = cx + dx;
                let py = cy + dy;
                if px >= 0 && px < w && py >= 0 && py < h {
                    let pixel = img.get_pixel_mut(px as u32, py as u32);
                    *pixel = blend_colors(*pixel, color, color[3]);
                }
            }
        }
    }
}

/// Draw dotted line along a series of points.
fn draw_dotted_line(
    img: &mut RgbaImage,
    points: &[(f32, f32)],
    color: Rgba<u8>,
    dot_spacing: f32,
    dot_r: f32,
) {
    if points.len() < 2 {
        return;
    }
    let mut distance_accumulator = 0.0;
    for i in 0..(points.len() - 1) {
        let p1 = points[i];
        let p2 = points[i + 1];
        let dx = p2.0 - p1.0;
        let dy = p2.1 - p1.1;
        let len = (dx * dx + dy * dy).sqrt();
        if len == 0.0 {
            continue;
        }
        let ux = dx / len;
        let uy = dy / len;
        let mut t = 0.0;
        while t < len {
            if distance_accumulator <= 0.0 {
                let px = p1.0 + t * ux;
                let py = p1.1 + t * uy;
                draw_circle(img, px as i32, py as i32, dot_r as i32, color);
                distance_accumulator = dot_spacing;
            }
            t += 1.0;
            distance_accumulator -= 1.0;
        }
    }
}

/// Draw dashed line between two points.
fn draw_dashed_line(
    img: &mut RgbaImage,
    start: (f32, f32),
    end: (f32, f32),
    color: Rgba<u8>,
    pattern: (f32, f32),
    thickness: f32,
) {
    let (x1, y1) = start;
    let (x2, y2) = end;
    let (dash_len, gap_len) = pattern;
    let dx = x2 - x1;
    let dy = y2 - y1;
    let len = (dx * dx + dy * dy).sqrt();
    if len == 0.0 {
        return;
    }
    let ux = dx / len;
    let uy = dy / len;
    let mut t = 0.0;
    let mut drawing = true;
    while t < len {
        let step = if drawing { dash_len } else { gap_len };
        let next_t = (t + step).min(len);
        if drawing {
            draw_line(
                img,
                x1 + t * ux,
                y1 + t * uy,
                x1 + next_t * ux,
                y1 + next_t * uy,
                color,
                thickness,
            );
        }
        t = next_t;
        drawing = !drawing;
    }
}

/// Draw a horizontal line segment (optimized).
fn draw_line_horizontal(img: &mut RgbaImage, x1: i32, x2: i32, y: i32, color: Rgba<u8>, alpha: u8) {
    let w = img.width() as i32;
    let h = img.height() as i32;
    if y >= 0 && y < h {
        let start = x1.max(0).min(w - 1) as u32;
        let end = x2.max(0).min(w - 1) as u32;
        for x in start..=end {
            let pixel = img.get_pixel_mut(x, y as u32);
            *pixel = blend_colors(*pixel, color, alpha);
        }
    }
}

// ============ FONT TEXT DRAWING ============

fn load_system_font() -> Option<Vec<u8>> {
    let font_paths = if cfg!(target_os = "windows") {
        vec![
            "C:\\Windows\\Fonts\\msyhbd.ttc",
            "C:\\Windows\\Fonts\\msyhbd.ttf",
            "C:\\Windows\\Fonts\\segoeuib.ttf",
            "C:\\Windows\\Fonts\\arialbd.ttf",
            "C:\\Windows\\Fonts\\msyh.ttc",
            "C:\\Windows\\Fonts\\msyh.ttf",
            "C:\\Windows\\Fonts\\simhei.ttf",
            "C:\\Windows\\Fonts\\arial.ttf",
        ]
    } else if cfg!(target_os = "macos") {
        vec![
            "/System/Library/Fonts/PingFang.ttc",
            "/System/Library/Fonts/STHeiti Light.ttc",
            "/Library/Fonts/Arial Unicode.ttf",
        ]
    } else {
        vec![
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
        ]
    };

    for path in font_paths {
        if let Ok(data) = fs::read(path) {
            return Some(data);
        }
    }
    None
}

#[cfg(test)]
pub(crate) fn system_font_available() -> bool {
    load_system_font().is_some()
}

fn draw_text(
    img: &mut RgbaImage,
    font: &FontRef,
    text: &str,
    x: i32,
    y: i32,
    scale: f32,
    color: Rgba<u8>,
) -> f32 {
    let scaled_font = font.as_scaled(scale);
    let mut px = x as f32;

    for c in text.chars() {
        let glyph = scaled_font.scaled_glyph(c);
        let outline = scaled_font.outline_glyph(glyph);
        if let Some(outlined) = outline {
            let bounds: ab_glyph::Rect = outlined.px_bounds();
            outlined.draw(|gx: u32, gy: u32, g_alpha: f32| {
                let gx = (px + bounds.min.x + gx as f32) as i32;
                let gy = (y as f32 + bounds.min.y + gy as f32) as i32;
                if gx >= 0 && gx < img.width() as i32 && gy >= 0 && gy < img.height() as i32 {
                    let pixel = img.get_pixel_mut(gx as u32, gy as u32);
                    let src_a = (g_alpha * color[3] as f32) as u8;
                    if src_a > 0 {
                        *pixel = blend_colors(*pixel, color, src_a);
                    }
                }
            });
        }
        px += scaled_font.h_advance(scaled_font.glyph_id(c));
    }
    px
}

fn draw_text_top_left(
    img: &mut RgbaImage,
    font: &FontRef,
    text: &str,
    x: i32,
    y: i32,
    scale: f32,
    color: Rgba<u8>,
) -> f32 {
    let ascent = font.as_scaled(scale).ascent();
    draw_text(img, font, text, x, y + ascent.round() as i32, scale, color)
}

/// Draw a section header: a colored dot followed by title text, with the dot
/// vertically centered against the text's cap-height (baseline - 0.34*scale).
/// `baseline_y` is the text baseline (matches `draw_text`). Returns the x where
/// the title ends.
fn draw_dot_title(
    img: &mut RgbaImage,
    font: &FontRef,
    position: (i32, i32),
    dot_layout: (i32, i32),
    title: &str,
    scale: f32,
    colors: (Rgba<u8>, Rgba<u8>),
) -> f32 {
    let (x, baseline_y) = position;
    let (dot_d, gap) = dot_layout;
    let (dot_color, text_color) = colors;
    let dot_center_y = baseline_y - (scale * 0.34) as i32;
    draw_circle(img, x + dot_d / 2, dot_center_y, dot_d / 2, dot_color);
    draw_text(
        img,
        font,
        title,
        x + dot_d + gap,
        baseline_y,
        scale,
        text_color,
    )
}

fn text_width(font: &FontRef, text: &str, scale: f32) -> f32 {
    let scaled_font = font.as_scaled(scale);
    let mut width = 0.0;
    for c in text.chars() {
        width += scaled_font.h_advance(scaled_font.glyph_id(c));
    }
    width
}

fn fit_font_size(font: &FontRef, text: &str, base_size: f32, max_w: f32, min_size: f32) -> f32 {
    let mut size = base_size;
    while size > min_size {
        if text_width(font, text, size) <= max_w {
            break;
        }
        size -= 1.0;
    }
    size
}

fn truncate_text(font: &FontRef, text: &str, scale: f32, max_w: f32) -> String {
    let mut s = text.to_string();
    if text_width(font, &s, scale) <= max_w {
        return s;
    }
    while !s.is_empty() && text_width(font, &format!("{}...", s), scale) > max_w {
        s.pop();
    }
    if s.is_empty() {
        "...".to_string()
    } else {
        format!("{}...", s)
    }
}

// ============ STATS FETCHING ============

/// Sentinel for "this scalar failed to read" on `WallStats`'s `i64` fields
/// (T10.190 plan §4 P9: the previous `unwrap_or(0)` on this path silently
/// drew a failed read as a real zero). Not a value either field can hold
/// honestly: both are sums/counts over non-negative columns, so they are
/// always `>= 0`. `i64::MIN` also makes any accidental *unguarded* arithmetic
/// on it overflow-panic immediately in a debug build instead of quietly
/// producing a small, wrong-looking number.
///
/// `Option<i64>` would be the more idiomatic shape for "may have failed to
/// read", but these fields must stay plain `i64`:
/// `commands/mod.rs::wallstats_from_dashboard_json` builds a `WallStats`
/// struct literal with concrete `i64` values for the cloud-wallpaper path
/// (narrow claim extension, T10.195 review P1-1 fix round), and changing
/// these fields' types would ripple well beyond that path. Read these fields
/// through `format_known_tokens` / `format_known_count` / `ChangeBadge`
/// rather than comparing to `STAT_UNKNOWN` ad hoc at each call site.
/// `pub(crate)` (not private) since P1-1 needs it from `commands::mod` to
/// mark the cloud "yesterday" scalars unknown when the merged dashboard
/// JSON's `comparison` is missing or has the wrong `window.kind` — the read
/// itself did not produce a usable answer. A cloud-side 0/0 "unprovable
/// baseline" is a *different* state: see `STAT_BASELINE_MISSING` (T10.210).
pub(crate) const STAT_UNKNOWN: i64 = i64::MIN;

/// The cloud comparison RPC answered, `window.kind` was the expected
/// `dayOverDay`, but `previous.summary` read back as exactly 0 tokens AND 0
/// requests — REQUIREMENTS REQ-COMP-01 treats that as "cannot prove a
/// baseline exists" (a real, successfully-read local previous-day 0 is a
/// valid baseline and never produces this), distinct from `STAT_UNKNOWN`
/// (the read itself failed or was malformed). The change pill renders this as
/// "基线缺失" — not `UNKNOWN_TEXT` ("不可得"), which the dashboard already
/// keeps separate; the wallpaper conflated the two before T10.210 (T10.195
/// review P3-8 / root R-58, R-65). Only ever produced by
/// `commands::cloud_day_over_day_previous_scalars`; the local SQL path
/// (`fetch_stats_at` below) never returns it.
pub(crate) const STAT_BASELINE_MISSING: i64 = i64::MIN + 1;

pub struct WallStats {
    /// `input_tokens + output_tokens` summed over today so far (T10.190 plan
    /// §2.4: effective-token accounting is correct here). `STAT_UNKNOWN` means
    /// the read failed; render with `format_known_tokens`, never as a bare 0.
    pub today_total: i64,
    /// Same sum, but for yesterday, cut at the same local time of day as "now"
    /// (GLB-01 same-bucket rule). A real `0` is valid here — it means "no
    /// matching records in that window", i.e. no baseline for the change pill
    /// — and is different from `STAT_UNKNOWN` (the read itself failed) and
    /// from `STAT_BASELINE_MISSING` (the cloud RPC answered but could not
    /// prove a previous-period baseline exists; local reads never produce it).
    pub yesterday_total: i64,
    pub today_requests: i64,
    pub yesterday_requests: i64,
    pub hourly_trend: Vec<i64>,
    pub yesterday_hourly_trend: Vec<i64>,
    pub tool_distribution: Vec<(String, i64)>,
    pub model_ranking: Vec<(String, i64)>,
    pub heatmap: Vec<(String, i64)>,
    /// The wall-clock instant these stats were generated at (T10.195 review
    /// P3-2): every `draw_*` function that needs "now" (the trend panel's
    /// clock/date/current-time marker, the heatmap's "today" cell, the
    /// lock-screen rhythm chart's current-hour cutoff) reads this field
    /// instead of calling `Local::now()` independently. Before this fix a
    /// wallpaper refresh that crossed midnight between `fetch_stats_at`'s
    /// query and the drawing pass could show a number computed for one day
    /// next to a clock/heatmap-highlight for the next.
    pub generated_at: DateTime<Local>,
}

/// The half-open `[yesterday 00:00:00, yesterday <cutoff>)` window for the
/// change pill's "yesterday" side, where `<cutoff>` is `now`'s own
/// hour:minute:second (GLB-01: comparisons must use the same bucket
/// definition, so "today so far" is compared against "yesterday, up to the
/// same time of day" rather than the whole of yesterday — T10.190 plan §4
/// P9).
///
/// Pure function of `now`'s already-local wall-clock date/time fields: no UTC
/// round-trip, so a DST gap/overlap in the host's timezone cannot shift
/// either bound (a gap simply means no row can carry the skipped wall-clock
/// timestamps; an overlap means two instants share one wall-clock string,
/// same as every other timestamp comparison already in this file).
/// `token_logs.timestamp` is itself stored as this kind of naive local
/// string, with no UTC offset, so this matches what is actually on disk.
fn yesterday_same_time_window(now: NaiveDateTime) -> (String, String) {
    let yesterday_date = (now.date() - Duration::days(1)).format("%Y-%m-%d");
    let cutoff_time = now.format("%H:%M:%S");
    (
        format!("{yesterday_date} 00:00:00"),
        format!("{yesterday_date} {cutoff_time}"),
    )
}

pub fn fetch_stats(db_path: &Path) -> WallStats {
    fetch_stats_at(db_path, Local::now())
}

/// `now`-parameterised core of `fetch_stats`, so tests can pin the clock
/// instead of depending on the wall clock: the yesterday-vs-today change pill
/// must compare the same time-of-day bucket (GLB-01), and exercising the
/// cutoff, midnight and no-baseline edge cases needs deterministic control
/// over "now".
// Generic over the timezone (T10.195 review P3-6): every use of `now` below
// this point goes through `.naive_local()` (plain wall-clock fields, already
// timezone-erased) or, for `generated_at`, `.with_timezone(&Local)` — so a
// caller can drive the SQL window/boundary math end-to-end with a real
// `chrono_tz` instant (see the spring-forward/fall-back test), not just with
// a hand-built `NaiveDateTime` fed straight to `yesterday_same_time_window`.
// `fetch_stats`, the public entry point, still always passes `Local::now()`;
// `generated_at` (what every `draw_*` function reads as "now" for rendering,
// P3-2) stays `DateTime<Local>` either way, since those functions are not
// themselves generic and do not need to be — only the query boundaries did.
fn fetch_stats_at<Tz: chrono::TimeZone>(db_path: &Path, now: DateTime<Tz>) -> WallStats {
    let mut stats = WallStats {
        today_total: STAT_UNKNOWN,
        yesterday_total: STAT_UNKNOWN,
        today_requests: STAT_UNKNOWN,
        yesterday_requests: STAT_UNKNOWN,
        hourly_trend: vec![0; 24],
        yesterday_hourly_trend: vec![0; 24],
        tool_distribution: Vec::new(),
        model_ranking: Vec::new(),
        heatmap: Vec::new(),
        generated_at: now.with_timezone(&Local),
    };

    // wallpaper.rs 还会被 examples/render_wallpaper.rs 以 #[path] 独立编译，
    // 不能引用 crate::db；这里内联与 db::get_connection 相同的连接参数。
    let conn = match rusqlite::Connection::open(db_path) {
        Ok(c) => c,
        Err(_) => return stats,
    };
    if conn
        .busy_timeout(std::time::Duration::from_secs(5))
        .is_err()
    {
        return stats;
    }
    let _ = conn.pragma_update(None, "synchronous", "NORMAL");

    // Naive (offset-free) local wall-clock fields only, derived once from the
    // injected `now` — every query below binds against these, never against
    // a fresh call to the wall clock.
    let now_naive = now.naive_local();
    let today = now_naive.format("%Y-%m-%d").to_string();
    // Full wall-clock string for `now`, used as the inclusive upper bound on
    // every "today" query below (T10.195 review P2-3): without it, "today"
    // ran open-ended and could pick up a row timestamped later than `now`
    // (e.g. a clock skew, or a test/fixture row seeded in the future),
    // showing a bigger number than the dashboard's own `query_bounds`
    // (`current_end = now` for `StatsRange::Today`, commands/mod.rs) would.
    let now_full = now_naive.format("%Y-%m-%d %H:%M:%S").to_string();
    let yesterday_date = (now_naive.date() - Duration::days(1))
        .format("%Y-%m-%d")
        .to_string();
    let (yesterday_from, yesterday_to) = yesterday_same_time_window(now_naive);
    let token_total_expr = "input_tokens + output_tokens";

    // 1. Today summary. Fields are left at STAT_UNKNOWN (never a fake 0)
    // unless a row is actually read back (T10.190 plan §4 P9).
    let today_query = format!(
        "SELECT COALESCE(SUM({}), 0), COUNT(*) FROM token_logs WHERE timestamp >= ? || ' 00:00:00' AND timestamp <= ?",
        token_total_expr
    );
    if let Ok(mut stmt) = conn.prepare(&today_query) {
        if let Ok(mut rows) = stmt.query([&today, &now_full]) {
            if let Ok(Some(row)) = rows.next() {
                if let Ok(v) = row.get::<_, i64>(0) {
                    stats.today_total = v;
                }
                if let Ok(v) = row.get::<_, i64>(1) {
                    stats.today_requests = v;
                }
            }
        }
    }

    // 2. Yesterday summary, cut at the same local time of day as `now`
    // (GLB-01 same-bucket comparison; T10.190 plan §4 P9 — the old query ran
    // all the way to yesterday's midnight, comparing "today so far" against
    // the whole of yesterday). A genuine `0` here — no matching rows in the
    // window — is a real reading, not a failure; it means the change pill has
    // no baseline (handled by `ChangeBadge::classify`). The upper bound is
    // inclusive (T10.195 review P2-3): the dashboard's own `comparison_period`
    // (commands/mod.rs) only skips a row when its timestamp is strictly
    // outside `[window_start, window_end]`, so a row landing exactly on the
    // cutoff instant counts on both sides of the same-time-of-day comparison.
    let yesterday_query = format!(
        "SELECT COALESCE(SUM({}), 0), COUNT(*) FROM token_logs WHERE timestamp >= ? AND timestamp <= ?",
        token_total_expr
    );
    if let Ok(mut stmt) = conn.prepare(&yesterday_query) {
        if let Ok(mut rows) = stmt.query([&yesterday_from, &yesterday_to]) {
            if let Ok(Some(row)) = rows.next() {
                if let Ok(v) = row.get::<_, i64>(0) {
                    stats.yesterday_total = v;
                }
                if let Ok(v) = row.get::<_, i64>(1) {
                    stats.yesterday_requests = v;
                }
            }
        }
    }

    // 3. Hourly trend (Today) — bound at `now` like the summary above
    // (T10.195 review P2-3); future hours still read 0 because there are no
    // rows yet, truncated for display at the current hour by the
    // trend-drawing code, not here.
    let hourly_query = format!("SELECT CAST(strftime('%H', timestamp) AS INTEGER), SUM({}) FROM token_logs WHERE timestamp >= ? || ' 00:00:00' AND timestamp <= ? GROUP BY 1", token_total_expr);
    if let Ok(mut stmt) = conn.prepare(&hourly_query) {
        if let Ok(rows) = stmt.query_map([&today, &now_full], |r| {
            let hour: usize = r.get(0)?;
            let total: i64 = r.get(1)?;
            Ok((hour, total))
        }) {
            for item in rows.flatten() {
                if item.0 < 24 {
                    stats.hourly_trend[item.0] = item.1;
                }
            }
        }
    }

    // 3b. Hourly trend (Yesterday) — unchanged: deliberately the WHOLE of
    // yesterday (0..24), not cut at the cutoff time. This is the trend
    // panel's backdrop reference curve, a different comparison from the
    // change pill's same-time-of-day scalar above (see
    // docs/design/windows-lockscreen-rhythm-v1.md §2.1/§2.5).
    let yesterday_hourly_query = format!("SELECT CAST(strftime('%H', timestamp) AS INTEGER), SUM({}) FROM token_logs WHERE timestamp >= ? || ' 00:00:00' AND timestamp < ? || ' 00:00:00' GROUP BY 1", token_total_expr);
    if let Ok(mut stmt) = conn.prepare(&yesterday_hourly_query) {
        if let Ok(rows) = stmt.query_map([&yesterday_date, &today], |r| {
            let hour: usize = r.get(0)?;
            let total: i64 = r.get(1)?;
            Ok((hour, total))
        }) {
            for item in rows.flatten() {
                if item.0 < 24 {
                    stats.yesterday_hourly_trend[item.0] = item.1;
                }
            }
        }
    }

    // 4. Tool distribution — bound at `now` (T10.195 review P2-3).
    let tool_query = format!("SELECT tool, SUM({}) as total FROM token_logs WHERE timestamp >= ? || ' 00:00:00' AND timestamp <= ? GROUP BY tool ORDER BY total DESC", token_total_expr);
    if let Ok(mut stmt) = conn.prepare(&tool_query) {
        if let Ok(rows) = stmt.query_map([&today, &now_full], |r| {
            let tool: String = r.get(0)?;
            let total: i64 = r.get(1)?;
            Ok((tool, total))
        }) {
            stats.tool_distribution = rows.flatten().collect();
        }
    }

    // 4b. Model ranking — bound at `now` (T10.195 review P2-3).
    let model_query = format!("SELECT model, SUM({}) as total FROM token_logs WHERE timestamp >= ? || ' 00:00:00' AND timestamp <= ? GROUP BY model ORDER BY total DESC LIMIT 5", token_total_expr);
    if let Ok(mut stmt) = conn.prepare(&model_query) {
        if let Ok(rows) = stmt.query_map([&today, &now_full], |r| {
            let model: String = r.get(0)?;
            let total: i64 = r.get(1)?;
            Ok((model, total))
        }) {
            stats.model_ranking = rows.flatten().collect();
        }
    }

    // 5. Heatmap (last 52 weeks = 364 days)
    let heatmap_start = (now_naive.date() - Duration::weeks(52))
        .format("%Y-%m-%d")
        .to_string();
    let heatmap_query = format!("SELECT substr(timestamp, 1, 10) as l_date, SUM({}) FROM token_logs WHERE timestamp >= ? GROUP BY 1", token_total_expr);
    if let Ok(mut stmt) = conn.prepare(&heatmap_query) {
        if let Ok(rows) = stmt.query_map([&heatmap_start], |r| {
            let date: String = r.get(0)?;
            let total: i64 = r.get(1)?;
            Ok((date, total))
        }) {
            stats.heatmap = rows.flatten().collect();
        }
    }

    stats
}

fn format_tokens(val: i64) -> String {
    if val >= 1_000_000 {
        format!("{:.2}M", val as f32 / 1_000_000.0)
    } else if val >= 1_000 {
        format!("{:.1}K", val as f32 / 1000.0)
    } else {
        val.to_string()
    }
}

/// `format_tokens`, but renders `STAT_UNKNOWN` as `UNKNOWN_TEXT` instead of a
/// fake `0` (T10.190 plan §4 P9). Use this instead of `format_tokens` for any
/// `WallStats` scalar that can fail to read.
fn format_known_tokens(val: i64) -> String {
    if val == STAT_UNKNOWN {
        UNKNOWN_TEXT.to_string()
    } else {
        format_tokens(val)
    }
}

/// A bare count (记录数) that renders `STAT_UNKNOWN` as `UNKNOWN_TEXT` instead
/// of a fake `0`, mirroring `format_known_tokens`.
fn format_known_count(val: i64) -> String {
    if val == STAT_UNKNOWN {
        UNKNOWN_TEXT.to_string()
    } else {
        val.to_string()
    }
}

/// The change pill's state for "today vs yesterday, same time of day"
/// (GLB-01), shared by the desktop metric card and the lock-screen badge
/// (T10.195 review P2-1). Matches the dashboard's own rule
/// (`describeMetricChange`/`describeDelta` in
/// src/components/MetricsGrid.tsx / WidgetView.tsx; REQUIREMENTS
/// REQ-COMP-01 "基期为 0 时显示"新增"或"持平"……任何情况下都不显示 0% 或
/// ∞") instead of the previous ad hoc "yesterday <= 0 means no baseline"
/// check, which showed `UNKNOWN_TEXT` for a real, successfully-read
/// zero-baseline day and never distinguished "flat" from a tiny non-zero
/// change. No variant ever selects a colour — the badge is always
/// `ACCENT_NEUTRAL`; direction is conveyed only by the wording/arrow.
#[derive(Debug, Clone, Copy, PartialEq)]
enum ChangeBadge {
    /// Either side failed to read.
    Unknown,
    /// The cloud comparison RPC answered but could not prove a previous-period
    /// baseline exists (`STAT_BASELINE_MISSING`, a 0/0 `previous.summary`) —
    /// distinct from `Unknown`: the read succeeded, there is simply nothing
    /// to compare against (T10.210).
    BaselineMissing,
    /// Yesterday is a real, successfully-read 0 and today is > 0: a 0
    /// baseline cannot honestly produce a percentage (REQ-COMP-01).
    New,
    /// Both sides are equal, or within 0.05% of each other.
    Flat,
    /// Today is meaningfully above yesterday; carries the (always > 0)
    /// signed percentage for `format_change_magnitude`.
    Up(f64),
    /// Today is meaningfully below yesterday; carries the (always < 0)
    /// signed percentage for `format_change_magnitude`.
    Down(f64),
}

impl ChangeBadge {
    fn classify(today: i64, yesterday: i64) -> Self {
        if today == STAT_UNKNOWN || yesterday == STAT_UNKNOWN {
            return Self::Unknown;
        }
        // Checked after the STAT_UNKNOWN guard, and only against `yesterday`:
        // `STAT_BASELINE_MISSING` never reaches `today` (only ever produced
        // for the previous period) and a coincidental match on `today`'s real
        // token count is a value far outside any real token total anyway.
        if yesterday == STAT_BASELINE_MISSING {
            return Self::BaselineMissing;
        }
        if yesterday == 0 {
            return if today > 0 { Self::New } else { Self::Flat };
        }
        let pct = (today - yesterday) as f64 / yesterday as f64 * 100.0;
        if pct.abs() < 0.05 {
            return Self::Flat;
        }
        if pct > 0.0 {
            Self::Up(pct)
        } else {
            Self::Down(pct)
        }
    }

    /// The pill's full display text (T10.195 review P2-1's table; also
    /// covers P3-7 item 2). `Up`/`Down` follow the dashboard's own
    /// `formatChangePercent` exactly: U+2212 MINUS SIGN (never an ASCII
    /// hyphen), an integer once the magnitude reaches 10%, one decimal below
    /// that, and the arrow AFTER the number (the lock-screen badge used to
    /// put the arrow first and keep the ASCII sign, e.g. "↓-3.0%" against the
    /// desktop's "-3.0% ↓" — both now render identically). `BaselineMissing`
    /// draws no arrow or percentage, matching the dashboard's own "基线缺失"
    /// wording (T10.210).
    fn text(self) -> String {
        match self {
            Self::Unknown => UNKNOWN_TEXT.to_string(),
            Self::BaselineMissing => "基线缺失".to_string(),
            Self::New => "新增".to_string(),
            Self::Flat => "持平".to_string(),
            Self::Up(pct) => format!("+{}% ↑", format_change_magnitude(pct)),
            Self::Down(pct) => format!("−{}% ↓", format_change_magnitude(pct)),
        }
    }
}

/// `formatChangePercent`'s digit text (src/components/MetricsGrid.tsx),
/// ported verbatim: `Math.round` once the magnitude reaches 10 percent (JS
/// rounds non-negative halves toward positive infinity, the same as Rust's
/// `f64::round` since `magnitude` is never negative here), one decimal place
/// below that threshold. The caller supplies the sign and the percent
/// sign/arrow.
fn format_change_magnitude(pct: f64) -> String {
    let magnitude = pct.abs();
    if magnitude >= 10.0 {
        format!("{}", magnitude.round() as i64)
    } else {
        format!("{magnitude:.1}")
    }
}

/// The card text for one `WallStats` snapshot: the two metric values and
/// their change badges, computed once and shared by the desktop KPI row and
/// the lock-screen summary card (T10.195 review P3-1). Pulling this out of
/// each `draw_*` function's own inline `format_known_*`/`ChangeBadge::classify`
/// calls means a regression that renders a failed read as a plain 0 (the
/// reviewer's FI-4) breaks a direct, sub-millisecond data test on this
/// function instead of being catchable only by a pixel-level render
/// comparison.
struct MetricTexts {
    token_value: String,
    token_badge: String,
    record_value: String,
    record_badge: String,
}

fn metric_texts(stats: &WallStats) -> MetricTexts {
    MetricTexts {
        token_value: format_known_tokens(stats.today_total),
        token_badge: ChangeBadge::classify(stats.today_total, stats.yesterday_total).text(),
        record_value: format_known_count(stats.today_requests),
        record_badge: ChangeBadge::classify(stats.today_requests, stats.yesterday_requests).text(),
    }
}

fn format_axis_token(value: f64) -> String {
    if value >= 1_000_000.0 {
        format!("{:.0}M", value / 1_000_000.0)
    } else if value >= 1_000.0 {
        format!("{:.0}K", value / 1_000.0)
    } else {
        format!("{:.0}", value)
    }
}

fn nice_axis_max(values: &[i64]) -> f64 {
    let max_val = values.iter().cloned().max().unwrap_or(0).max(1) as f64;
    let target = max_val * 1.18;
    let magnitude = 10.0_f64.powi(target.log10().max(0.0).floor() as i32);
    for &step in &[1.0, 2.0, 4.0, 5.0, 8.0, 10.0] {
        let candidate = step * magnitude;
        if candidate >= target {
            return candidate;
        }
    }
    10.0 * magnitude
}

fn smooth_series(values: &[i64], passes: usize) -> Vec<f64> {
    let mut current: Vec<f64> = values.iter().map(|&v| v as f64).collect();
    for _ in 0..passes {
        let mut next = current.clone();
        for i in 1..(current.len() - 1) {
            next[i] = 0.25 * current[i - 1] + 0.5 * current[i] + 0.25 * current[i + 1];
        }
        current = next;
    }
    current
}

fn bucket_hourly_values(values: &[i64], bucket_hours: usize) -> Vec<i64> {
    let mut res = Vec::new();
    for chunk in values.chunks(bucket_hours) {
        let sum: i64 = chunk.iter().sum();
        let avg = if chunk.is_empty() {
            0
        } else {
            sum / chunk.len() as i64
        };
        res.push(avg);
    }
    res
}

fn series_points(
    values: &[f64],
    x1: f32,
    y1: f32,
    x2: f32,
    y2: f32,
    max_val: f64,
) -> Vec<(f32, f32)> {
    let mut pts = Vec::new();
    if values.is_empty() {
        return pts;
    }
    let w = x2 - x1;
    let h = y2 - y1;
    let max_v = max_val.max(1.0) as f32;
    let num_steps = (values.len() - 1) as f32;
    for (idx, &val) in values.iter().enumerate() {
        let px = x1 + idx as f32 * (w / num_steps.max(1.0));
        let py = y2 - (val as f32 / max_v) * h;
        pts.push((px, py));
    }
    pts
}

/// Fritsch-Carlson tangents for shape-preserving (monotone) cubic Hermite
/// interpolation over a unit-spaced series.
///
/// Uniform Catmull-Rom overshoots on spiky token data: a quiet hour next to a
/// burst produces a dip below zero or a peak above the real maximum, which is
/// why `smooth_curve_points` had to clamp with `.max(0.0)`. Clamping hides the
/// negative half of the artifact but keeps the invented peak. Fritsch-Carlson
/// instead limits each tangent so the interpolant can never leave the interval
/// spanned by its two endpoints, so the drawn curve never claims usage that the
/// ledger does not contain.
fn monotone_tangents(values: &[f64]) -> Vec<f64> {
    let n = values.len();
    if n < 2 {
        return vec![0.0; n];
    }
    // Secant slopes between consecutive samples (unit spacing).
    let deltas: Vec<f64> = (0..n - 1).map(|i| values[i + 1] - values[i]).collect();

    let mut tangents = vec![0.0_f64; n];
    tangents[0] = deltas[0];
    tangents[n - 1] = deltas[n - 2];
    for i in 1..n - 1 {
        // A local extremum must stay flat, otherwise the curve overshoots it.
        tangents[i] = if deltas[i - 1] * deltas[i] <= 0.0 {
            0.0
        } else {
            (deltas[i - 1] + deltas[i]) / 2.0
        };
    }

    for i in 0..n - 1 {
        if deltas[i] == 0.0 {
            // Flat segment: both endpoints must be flat or the curve bulges.
            tangents[i] = 0.0;
            tangents[i + 1] = 0.0;
            continue;
        }
        let alpha = tangents[i] / deltas[i];
        let beta = tangents[i + 1] / deltas[i];
        // Fritsch-Carlson circle constraint: keep (alpha, beta) inside radius 3.
        let magnitude = alpha * alpha + beta * beta;
        if magnitude > 9.0 {
            let scale = 3.0 / magnitude.sqrt();
            tangents[i] = scale * alpha * deltas[i];
            tangents[i + 1] = scale * beta * deltas[i];
        }
    }
    tangents
}

/// Evaluates the monotone cubic Hermite segment starting at `values[i]`.
fn monotone_hermite_at(values: &[f64], tangents: &[f64], i: usize, t: f64) -> f64 {
    let t2 = t * t;
    let t3 = t2 * t;
    let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
    let h10 = t3 - 2.0 * t2 + t;
    let h01 = -2.0 * t3 + 3.0 * t2;
    let h11 = t3 - t2;
    h00 * values[i] + h10 * tangents[i] + h01 * values[i + 1] + h11 * tangents[i + 1]
}

/// Sub-samples per hour. 16 keeps a 24 h curve under 400 points, which is well
/// below the cost of the surrounding glow pass while leaving no visible facets
/// once the plot band is tall enough for curvature to show at all.
const RHYTHM_SUBSAMPLES_PER_HOUR: usize = 16;

/// Dense, shape-preserving screen points for an hourly series.
///
/// Unlike `smooth_curve_points` this does not pre-smooth the input: monotone
/// interpolation already produces a smooth path, so the box blur only cost
/// fidelity (it flattened real peaks) without buying smoothness.
///
/// `axis_span` is the x-axis denominator in hours (23.0 for a 24-slot day) and
/// is deliberately decoupled from `values.len()`. Truncation is the caller's
/// job: pass `&today[..=current_hour]` and the line ends at the last hour that
/// actually happened while still landing on the same x grid as a full-length
/// "yesterday" series. Interpolating up to a fractional cutoff instead would
/// pull the tail toward `values[current_hour + 1]`, which is structurally 0
/// because that hour is in the future — the curve would dive to the baseline
/// and invent a collapse in usage that never occurred.
fn monotone_curve_points(
    values: &[f64],
    x1: f32,
    x2: f32,
    y_top: f32,
    y_bottom: f32,
    max_val: f64,
    axis_span: f32,
) -> Vec<(f32, f32)> {
    let n = values.len();
    if n < 2 {
        return Vec::new();
    }
    let max_v = max_val.max(1.0) as f32;
    let w = x2 - x1;
    let h = y_bottom - y_top;
    let span = if axis_span > 0.0 {
        axis_span
    } else {
        (n - 1) as f32
    };
    let end = (n - 1) as f32;
    let tangents = monotone_tangents(values);
    let to_screen = |hour: f32, v: f32| (x1 + hour / span * w, y_bottom - (v / max_v) * h);

    let total = (end * RHYTHM_SUBSAMPLES_PER_HOUR as f32).ceil() as usize;
    let mut pts = Vec::with_capacity(total + 1);
    for k in 0..=total {
        let hour = (k as f32 / RHYTHM_SUBSAMPLES_PER_HOUR as f32).min(end);
        let seg = (hour.floor() as usize).min(n - 2);
        let tt = (hour - seg as f32) as f64;
        // No clamp: the interpolant is guaranteed to stay inside [values[i], values[i+1]].
        let v = monotone_hermite_at(values, &tangents, seg, tt) as f32;
        pts.push(to_screen(hour, v));
        if hour >= end {
            break;
        }
    }
    pts
}

/// Fills the band between a curve and its baseline using one vertical span per
/// image column.
///
/// `draw_polygon` would work but costs O(bbox_area x vertex_count) ray casts —
/// roughly 44M inside-tests for a 4K lock-screen chart with ~380 curve points.
/// Walking columns is O(filled pixels) and gives the same result for a function
/// graph, which is what an hourly series always is.
fn fill_curve_area(
    img: &mut RgbaImage,
    points: &[(f32, f32)],
    baseline_y: f32,
    color: Rgba<u8>,
    alpha: u8,
) {
    if points.len() < 2 || alpha == 0 {
        return;
    }
    let width = img.width() as i32;
    let height = img.height() as i32;

    for segment in points.windows(2) {
        let (mut ax, mut ay) = segment[0];
        let (mut bx, mut by) = segment[1];
        if bx < ax {
            std::mem::swap(&mut ax, &mut bx);
            std::mem::swap(&mut ay, &mut by);
        }
        let x_start = ax.ceil() as i32;
        let x_end = bx.floor() as i32;
        if x_end < x_start {
            continue;
        }
        let dx = bx - ax;
        for x in x_start..=x_end {
            if x < 0 || x >= width {
                continue;
            }
            let t = if dx.abs() < f32::EPSILON {
                0.0
            } else {
                ((x as f32 - ax) / dx).clamp(0.0, 1.0)
            };
            let curve_y = ay + (by - ay) * t;
            let (top, bottom) = if curve_y <= baseline_y {
                (curve_y, baseline_y)
            } else {
                (baseline_y, curve_y)
            };
            let y_start = top.ceil().max(0.0) as i32;
            let y_end = bottom.floor().min((height - 1) as f32) as i32;
            for y in y_start..=y_end {
                if y < 0 || y >= height {
                    continue;
                }
                let bg = *img.get_pixel(x as u32, y as u32);
                img.put_pixel(x as u32, y as u32, blend_colors(bg, color, alpha));
            }
        }
    }
}

/// Catmull-Rom spline interpolation between p1 and p2 (p0/p3 are neighbors).
///
/// Still used by the desktop wallpaper trend chart. New lock-screen work should
/// prefer `monotone_curve_points`, which cannot overshoot the sampled data.
fn catmull_rom(p0: f32, p1: f32, p2: f32, p3: f32, t: f32) -> f32 {
    let t2 = t * t;
    let t3 = t2 * t;
    0.5 * ((2.0 * p1)
        + (-p0 + p2) * t
        + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
        + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3)
}

/// Dense, spline-smoothed screen points for an hourly series. The curve runs
/// from hour 0 to `cutoff_hours` (fractional), so the "today" line can stop at
/// the current time instead of dragging a flat zero tail to 24:00.
fn smooth_curve_points(
    values: &[f64],
    x1: f32,
    y1: f32,
    x2: f32,
    y2: f32,
    max_val: f64,
    cutoff_hours: f32,
) -> Vec<(f32, f32)> {
    let _ = y1;
    let n = values.len();
    if n < 2 {
        return Vec::new();
    }
    let max_v = max_val.max(1.0) as f32;
    let w = x2 - x1;
    let h = y2 - y1;
    let span = (n - 1) as f32;
    let end = cutoff_hours.clamp(0.0, span);
    let val_at = |i: i64| values[i.clamp(0, (n - 1) as i64) as usize] as f32;
    let to_screen = |hour: f32, v: f32| (x1 + hour / span * w, y2 - (v / max_v) * h);

    let sub = 12usize; // sub-samples per hour segment
    let total = (end * sub as f32).ceil() as usize;
    let mut pts = Vec::with_capacity(total + 1);
    for k in 0..=total {
        let hour = (k as f32 / sub as f32).min(end);
        let seg = hour.floor() as i64;
        let tt = hour - seg as f32;
        let v = catmull_rom(
            val_at(seg - 1),
            val_at(seg),
            val_at(seg + 1),
            val_at(seg + 2),
            tt,
        )
        .max(0.0);
        pts.push(to_screen(hour, v));
        if hour >= end {
            break;
        }
    }
    pts
}

// ============ TOOL -> CHART-SLOT COLOUR TABLE (T10.187, shared with the
// desktop app and Android — R-8, docs/design/android-visual-refresh-v2.md
// §3.8; palette values are colour-vision palette B, user decision U-4,
// 2026-09-25) ============
//
// Mirrors `TOOL_CHART_SLOT`/`TOOL_ALIASES`/`hashToolSlot`/
// `assignToolChartSlots`/`colorsForToolsInView` in src/types.ts; keep both in
// sync by hand (T10.178 review P2-6: no cross-language shared source yet,
// only the shared test fixtures under `fixtures/tool-chart-slots-v1/`
// (`slots.json`, `palette-b.json`; moved from `tests/fixtures/` in the
// T10.187 review P3-3 fix round), read by both suites — see
// `tool_chart_slot_tests` below. The colour table itself is now also checked
// against `palette-b.json` directly (T10.187 review P2-1), independently of
// the desktop TS copies, so a drift in either language alone turns a test
// red.
//
// This file's wallpaper always draws on the fixed dark gradient
// `BG_TOP`/`BG_BOTTOM` (no light-ground variant exists here), so only the
// dark half of the shared slot table is needed.

/// Tool identity -> primary chart slot (1-8). Same 18 entries, same slots, as
/// `TOOL_CHART_SLOT` in src/types.ts.
const TOOL_CHART_SLOT_TABLE: &[(&str, u32)] = &[
    ("antigravity", 1),
    ("gemini", 1),
    ("codex", 2),
    ("marvis", 2),
    ("hermes", 2),
    ("pi", 3),
    ("opencode", 4),
    ("workbuddy", 4),
    ("reasonix", 5),
    ("deepseek", 5),
    ("grok", 5),
    ("claude", 6),
    ("qclaw", 6),
    ("kilo", 7),
    ("kimi", 7),
    ("trae", 7),
    ("minimax", 8),
    ("zcode", 8),
];

/// Same-product spelling variants, resolved before `TOOL_CHART_SLOT_TABLE` is
/// consulted (R-8(b)). Identical to `TOOL_ALIASES` in src/types.ts.
const TOOL_CHART_ALIASES: &[(&str, &str)] = &[
    ("deepseekgui", "deepseek"),
    ("dsh", "deepseek"),
    ("kimidesktop", "kimi"),
    ("mavis", "marvis"),
];

const TOOL_CHART_SLOT_COUNT: u32 = 8;

/// Palette B (T10.187, user decision U-4), dark scope only, in slot order.
/// Mirrors `CHART_SLOT_COLORS_DARK` in src/types.ts and `--chart-1..8` (dark
/// scope) in src/styles/tokens.css.
const TOOL_CHART_SLOT_COLORS_DARK: [Rgba<u8>; 8] = [
    Rgba([0x6b, 0x9d, 0xff, 255]), // --chart-1 #6b9dff
    Rgba([0x90, 0x7a, 0xdc, 255]), // --chart-2 #907adc
    Rgba([0x2d, 0xd4, 0xbf, 255]), // --chart-3 #2dd4bf
    Rgba([0xfb, 0xbf, 0x24, 255]), // --chart-4 #fbbf24
    Rgba([0xfb, 0x71, 0x85, 255]), // --chart-5 #fb7185
    Rgba([0x3f, 0xe4, 0x80, 255]), // --chart-6 #3fe480
    Rgba([0x3d, 0xbd, 0xf7, 255]), // --chart-7 #3dbdf7
    Rgba([0xfb, 0x92, 0x3c, 255]), // --chart-8 #fb923c
];

/// Neutral "other" colour for the 9th+ ranked tool in one view (R-8(d));
/// mirrors `TOOL_COLOR_OTHER_DARK` in src/types.ts (`--color-text-muted`,
/// dark scope, root decision R-16).
const TOOL_CHART_COLOR_OTHER_DARK: Rgba<u8> = Rgba([0xa5, 0xac, 0xb9, 255]); // #a5acb9

/// Non-tool accent constants (trend line, model-ranking bar/title dots,
/// background glow, change pill, "yesterday" reference line). Independent
/// literals, deliberately NOT aliased to `TOOL_CHART_SLOT_COLORS_DARK` (T10.195
/// review P3-4: the previous revision aliased `ACCENT_VIOLET`/`ACCENT_TEAL` to
/// slots 2/3, so a non-tool background glow and the model-ranking bar/title
/// silently carried an actual tool's identity colour — diluting GLB-05
/// ("工具色绑定工具身份") and meaning a future slot-table edit would have
/// silently recoloured these non-tool elements too). `ACCENT_PRIMARY` is the
/// sole accepted exception, matching slot 1 by user decision U-4 (T10.187);
/// see `non_tool_accents_are_sourced_from_the_palette_b_slot_table_not_hand_copied`,
/// which asserts exactly that. DESIGN §4.4 has the SSOT rule this implements.
const ACCENT_PRIMARY: Rgba<u8> = Rgba([0x6b, 0x9d, 0xff, 255]); // #6b9dff — T10.150 primary. Today's trend line/current-time marker, the "有效 Token" metric/title dot, the model-ranking bar and its title dot, the "记录数" title dot, and one of the background glows.
/// Axis colour (plan `desktop-widgets-wallpaper-visual-v1.md` §6.3, row
/// "昨日虚线、刻度"): the "yesterday" reference line/legend swatch and the
/// chart gridlines/ticks, on both the desktop trend panel and the
/// lock-screen rhythm chart (T10.195 review P3-4). Not one of the 8 dark
/// tool-chart-slot colours, so it needs no exception in the test above.
const ACCENT_AXIS: Rgba<u8> = Rgba([0x8f, 0x97, 0xa5, 255]); // #8f97a5
/// The change pill is always this neutral grey, whether usage went up or
/// down (T10.190 plan §4 P9 / §6.8: lower usage is not bad, so direction is
/// conveyed only by the ↑/↓ glyph, never by colour — replacing the removed
/// `APPLE_PINK`/`APPLE_GREEN`). Also used for the "yesterday" reference
/// curve's translucent area fill (a backdrop for comparison, not a value
/// judgement; the area's own outline is `ACCENT_AXIS` — T10.195 review P3-4).
/// Aliasing `TOOL_CHART_COLOR_OTHER_DARK` here is intentional and does not
/// need the same independence as the two constants above: that "other tool"
/// colour is not one of the 8 numbered tool slots, and DESIGN §4.4 explicitly
/// keeps the pill on `--color-text-muted`'s dark value.
const ACCENT_NEUTRAL: Rgba<u8> = TOOL_CHART_COLOR_OTHER_DARK; // #a5acb9

/// Alpha for the two translucent `ACCENT_NEUTRAL` composites left in this
/// file: the change-pill fill on both the desktop metric and the lock-screen
/// badge (known and unknown states alike). This is not a stylistic pick —
/// 143/255 is (to a few units either side) the only alpha at which a solid
/// `ACCENT_NEUTRAL` composite simultaneously reaches a 3-to-1 contrast ratio
/// against its own backdrop as a graphic and leaves `TEXT_PRIMARY` drawn on
/// top of it at a 4.5-to-1 ratio, checked against every backdrop this file
/// draws it over (desktop KPI panel at both gradient stops, lock-screen
/// summary-card fill sampled from the real embedded bitmap — T10.195 review
/// P3-5). Below roughly 138 the fill-vs-backdrop leg fails; above roughly 145
/// the text-vs-fill leg fails. See docs/task-logs/T10.195/ for the full
/// derivation table — do not retune without rerunning that check. (Until the
/// T10.195 review fix round this constant was also shared by the "yesterday"
/// reference outline; that role moved to `ACCENT_AXIS`/`AXIS_ACCENT_ALPHA`,
/// since axis is a few units darker and 143 no longer clears 3:1 for it.)
const NEUTRAL_ACCENT_ALPHA: u8 = 143;

/// Alpha for `ACCENT_AXIS` composited as the "yesterday" reference line: the
/// desktop trend panel's dotted curve + legend swatch, and the lock-screen
/// rhythm chart's dashed outline + legend swatch (both the compact and full
/// styles). `ACCENT_AXIS` (#8f97a5) is a few units darker than
/// `ACCENT_NEUTRAL` (#a5acb9), so it cannot reuse `NEUTRAL_ACCENT_ALPHA` (143)
/// and still clear a 3-to-1 contrast ratio against the darkest backdrops this
/// file draws it over — the raw `BG_TOP`/`BG_BOTTOM` gradient behind the
/// desktop trend panel (no panel-fill overlay sits under it), and the lock
/// screen's real embedded-bitmap card colour (T10.195 review P3-5). Only
/// roughly 155-200 clears that ratio on every such backdrop; no text is ever
/// drawn on top of this line, so only the graphic (3:1) threshold applies —
/// see docs/task-logs/T10.195/ for the derivation. 170 keeps a margin from
/// both ends of that window.
const AXIS_ACCENT_ALPHA: u8 = 170;

/// The character set ECMAScript `String.prototype.trim()` strips: WhiteSpace
/// (TAB, VT, FF, SP, NBSP, ZWNBSP/BOM and the Zs-category spaces) plus
/// LineTerminator (LF, CR, LS, PS). Listed explicitly rather than delegating
/// to `char::is_whitespace()`, which follows Unicode's own White_Space
/// property and disagrees with ECMAScript on two characters: it strips
/// U+0085 NEL (ECMAScript does not) and does not strip U+FEFF ZWNBSP
/// (ECMAScript does). Copied verbatim from Android's `isEcmaScriptTrimmable`
/// (`AuditPresentation.kt`, branch
/// `codex/T10.177-android-visual-a0-foundation`) so this file, desktop JS
/// `trim()` (`src/types.ts`) and Android all trim the same bytes (T10.187
/// review P3-1); the 12 `trimProbes` vectors in
/// `fixtures/tool-chart-slots-v1/slots.json` (ported from Android's
/// `LedgerTokensTest.kt`) pin the cases this changes.
fn is_ecmascript_trimmable(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{FEFF}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
    ) || ('\u{2000}'..='\u{200A}').contains(&c)
}

/// Lower-cases and trims a raw tool name (R-8(a)): the shared input both the
/// hash and the alias table key on. Trims with the ECMAScript character set
/// (see `is_ecmascript_trimmable`), not Rust's own Unicode-whitespace trim,
/// so an edge-case name normalises identically to desktop JS and Android.
fn normalize_tool_chart_name(name: &str) -> String {
    name.trim_matches(is_ecmascript_trimmable).to_lowercase()
}

#[derive(serde::Deserialize)]
struct ToolDisplayNameTable {
    #[serde(rename = "emptyLabel")]
    empty_label: String,
    names: std::collections::HashMap<String, String>,
    aliases: std::collections::HashMap<String, String>,
}

fn tool_display_name_table() -> &'static ToolDisplayNameTable {
    static TABLE: OnceLock<ToolDisplayNameTable> = OnceLock::new();
    TABLE.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../fixtures/tool-display-names-v1/names.json"
        ))
        .expect("fixtures/tool-display-names-v1/names.json")
    })
}

fn capitalize_first(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => {
            let mut out = String::new();
            for upper in first.to_uppercase() {
                out.push(upper);
            }
            out.push_str(chars.as_str());
            out
        }
    }
}

/// Tool id -> display name shared with the dashboard and the desktop widget
/// (`src/utils/toolDisplayName.ts`). Both read
/// `fixtures/tool-display-names-v1/names.json` (TOKE-12). Trim matches
/// ECMAScript `trim()` via `is_ecmascript_trimmable`, not Rust's Unicode trim.
fn tool_display_name(name: &str) -> String {
    let table = tool_display_name_table();
    let trimmed = name.trim_matches(is_ecmascript_trimmable);
    let key = trimmed.to_lowercase();
    if let Some(known) = table.names.get(&key) {
        return known.clone();
    }
    if let Some(canonical) = table.aliases.get(&key) {
        if let Some(known) = table.names.get(canonical) {
            return known.clone();
        }
        return capitalize_first(canonical);
    }
    if trimmed.is_empty() {
        return table.empty_label.clone();
    }
    capitalize_first(trimmed)
}

/// Stable, reproducible slot (1-8) for a tool name absent from
/// `TOOL_CHART_SLOT_TABLE`. FNV-1a 32-bit over the UTF-16 code units of the
/// already-normalised name, folded into range with `mod 8` (R-8(a)): the same
/// algorithm as `hashToolSlot` in src/types.ts, so an unregistered name lands
/// on the same slot on the desktop app, Android and this wallpaper.
fn hash_tool_chart_slot(normalized_name: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for unit in normalized_name.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    (hash % TOOL_CHART_SLOT_COUNT) + 1
}

/// The chart slot (1-8) a tool identity draws with, before same-view
/// collision handling (mirrors `toolChartSlot` in src/types.ts).
fn tool_chart_slot(name: &str) -> u32 {
    let normalized = normalize_tool_chart_name(name);
    let resolved = TOOL_CHART_ALIASES
        .iter()
        .find(|(alias, _)| *alias == normalized.as_str())
        .map_or(normalized.as_str(), |(_, canonical)| *canonical);
    TOOL_CHART_SLOT_TABLE
        .iter()
        .find(|(key, _)| *key == resolved)
        .map_or_else(|| hash_tool_chart_slot(resolved), |(_, slot)| *slot)
}

/// A tool's per-view slot assignment: 1-8, or `Other` past the 8th distinct
/// rank (R-8(d)). Mirrors `ToolChartSlotAssignment` in src/types.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ToolChartSlotAssignment {
    Slot(u32),
    Other,
}

/// Resolve chart slots for several distinct tools shown together in one view
/// (the tool-distribution donut and its legend), in rank order (index 0 =
/// highest rank). Mirrors `assignToolChartSlots` in src/types.ts: when two
/// tools would land on the same slot, the lower-ranked one shifts to the next
/// unused slot, wrapping 8 -> 1. A 9th distinct tool onward draws the neutral
/// "other" colour instead of repeating an already-placed primary slot.
fn assign_tool_chart_slots(names_in_rank_order: &[String]) -> Vec<ToolChartSlotAssignment> {
    let mut used: std::collections::HashSet<u32> = std::collections::HashSet::new();
    names_in_rank_order
        .iter()
        .enumerate()
        .map(|(index, name)| {
            if index >= TOOL_CHART_SLOT_COUNT as usize {
                return ToolChartSlotAssignment::Other;
            }
            let mut slot = tool_chart_slot(name);
            while used.contains(&slot) {
                slot = if slot >= TOOL_CHART_SLOT_COUNT {
                    1
                } else {
                    slot + 1
                };
            }
            used.insert(slot);
            ToolChartSlotAssignment::Slot(slot)
        })
        .collect()
}

/// One slot assignment resolved to its actual colour: a numbered slot reads
/// `TOOL_CHART_SLOT_COLORS_DARK`, `Other` reads the neutral grey. Shared by
/// `hud_tool_color` and `hud_tool_colors_for_view` so the two never disagree
/// on what a slot number paints.
fn color_for_tool_chart_slot(assignment: ToolChartSlotAssignment) -> Rgba<u8> {
    match assignment {
        ToolChartSlotAssignment::Slot(slot) => TOOL_CHART_SLOT_COLORS_DARK[(slot - 1) as usize],
        ToolChartSlotAssignment::Other => TOOL_CHART_COLOR_OTHER_DARK,
    }
}

/// One tool's primary-slot colour, with no notion of "view" or rank (mirrors
/// `colorForTool` in src/types.ts): `codex`/`marvis`/`hermes` all resolve to
/// the same colour, by design. Any view drawing more than one tool at once
/// must use `hud_tool_colors_for_view` instead, so that two tools landing on
/// the same slot in that view are told apart by rank — which is every current
/// call site in this file (the tool-distribution donut always draws several
/// tools together), so this primitive has no production caller of its own
/// right now. Kept, and covered directly by `tool_chart_slot_tests`, as the
/// single-tool building block `hud_tool_colors_for_view` shares its
/// slot-to-colour lookup with, and for any future single-tool badge/legend
/// that does not need collision handling. `#[cfg(test)]` rather than
/// `#[allow(dead_code)]` (R-33 precedent, `store::project_of`): the latter
/// would silently keep suppressing the dead-code warning even if this
/// primitive stops having test callers too, instead of telling us
/// (T10.187 review P3-2). Its only two callers are both in
/// `tool_chart_slot_tests` below.
#[cfg(test)]
fn hud_tool_color(tool: &str) -> Rgba<u8> {
    color_for_tool_chart_slot(ToolChartSlotAssignment::Slot(tool_chart_slot(tool)))
}

/// `assign_tool_chart_slots` resolved straight to colours, in rank order
/// (mirrors `colorsForToolsInView` in src/types.ts). Every view in this file
/// that draws more than one tool identity at once must share one call to
/// this function across all of its own tool-coloured elements (donut wedges
/// and legend dots alike), so a tool reads the same colour in both, exactly
/// as the desktop app shares one `colorsForToolsInView` result across its own
/// multi-tool panels (T10.178 review P1-1).
fn hud_tool_colors_for_view(names_in_rank_order: &[String]) -> Vec<Rgba<u8>> {
    assign_tool_chart_slots(names_in_rank_order)
        .into_iter()
        .map(color_for_tool_chart_slot)
        .collect()
}

// ============ SUB-PANEL RENDERING LOGIC ============

fn draw_reference_trend_panel(
    img: &mut RgbaImage,
    font: &FontRef,
    bounds: PixelRect,
    stats: &WallStats,
    sf: f32,
) {
    let (x1, y1, x2, y2) = bounds;
    let pad_x = (58.0 * sf) as i32;
    let bottom_pad = (46.0 * sf) as i32;

    // `stats.generated_at`, not a fresh `Local::now()` (T10.195 review P3-2):
    // a refresh straddling midnight must not show a clock/date for one day
    // next to a curve computed for another.
    let now = stats.generated_at;
    let time_text = now.format("%H:%M").to_string();
    let weekdays = [
        "星期一",
        "星期二",
        "星期三",
        "星期四",
        "星期五",
        "星期六",
        "星期日",
    ];
    let date_text = format!(
        "{} {}",
        now.format("%Y年%m月%d日"),
        weekdays[now.weekday().number_from_monday() as usize - 1]
    );

    let f_clock = 58.0 * sf;
    let f_date = 18.0 * sf;
    let f_axis = 12.0 * sf;
    let f_legend = 12.0 * sf;

    // Render clock text
    let tw = text_width(font, &time_text, f_clock);
    draw_text(
        img,
        font,
        &time_text,
        ((x1 + x2) as f32 / 2.0 - tw / 2.0) as i32,
        y1 + (22.0 * sf) as i32,
        f_clock,
        TEXT_PRIMARY,
    );

    // Render date text
    let dw = text_width(font, &date_text, f_date);
    draw_text(
        img,
        font,
        &date_text,
        ((x1 + x2) as f32 / 2.0 - dw / 2.0) as i32,
        y1 + (90.0 * sf) as i32,
        f_date,
        TEXT_SECONDARY,
    );

    // Render Legend
    let legend_y = y1 + (72.0 * sf) as i32;
    let legend_x = x2 - (190.0 * sf) as i32;
    draw_line(
        img,
        legend_x as f32,
        legend_y as f32,
        legend_x as f32 + 24.0 * sf,
        legend_y as f32,
        ACCENT_PRIMARY,
        2.5 * sf,
    );
    draw_text_top_left(
        img,
        font,
        "今天",
        legend_x + (34.0 * sf) as i32,
        legend_y - (9.0 * sf) as i32,
        f_legend,
        TEXT_PRIMARY,
    );

    let dash_x = legend_x + (105.0 * sf) as i32;
    let dotted_pts = vec![
        (dash_x as f32, legend_y as f32),
        (dash_x as f32 + 24.0 * sf, legend_y as f32),
    ];
    draw_dotted_line(
        img,
        &dotted_pts,
        Rgba([
            ACCENT_AXIS[0],
            ACCENT_AXIS[1],
            ACCENT_AXIS[2],
            AXIS_ACCENT_ALPHA,
        ]),
        7.0 * sf,
        1.6 * sf,
    );
    draw_text_top_left(
        img,
        font,
        "昨天",
        dash_x + (34.0 * sf) as i32,
        legend_y - (9.0 * sf) as i32,
        f_legend,
        TEXT_PRIMARY,
    );

    // Chart Bounding Box
    let cx1 = x1 + pad_x + (30.0 * sf) as i32;
    let cy1 = y1 + (128.0 * sf) as i32;
    let cx2 = x2 - pad_x;
    let cy2 = y2 - bottom_pad;

    let today_values = smooth_series(&stats.hourly_trend, 2);
    let yesterday_values = smooth_series(&stats.yesterday_hourly_trend, 2);

    let all_vals: Vec<i64> = stats
        .hourly_trend
        .iter()
        .chain(stats.yesterday_hourly_trend.iter())
        .cloned()
        .collect();
    let max_val = nice_axis_max(&all_vals);

    // Draw horizontal gridlines
    for i in 0..=5 {
        let value = max_val * (5.0 - i as f64) / 5.0;
        let y = cy1 + ((cy2 - cy1) * i) / 5;
        let alpha = if i < 5 { 42 } else { 64 };

        if i < 5 {
            draw_dashed_line(
                img,
                (cx1 as f32, y as f32),
                (cx2 as f32, y as f32),
                Rgba([ACCENT_AXIS[0], ACCENT_AXIS[1], ACCENT_AXIS[2], alpha]),
                (4.0 * sf, 6.0 * sf),
                1.0 * sf,
            );
        } else {
            draw_line(
                img,
                cx1 as f32,
                y as f32,
                cx2 as f32,
                y as f32,
                Rgba([ACCENT_AXIS[0], ACCENT_AXIS[1], ACCENT_AXIS[2], alpha]),
                1.0 * sf,
            );
        }

        let label = if i == 5 {
            "0".to_string()
        } else {
            format_axis_token(value)
        };
        let lw = text_width(font, &label, f_axis);
        draw_text(
            img,
            font,
            &label,
            cx1 - (14.0 * sf) as i32 - lw as i32,
            y - (8.0 * sf) as i32,
            f_axis,
            TEXT_SECONDARY,
        );
    }

    // Draw X-axis labels
    for hour in (0..=24).step_by(2) {
        let x = cx1 + ((cx2 - cx1) * hour) / 24;
        let label = format!("{:02}:00", hour);
        let lw = text_width(font, &label, f_axis);
        draw_text(
            img,
            font,
            &label,
            x - (lw / 2.0) as i32,
            cy2 + (13.0 * sf) as i32,
            f_axis,
            TEXT_SECONDARY,
        );
    }

    // Yesterday is a full-day reference (dotted, spans 0..24).
    let yesterday_points = series_points(
        &yesterday_values,
        cx1 as f32,
        cy1 as f32,
        cx2 as f32,
        cy2 as f32,
        max_val,
    );
    // Today is drawn only up to the current time, as a smooth spline.
    let current_pos = (now.hour() as f32 + now.minute() as f32 / 60.0).min(24.0);
    let today_points = smooth_curve_points(
        &today_values,
        cx1 as f32,
        cy1 as f32,
        cx2 as f32,
        cy2 as f32,
        max_val,
        current_pos,
    );

    if stats.today_total == STAT_UNKNOWN {
        // T10.195 review P2-2: a failed read must show one honest "不可得"
        // line in the plot area, never a curve. `fetch_stats_at`'s failure
        // path leaves both `hourly_trend` and `yesterday_hourly_trend` at
        // `vec![0; 24]`, which — before this fix — drew as a flat line
        // pinned to the baseline, indistinguishable from a real, unusually
        // quiet day (the gridlines/axis/legend/clock above stay: they are
        // the panel's frame, not a data reading).
        let text = UNKNOWN_TEXT;
        let tw = text_width(font, text, f_legend);
        draw_text(
            img,
            font,
            text,
            ((cx1 + cx2) as f32 / 2.0 - tw / 2.0) as i32,
            (cy1 + cy2) / 2,
            f_legend,
            Rgba([174, 196, 224, 170]),
        );
    } else {
        // Draw yesterday dotted curve
        if yesterday_points.len() > 1 {
            draw_dotted_line(
                img,
                &yesterday_points,
                Rgba([
                    ACCENT_AXIS[0],
                    ACCENT_AXIS[1],
                    ACCENT_AXIS[2],
                    AXIS_ACCENT_ALPHA,
                ]),
                9.0 * sf,
                1.7 * sf,
            );
        }

        // Draw today curve: a faint glow under a clean thin line.
        if today_points.len() > 1 {
            for i in 0..(today_points.len() - 1) {
                let p1 = today_points[i];
                let p2 = today_points[i + 1];
                draw_line(
                    img,
                    p1.0,
                    p1.1,
                    p2.0,
                    p2.1,
                    Rgba([ACCENT_PRIMARY[0], ACCENT_PRIMARY[1], ACCENT_PRIMARY[2], 60]),
                    3.5 * sf,
                );
            }
            for i in 0..(today_points.len() - 1) {
                let p1 = today_points[i];
                let p2 = today_points[i + 1];
                draw_line(img, p1.0, p1.1, p2.0, p2.1, ACCENT_PRIMARY, 1.5 * sf);
            }
        }
    }

    // Draw vertical timeline current marker
    let marker_x = cx1 as f32 + (cx2 - cx1) as f32 * current_pos / 24.0;
    draw_dashed_line(
        img,
        (marker_x, cy1 as f32),
        (marker_x, cy2 as f32),
        Rgba([170, 195, 230, 112]),
        (4.0 * sf, 5.0 * sf),
        1.0 * sf,
    );

    // Draw current time label at the top of the vertical timeline
    let label = time_text.clone();
    let f_marker_time = 11.0 * sf;
    let lw = text_width(font, &label, f_marker_time);
    let draw_x = ((marker_x - lw / 2.0) as i32).max(cx1).min(cx2 - lw as i32);
    draw_text(
        img,
        font,
        &label,
        draw_x,
        cy1 - (16.0 * sf) as i32,
        f_marker_time,
        ACCENT_PRIMARY,
    );

    // Current point sits at the end of the today curve (skipped when
    // unknown: there is no real "latest point" to mark — T10.195 review
    // P2-2).
    if stats.today_total != STAT_UNKNOWN {
        let (marker_x, marker_y) = today_points
            .last()
            .copied()
            .unwrap_or((marker_x, cy2 as f32));
        let r = (4.5 * sf).max(3.0);
        draw_circle(
            img,
            marker_x as i32,
            marker_y as i32,
            (r * 2.3) as i32,
            Rgba([ACCENT_PRIMARY[0], ACCENT_PRIMARY[1], ACCENT_PRIMARY[2], 44]),
        );
        draw_circle(
            img,
            marker_x as i32,
            marker_y as i32,
            r as i32,
            ACCENT_PRIMARY,
        );
    }
}

struct ReferenceMetricContent<'a> {
    title: &'a str,
    value: &'a str,
    subtitle: &'a str,
    color: Rgba<u8>,
    /// The pill's full, ready-to-draw text — `ChangeBadge::text()`'s output
    /// (T10.195 review P2-1), e.g. "+17% ↑", "不可得", "新增" or "持平". This
    /// function draws it verbatim; it no longer derives an arrow from the
    /// string's own leading character (the previous per-call-site
    /// arrow-placement logic here and in `draw_lockscreen_badge` is exactly
    /// what let the two drift apart — P3-7 item 2).
    badge_text: &'a str,
}

fn draw_reference_metric(
    img: &mut RgbaImage,
    font: &FontRef,
    bounds: PixelRect,
    sf: f32,
    content: ReferenceMetricContent<'_>,
) {
    let (x1, y1, x2, y2) = bounds;
    let ReferenceMetricContent {
        title,
        value,
        subtitle,
        color,
        badge_text,
    } = content;
    let pad = (26.0 * sf) as i32;
    let dot = (10.0 * sf) as i32;
    let content_w = 1.max(x2 - x1 - pad * 2);

    let f_label = 15.0 * sf;
    draw_dot_title(
        img,
        font,
        (x1 + pad, y1 + (34.0 * sf) as i32),
        (dot, (12.0 * sf) as i32),
        title,
        f_label,
        (color, TEXT_PRIMARY),
    );

    let f_value = 42.0 * sf;
    let value_font_sz = fit_font_size(font, value, f_value, content_w as f32, 28.0 * sf);
    draw_text(
        img,
        font,
        value,
        x1 + pad,
        y1 + (76.0 * sf) as i32,
        value_font_sz,
        TEXT_PRIMARY,
    );

    let f_body = 14.0 * sf;
    draw_text(
        img,
        font,
        subtitle,
        x1 + pad,
        y1 + (130.0 * sf) as i32,
        f_body,
        TEXT_SECONDARY,
    );

    // Badge. Colour is always ACCENT_NEUTRAL: never red/green for down/up
    // (T10.190 plan §4 P9 / §6.8). Direction is conveyed only by `badge_text`
    // itself (`ChangeBadge::text()` already carries the arrow, or omits it
    // for "不可得"/"基线缺失"/"新增"/"持平" — T10.195 review P2-1, T10.210).
    let f_small = 12.0 * sf;
    let bh = (26.0 * sf) as i32;
    let bw = text_width(font, badge_text, f_small) as i32 + (22.0 * sf) as i32;
    let badge_x = x2 - pad - bw;
    let badge_y = y2 - (44.0 * sf) as i32;

    // COMPARE_LABEL and badge sit on one row, vertically centered with the badge.
    let label = COMPARE_LABEL;
    let f_label_cmp = 12.0 * sf;
    let label_w = text_width(font, label, f_label_cmp);
    let row_center_y = badge_y + bh / 2;
    let label_baseline = row_center_y + (f_label_cmp * 0.34) as i32;
    draw_text(
        img,
        font,
        label,
        badge_x - (10.0 * sf) as i32 - label_w as i32,
        label_baseline,
        f_label_cmp,
        // Opaque TEXT_SECONDARY, not a semi-transparent literal (T10.195
        // review P3-3): `Rgba([174, 174, 180, 175])` only reached 4.14-4.53:1
        // (formula) / 4.22-4.47:1 (measured on the real panel) against the
        // 4.5:1 text threshold at 12px. The lock screen already used the
        // opaque colour here and clears 8.93-9.08:1; this now matches it and
        // reaches 7.17-8.39:1 (formula) / 7.46-8.17:1 (measured).
        TEXT_SECONDARY,
    );

    // Fill alpha is the same across every ChangeBadge variant: the states are
    // told apart by `badge_text` alone, not by a second alpha — see
    // NEUTRAL_ACCENT_ALPHA's doc comment for why a per-state alpha cannot
    // satisfy both contrast legs at once.
    let badge_fill = Rgba([
        ACCENT_NEUTRAL[0],
        ACCENT_NEUTRAL[1],
        ACCENT_NEUTRAL[2],
        NEUTRAL_ACCENT_ALPHA,
    ]);
    draw_card(
        img,
        (badge_x, badge_y, badge_x + bw, badge_y + bh),
        bh / 2,
        badge_fill,
        Rgba([0, 0, 0, 0]),
    );
    let badge_baseline = row_center_y + (f_small * 0.34) as i32;
    let badge_text_w = text_width(font, badge_text, f_small);
    draw_text(
        img,
        font,
        badge_text,
        badge_x + ((bw as f32 - badge_text_w) / 2.0) as i32,
        badge_baseline,
        f_small,
        TEXT_PRIMARY,
    );
}

fn draw_reference_model_ranking(
    img: &mut RgbaImage,
    font: &FontRef,
    bounds: PixelRect,
    stats: &WallStats,
    sf: f32,
) {
    let (x1, y1, x2, _y2) = bounds;
    let pad = (24.0 * sf) as i32;
    let dot = (10.0 * sf) as i32;

    let f_label = 15.0 * sf;
    draw_dot_title(
        img,
        font,
        (x1 + pad, y1 + (34.0 * sf) as i32),
        (dot, (12.0 * sf) as i32),
        "模型排行",
        f_label,
        (ACCENT_PRIMARY, TEXT_PRIMARY),
    );

    // T10.195 review P2-2: a failed read draws the title (the panel's frame)
    // and one "不可得" line, never three "— 暂无数据" rows (which claimed a
    // successful read that simply found nothing).
    if stats.today_total == STAT_UNKNOWN {
        draw_text(
            img,
            font,
            UNKNOWN_TEXT,
            x1 + pad,
            y1 + (58.0 * sf) as i32 + (14.0 * sf) as i32,
            13.0 * sf,
            TEXT_SECONDARY,
        );
        return;
    }

    let mut items = stats.model_ranking.clone();
    items.sort_by_key(|item| std::cmp::Reverse(item.1));
    let items_top: Vec<&(String, i64)> = items.iter().take(3).collect();

    // A model's share of today's total is only meaningful when that total is
    // itself a real reading; an unknown or non-positive total must not turn
    // into a fabricated (or division-by-near-zero) percentage (T10.190 plan
    // §4 P9).
    let today_total_for_pct = if stats.today_total == STAT_UNKNOWN || stats.today_total <= 0 {
        None
    } else {
        Some(stats.today_total)
    };

    let rank_col_w = (22.0 * sf) as i32;
    let rank_cx = x1 + pad + rank_col_w / 2;
    let name_x = x1 + pad + rank_col_w;
    let pct_right = x2 - (26.0 * sf) as i32;
    // Only show token column if card is wide enough (>280px at sf=1)
    let show_token_col = (x2 - x1) > (280.0 * sf) as i32;
    let token_right = pct_right - (96.0 * sf) as i32;

    let row_gap = (42.0 * sf) as i32;
    let bar_h = 4.max((4.0 * sf) as i32);
    let bar_offset_y = (28.0 * sf) as i32;
    let text_y_offset = (14.0 * sf) as i32;
    let row_y_start = y1 + (58.0 * sf) as i32;

    let f_body = 13.0 * sf;
    let f_small = 11.0 * sf;

    for idx in 0..3 {
        let row_y = row_y_start + idx as i32 * row_gap;
        let text_y = row_y + text_y_offset;
        let bar_y = row_y + bar_offset_y;

        let has_value = idx < items_top.len() && items_top[idx].1 > 0;
        let rank_str = if has_value {
            (idx + 1).to_string()
        } else {
            "—".to_string()
        };
        let display_name = if has_value {
            let model = &items_top[idx].0;
            model
                .replace("minimax/", "")
                .replace("MiniMax-", "MiniMax ")
                .replace("codex-agent", "Codex")
                .replace("claude-opus", "Claude Opus")
                .replace("claude-", "Claude ")
        } else {
            "暂无数据".to_string()
        };
        let token_text = if has_value {
            format_tokens(items_top[idx].1)
        } else {
            "".to_string()
        };
        let pct_text = if has_value {
            match today_total_for_pct {
                Some(total) => format!("{:.1}%", (items_top[idx].1 as f32 / total as f32) * 100.0),
                None => "".to_string(),
            }
        } else {
            "".to_string()
        };

        let base_color = if has_value {
            TEXT_PRIMARY
        } else {
            TEXT_SECONDARY
        };

        // Rank
        let rank_w = text_width(font, &rank_str, f_body);
        draw_text(
            img,
            font,
            &rank_str,
            rank_cx - (rank_w / 2.0) as i32,
            text_y,
            f_body,
            base_color,
        );

        // Name
        let name_max = if !token_text.is_empty() && show_token_col {
            token_right - (24.0 * sf) as i32 - name_x
        } else {
            pct_right - (48.0 * sf) as i32 - name_x
        }
        .max((40.0 * sf) as i32);

        let display_name_trunc = truncate_text(font, &display_name, f_body, name_max as f32);
        draw_text(
            img,
            font,
            &display_name_trunc,
            name_x,
            text_y,
            f_body,
            base_color,
        );

        // Tokens (only in wide cards)
        if !token_text.is_empty() && show_token_col {
            let tw = text_width(font, &token_text, f_small);
            draw_text(
                img,
                font,
                &token_text,
                token_right - tw as i32,
                text_y,
                f_small,
                TEXT_PRIMARY,
            );
        }

        // Pct
        if !pct_text.is_empty() {
            let pw = text_width(font, &pct_text, f_small);
            draw_text(
                img,
                font,
                &pct_text,
                pct_right - pw as i32,
                text_y,
                f_small,
                TEXT_PRIMARY,
            );
        }

        // Bar. The track alone (no fill) still shows when today's total is
        // unknown — the individual model's own token count is a real reading,
        // it just cannot honestly be drawn as a share of an unread total
        // (T10.190 plan §4 P9).
        if has_value {
            let track_x1 = name_x;
            let track_x2 = pct_right;
            draw_card(
                img,
                (track_x1, bar_y, track_x2, bar_y + bar_h),
                bar_h / 2,
                Rgba([70, 90, 125, 130]),
                Rgba([0, 0, 0, 0]),
            );

            if let Some(total) = today_total_for_pct {
                let fill_w =
                    (track_x2 - track_x1) as f32 * (items_top[idx].1 as f32 / total as f32);
                let fill_w_clamped = fill_w.clamp(0.0, (track_x2 - track_x1) as f32) as i32;
                if fill_w_clamped > 0 {
                    // ACCENT_PRIMARY, not a tool-slot colour (T10.195 review
                    // P3-4): the previous revision used a slot-3-aliased
                    // `ACCENT_TEAL` here because slot 2 (then used for
                    // "violet") only clears ~2.78:1 against this bar's own
                    // track fill (`Rgba([70, 90, 125, 130])` above) — a
                    // pre-existing gap under the retired APPLE_PURPLE too
                    // (~2.74:1). `ACCENT_PRIMARY` clears 3.64:1 / 4.05:1
                    // against the track at the two panel gradient stops (see
                    // `model_ranking_bar_fill_clears_the_graphic_threshold_against_its_track`
                    // and docs/task-logs/T10.195/), so this bar and its title
                    // dot both draw from it instead, matching the trend line.
                    let fill_color =
                        Rgba([ACCENT_PRIMARY[0], ACCENT_PRIMARY[1], ACCENT_PRIMARY[2], 235]);
                    draw_card(
                        img,
                        (track_x1, bar_y, track_x1 + fill_w_clamped, bar_y + bar_h),
                        bar_h / 2,
                        fill_color,
                        Rgba([0, 0, 0, 0]),
                    );
                }
            }
        }
    }
}

fn draw_reference_tool_distribution(
    img: &mut RgbaImage,
    font: &FontRef,
    bounds: PixelRect,
    stats: &WallStats,
    sf: f32,
) {
    let (x1, y1, x2, y2) = bounds;
    let pad = (24.0 * sf) as i32;
    let f_label = 15.0 * sf;
    draw_text(
        img,
        font,
        "工具分布",
        x1 + pad,
        y1 + (28.0 * sf) as i32,
        f_label,
        TEXT_PRIMARY,
    );

    let f_body = 13.0 * sf;
    let f_value = 18.0 * sf;
    let f_small = 12.0 * sf;

    // T10.195 review P2-2: a failed read draws the title (frame) and one
    // "不可得" line, never "暂无数据" — that wording claims a successful read
    // that simply found no usage, which is a different, real state (still
    // handled by the `total <= 0` branch just below).
    if stats.today_total == STAT_UNKNOWN {
        draw_text(
            img,
            font,
            UNKNOWN_TEXT,
            x1 + pad,
            y1 + (84.0 * sf) as i32,
            f_body,
            TEXT_SECONDARY,
        );
        return;
    }

    let mut positive_tools = stats.tool_distribution.clone();
    positive_tools.retain(|item| item.1 > 0);
    let total: i64 = positive_tools.iter().map(|item| item.1).sum();

    if total <= 0 {
        draw_text(
            img,
            font,
            "暂无数据",
            x1 + pad,
            y1 + (84.0 * sf) as i32,
            f_body,
            TEXT_SECONDARY,
        );
        return;
    }

    let w = x2 - x1;
    let h = y2 - y1;
    let cx = x1 + (w as f32 * 0.31) as i32;
    let cy = y1 + (h as f32 * 0.56) as i32;
    let r_out = (34.0 * sf).max((w as f32 * 0.19).min(h as f32 * 0.34));
    let r_in = r_out * 0.68;

    // One same-view slot assignment for both the donut and its legend below
    // (T10.187, R-8(c)): sharing it keeps a tool's dot and wedge the same
    // colour even when it collides with a higher-ranked tool's primary slot.
    let tool_names: Vec<String> = positive_tools.iter().map(|item| item.0.clone()).collect();
    let tool_colors = hud_tool_colors_for_view(&tool_names);

    let mut slices = Vec::new();
    for (idx, item) in positive_tools.iter().enumerate() {
        slices.push((item.1 as f32, tool_colors[idx]));
    }
    draw_donut(img, cx, cy, r_in, r_out, &slices);

    let center_total = format_tokens(total);
    let fit_sz = fit_font_size(font, &center_total, f_value, r_in * 1.52, 10.0 * sf);
    let value_w = text_width(font, &center_total, fit_sz);
    // "有效 Token", not "Tokens" (T10.195 review P3-7 item 1): the ring
    // centre's number is today's effective-token total (GLB-01), same as the
    // KPI row's own "有效 Token" metric.
    let label = METRIC_LABEL_EFFECTIVE_TOKENS;
    let label_w = text_width(font, label, f_small);

    let value_h = fit_sz;
    let label_h = f_small;
    let group_h = value_h + (4.0 * sf) + label_h;
    let value_y = cy - (group_h / 2.0) as i32;
    let label_y = value_y + (value_h + 4.0 * sf) as i32;

    draw_text(
        img,
        font,
        &center_total,
        cx - (value_w / 2.0) as i32,
        value_y,
        fit_sz,
        TEXT_PRIMARY,
    );
    draw_text(
        img,
        font,
        label,
        cx - (label_w / 2.0) as i32,
        label_y,
        f_small,
        TEXT_SECONDARY,
    );

    let legend_items: Vec<&(String, i64)> = positive_tools.iter().take(3).collect();
    let legend_x = x1 + (w as f32 * 0.58) as i32;
    let pct_right = x2 - (18.0 * sf) as i32;
    let row_gap = (30.0 * sf) as i32;
    let start_y = cy as f32 - row_gap as f32 * (legend_items.len() as f32 - 1.0) / 2.0 - 9.0 * sf;
    let dot = (8.0 * sf).max(5.0) as i32;

    for (idx, item) in legend_items.iter().enumerate() {
        let y = (start_y + idx as f32 * row_gap as f32) as i32;
        // legend_items is positive_tools' own first 3 entries (same order),
        // so its index also indexes tool_colors (T10.187, R-8(c)).
        let color = tool_colors[idx];
        let pct = format!(
            "{}%",
            ((item.1 as f32 / total as f32) * 100.0).round() as i32
        );
        let pct_w = text_width(font, &pct, f_small);
        let text_x = legend_x + dot + (10.0 * sf) as i32;
        let name_max =
            (pct_right - pct_w as i32 - (14.0 * sf) as i32 - text_x).max((62.0 * sf) as i32);

        let display_name = tool_display_name(&item.0);

        let display_name_trunc = truncate_text(font, &display_name, f_small, name_max as f32);

        let dot_center_y = y - (f_small * 0.34) as i32;
        draw_circle(img, legend_x + dot / 2, dot_center_y, dot / 2, color);
        draw_text(
            img,
            font,
            &display_name_trunc,
            text_x,
            y,
            f_small,
            TEXT_PRIMARY,
        );
        draw_text(
            img,
            font,
            &pct,
            pct_right - pct_w as i32,
            y,
            f_small,
            TEXT_PRIMARY,
        );
    }
}

/// Same 5-level, peak-relative tiering as the dashboard's `rhythmLevel`
/// (src/utils/insightRules.ts): `ceil(value / peak * 5)` clamped to 1..=5, or
/// 0 when there is no value to show or nothing to compare it against — never
/// a hard-coded absolute-token threshold (T10.210).
fn rhythm_level(value: i64, peak: i64) -> u8 {
    if value <= 0 || peak <= 0 {
        return 0;
    }
    let level = ((value as f64 / peak as f64) * 5.0).ceil();
    level.clamp(1.0, 5.0) as u8
}

/// The heatmap grid's "no activity" tone — also what a level of 0 blends
/// from, and the level-1..4 ramp's dark end. Close to the old absolute-scale
/// heatmap's own `val == 0` colour, kept for continuity.
const HEATMAP_EMPTY: Rgba<u8> = Rgba([20, 30, 48, 200]);

/// Single-hue ramp toward `ACCENT_PRIMARY`, at the same 22/40/58/78/100%
/// weights the dashboard's CSS `color-mix(in oklab, --color-primary X%,
/// --color-bg-elevated)` uses for `YearHeatmap` levels 1-5 (T10.206) — done in
/// plain sRGB via the existing `blend_colors` helper rather than an oklab
/// conversion, since this raster renderer has none; the visual intent (one
/// hue, peak-relative intensity, never an absolute-token colour jump) is what
/// T10.210 asks to match, not a bit-identical blend (T10.210).
fn heat_level_color(level: u8) -> Rgba<u8> {
    let pct: u32 = match level {
        1 => 22,
        2 => 40,
        3 => 58,
        4 => 78,
        5 => 100,
        _ => return HEATMAP_EMPTY,
    };
    blend_colors(HEATMAP_EMPTY, ACCENT_PRIMARY, ((pct * 255) / 100) as u8)
}

fn draw_reference_heatmap_panel(
    img: &mut RgbaImage,
    font: &FontRef,
    bounds: PixelRect,
    stats: &WallStats,
    sf: f32,
) {
    let (x1, y1, x2, y2) = bounds;
    let pad_x = (48.0 * sf) as i32;
    let pad_y = (34.0 * sf) as i32;
    let bar_w = 4.max((5.0 * sf) as i32);

    // Title accent bar
    draw_card(
        img,
        (
            x1 + pad_x,
            y1 + pad_y,
            x1 + pad_x + bar_w,
            y1 + pad_y + (24.0 * sf) as i32,
        ),
        2.max((2.0 * sf) as i32),
        ACCENT_PRIMARY,
        Rgba([0, 0, 0, 0]),
    );

    let f_title = 17.0 * sf;
    draw_text(
        img,
        font,
        "活跃度",
        x1 + pad_x + (18.0 * sf) as i32,
        y1 + pad_y - (1.0 * sf) as i32,
        f_title,
        TEXT_PRIMARY,
    );

    let legend_w = (118.0 * sf) as i32;
    let chart_x1 = x1 + pad_x;
    let chart_x2 = x2 - pad_x - legend_w;
    let chart_y1 = y1 + (76.0 * sf) as i32;
    let chart_y2 = y2 - (32.0 * sf) as i32;
    let avail_w = chart_x2 - chart_x1;
    let avail_h = chart_y2 - chart_y1;

    // T10.195 review P2-2: a failed read draws the title (frame) and one
    // "不可得" line centered in the plot area, never a full year of "0"
    // cells (`stats.heatmap` is an empty `Vec` on a failed read, which —
    // before this fix — made every cell fall back to `unwrap_or(0)` below).
    if stats.today_total == STAT_UNKNOWN {
        let tw = text_width(font, UNKNOWN_TEXT, f_title);
        draw_text(
            img,
            font,
            UNKNOWN_TEXT,
            ((chart_x1 + chart_x2) as f32 / 2.0 - tw / 2.0) as i32,
            (chart_y1 + chart_y2) / 2,
            f_title,
            TEXT_SECONDARY,
        );
        return;
    }

    let sq = ((avail_w as f32 / (52.0 + 51.0 * 0.42)) as i32)
        .min((avail_h as f32 / (7.0 + 6.0 * 0.42)) as i32);
    // Dynamic ceiling to avoid blowing past available space even with large scale factors.
    let sq = sq.max(4);
    let gap = 1.max((sq as f32 * 0.42) as i32);
    let grid_w = 52 * sq + 51 * gap;
    let grid_h = 7 * sq + 6 * gap;
    // Avoid negative offsets to prevent shifting left / upward past the panel bounds.
    let start_x = chart_x1 + 0.max((avail_w - grid_w) / 2);
    let start_y = chart_y1 + 0.max((avail_h - grid_h) / 2);

    let heatmap_map: std::collections::HashMap<String, i64> =
        stats.heatmap.iter().cloned().collect();
    // `stats.generated_at`, not a fresh `Local::now()` (T10.195 review P3-2).
    let now = stats.generated_at;
    let today = now.format("%Y-%m-%d").to_string();

    let days_to_sunday = (now.weekday().number_from_sunday() as i64 - 1 + 7) % 7;
    let current_week_sunday = now - Duration::days(days_to_sunday);
    let start_date = current_week_sunday - Duration::weeks(51);

    // Same peak-relative 5-level tiering and single-hue ramp as the dashboard's
    // `YearHeatmap` (rhythmLevel + color-mix(primary, --color-bg-elevated)) —
    // replaces the old absolute-threshold, multi-hue green scale (T10.210,
    // T10.187 review P3-5 / T10.195 review P3-8). The peak is this cell grid's
    // own displayed window (last 52 weeks), matching what `YearHeatmap` does
    // for its own displayed year.
    let peak = stats.heatmap.iter().map(|(_, v)| *v).max().unwrap_or(0);

    for col in 0..52 {
        for row in 0..7 {
            let date_val = start_date + Duration::weeks(col) + Duration::days(row);
            let ds = date_val.format("%Y-%m-%d").to_string();
            let x = start_x + col as i32 * (sq + gap);
            let y = start_y + row as i32 * (sq + gap);

            // Clip cells to card bounds.
            if x < chart_x1 || y < chart_y1 || x >= chart_x2 || y >= chart_y2 {
                continue;
            }
            let cell_x2 = (x + sq).min(chart_x2);
            let cell_y2 = (y + sq).min(chart_y2);

            let is_future = date_val > now;
            let value = heatmap_map.get(&ds).cloned().unwrap_or(0);
            let level = rhythm_level(value, peak);
            let fill = if is_future {
                Rgba([23, 34, 53, 130])
            } else {
                heat_level_color(level)
            };
            let cell_radius = 2.max((sq as f32 * 0.2) as i32);

            draw_card(
                img,
                (x, y, cell_x2, cell_y2),
                cell_radius,
                fill,
                Rgba([0, 0, 0, 0]),
            );

            // T10.206's low-level non-colour cue, ported from the dashboard's
            // 1px --color-text-faint inset border: levels 1-2 barely lift off
            // the empty tone, so a faint (never ACCENT_PRIMARY — that would
            // read as a hollow version of the solid level-5 fill) ring marks
            // them as "has some activity" without relying on hue alone.
            if !is_future && (1..=2).contains(&level) {
                draw_card(
                    img,
                    (x, y, cell_x2, cell_y2),
                    cell_radius,
                    Rgba([0, 0, 0, 0]),
                    Rgba([TEXT_SECONDARY[0], TEXT_SECONDARY[1], TEXT_SECONDARY[2], 150]),
                );
            }

            if ds == today {
                let stroke_color = Rgba([230, 255, 235, 245]);
                draw_card(
                    img,
                    (x, y, cell_x2, cell_y2),
                    cell_radius,
                    Rgba([0, 0, 0, 0]),
                    stroke_color,
                );
            }
        }
    }

    // Draw Weekday Labels (日, 二, 四, 六)
    let weekday_labels = [("日", 0), ("二", 2), ("四", 4), ("六", 6)];
    let f_legend = 11.0 * sf;
    for &(label, row) in &weekday_labels {
        let label_y = start_y + row * (sq + gap) + (sq - f_legend as i32) / 2;
        draw_text_top_left(
            img,
            font,
            label,
            start_x - (24.0 * sf) as i32,
            label_y,
            f_legend,
            TEXT_SECONDARY,
        );
    }

    // Draw Month Labels (1月 - 12月)
    let mut last_month = 0;
    for col in 0..52 {
        let date_val = start_date + Duration::weeks(col);
        let m = date_val.month();
        if m != last_month {
            last_month = m;
            let label = format!("{}月", m);
            let label_x = start_x + col as i32 * (sq + gap);
            let label_y = start_y - (20.0 * sf) as i32;
            draw_text_top_left(
                img,
                font,
                &label,
                label_x,
                label_y,
                f_legend,
                TEXT_SECONDARY,
            );
        }
    }

    // Draw Heatmap Legend
    let legend_x = x2 - pad_x - (88.0 * sf) as i32;
    let legend_y = y1 + (54.0 * sf) as i32;
    let legend_h = y2 - y1 - (72.0 * sf) as i32;
    let f_small = 11.0 * sf;

    draw_card(
        img,
        (
            legend_x,
            legend_y,
            legend_x + (88.0 * sf) as i32,
            legend_y + legend_h,
        ),
        (10.0 * sf) as i32,
        Rgba([14, 33, 58, 190]),
        Rgba([64, 111, 166, 130]),
    );
    draw_text(
        img,
        font,
        "强度",
        legend_x + (30.0 * sf) as i32,
        legend_y + (18.0 * sf) as i32,
        f_small,
        TEXT_PRIMARY,
    );

    // Representative levels 5/3/1/0 out of the same 5-level ramp the grid
    // above draws with (T10.210) — matches the dashboard legend's own choice
    // of not spelling out every one of the 5 levels.
    let legend_items = [
        ("高", heat_level_color(5)),
        ("中", heat_level_color(3)),
        ("低", heat_level_color(1)),
        ("无", heat_level_color(0)),
    ];
    for (idx, &(label, color)) in legend_items.iter().enumerate() {
        let y = legend_y + (44.0 * sf) as i32 + idx as i32 * (22.0 * sf) as i32;
        draw_card(
            img,
            (
                legend_x + (26.0 * sf) as i32,
                y,
                legend_x + (44.0 * sf) as i32,
                y + (8.0 * sf) as i32,
            ),
            (3.0 * sf) as i32,
            color,
            Rgba([0, 0, 0, 0]),
        );
        draw_text(
            img,
            font,
            label,
            legend_x + (58.0 * sf) as i32,
            y - (2.0 * sf) as i32,
            f_small,
            TEXT_SECONDARY,
        );
    }
}

// ============ DRAW LOCKSCREEN COMPONENTS ============

fn draw_lockscreen_scene_background(width: u32, height: u32, sf: f32) -> RgbaImage {
    // The lock screen needs to stay visually calm around the system clock and
    // sign-in affordances. Use the curated raster background as the primary
    // scene, while keeping the legacy procedural scene below as a resilient
    // fallback if the embedded asset can ever not be decoded.
    if let Ok(source) = image::load_from_memory(include_bytes!("../assets/lockscreen-bg-v2.png")) {
        let source = source.to_rgba8();
        let scale =
            (width as f32 / source.width() as f32).max(height as f32 / source.height() as f32);
        let resized_width = (source.width() as f32 * scale).ceil() as u32;
        let resized_height = (source.height() as f32 * scale).ceil() as u32;
        let resized = image::imageops::resize(
            &source,
            resized_width,
            resized_height,
            image::imageops::FilterType::Lanczos3,
        );
        let crop_x = resized_width.saturating_sub(width) / 2;
        let crop_y = resized_height.saturating_sub(height) / 2;
        return image::imageops::crop_imm(&resized, crop_x, crop_y, width, height).to_image();
    }

    let mut img = ImageBuffer::new(width, height);
    // Gradient: (4,11,26) to (1,4,12)
    draw_vertical_gradient(&mut img, Rgba([6, 14, 32, 255]), Rgba([2, 6, 16, 255]));

    let w_f = width as f32;
    let h_f = height as f32;
    let ui_sf = sf * (width as f32 / 1920.0).min(height as f32 / 1080.0);

    // Soft blooms: non-tool accents, replacing APPLE_BLUE and an inline
    // literal that was APPLE_INDIGO's RGB (T10.190 plan §4 P9 / §6.8). The
    // second bloom uses the neutral token, not a tool-identity colour (T10.195
    // review P3-4) — this fallback scene only renders if the embedded
    // lock-screen bitmap ever fails to decode (see
    // `draw_lockscreen_scene_background`'s own doc comment above).
    draw_ambient_blob(
        &mut img,
        (w_f * 0.58) as i32,
        (h_f * 0.42) as i32,
        (w_f * 0.42) as i32,
        ACCENT_PRIMARY,
        38,
    );
    draw_ambient_blob(
        &mut img,
        (w_f * 0.42) as i32,
        (h_f * 0.58) as i32,
        (w_f * 0.26) as i32,
        ACCENT_NEUTRAL,
        28,
    );

    // Stars
    let mut seed = 20260605_u64;
    let mut rand = move || -> u64 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        seed
    };

    for _ in 0..90 {
        let x = (w_f * 0.40) as i32 + (rand() as i32).abs() % ((w_f * 0.36) as i32).max(1);
        let y = (h_f * 0.08) as i32 + (rand() as i32).abs() % ((h_f * 0.37) as i32).max(1);
        let a = 45 + (rand() % 95) as u8;
        let r = 1 + (rand() % 3) as i32;
        draw_circle(&mut img, x, y, r, Rgba([180, 215, 255, a]));
    }

    // Ocean band
    let horizon = (h_f * 0.610) as i32;
    for y in horizon..(height as i32) {
        let t = (y - horizon) as f32 / (height as i32 - horizon).max(1) as f32;
        let r = (11.0 + 8.0 * (1.0 - t)) as u8;
        let g = (33.0 + 20.0 * (1.0 - t)) as u8;
        let b = (58.0 + 52.0 * (1.0 - t)) as u8;
        let a = (218.0 - 76.0 * t) as u8;
        draw_line_horizontal(&mut img, 0, width as i32 - 1, y, Rgba([r, g, b, 255]), a);
    }

    // Horizon line
    for y in (horizon - 1)..=(horizon + 2) {
        draw_line_horizontal(
            &mut img,
            0,
            width as i32 - 1,
            y,
            Rgba([70, 125, 170, 255]),
            110,
        );
    }

    // Ocean waves
    for idx in 0..34 {
        let y = horizon
            + ((idx * idx) as f32 / 34.0 * h_f * 0.010) as i32
            + (idx as f32 * ui_sf * 1.65) as i32;
        let x1 = (w_f * (0.23 + (idx % 7) as f32 * 0.016)) as i32;
        let x2 = (w_f * (0.75 - (idx % 5) as f32 * 0.014)) as i32;
        let alpha = (58 - idx).max(8) as u8;
        draw_line_horizontal(&mut img, x1, x2, y, Rgba([126, 182, 230, 255]), alpha);
    }

    let draw_poly = |im: &mut RgbaImage, pts: &[(f32, f32)], fill: Rgba<u8>| {
        let pts_scaled: Vec<(f32, f32)> =
            pts.iter().map(|&(px, py)| (px * w_f, py * h_f)).collect();
        draw_polygon(im, &pts_scaled, fill);
    };

    // Sea stacks (rocks)
    draw_poly(
        &mut img,
        &[
            (0.59, 0.62),
            (0.64, 0.45),
            (0.69, 0.57),
            (0.74, 0.63),
            (0.69, 0.66),
        ],
        Rgba([8, 20, 29, 235]),
    );
    draw_poly(
        &mut img,
        &[
            (0.35, 0.63),
            (0.38, 0.51),
            (0.44, 0.62),
            (0.48, 0.66),
            (0.39, 0.66),
        ],
        Rgba([8, 19, 30, 232]),
    );
    draw_poly(
        &mut img,
        &[
            (0.47, 0.64),
            (0.49, 0.61),
            (0.515, 0.64),
            (0.535, 0.66),
            (0.49, 0.66),
        ],
        Rgba([7, 17, 28, 205]),
    );

    for &x in &[0.38_f32, 0.62_f32, 0.66_f32] {
        draw_circle(
            &mut img,
            (w_f * x) as i32,
            horizon + (46.0 * ui_sf) as i32,
            (18.0 * ui_sf) as i32,
            Rgba([78, 128, 180, 22]),
        );
    }

    // Cave foreground silhouettes
    draw_poly(
        &mut img,
        &[
            (0.0, 0.0),
            (1.0, 0.0),
            (1.0, 0.16),
            (0.92, 0.18),
            (0.84, 0.12),
            (0.75, 0.05),
            (0.59, 0.05),
            (0.50, 0.13),
            (0.42, 0.23),
            (0.31, 0.31),
            (0.21, 0.33),
            (0.15, 0.43),
            (0.0, 0.56),
        ],
        Rgba([0, 3, 10, 244]),
    );
    draw_poly(
        &mut img,
        &[
            (0.0, 0.0),
            (0.0, 1.0),
            (0.43, 1.0),
            (0.36, 0.86),
            (0.31, 0.73),
            (0.24, 0.61),
            (0.17, 0.51),
            (0.14, 0.42),
            (0.0, 0.56),
        ],
        Rgba([0, 3, 10, 244]),
    );
    draw_poly(
        &mut img,
        &[
            (0.78, 0.0),
            (1.0, 0.0),
            (1.0, 1.0),
            (0.84, 1.0),
            (0.80, 0.86),
            (0.78, 0.68),
            (0.765, 0.49),
            (0.78, 0.30),
        ],
        Rgba([0, 3, 10, 236]),
    );
    draw_poly(
        &mut img,
        &[
            (0.0, 1.0),
            (1.0, 1.0),
            (1.0, 0.87),
            (0.86, 0.84),
            (0.66, 0.80),
            (0.43, 0.79),
            (0.26, 0.82),
            (0.0, 0.85),
        ],
        Rgba([0, 4, 12, 214]),
    );

    // Rock textures on cave borders
    for _ in 0..260 {
        let side = rand() % 3;
        let (x, y, length, angle) = match side {
            0 => {
                // top
                let x = (rand() as i32).abs() % width as i32;
                let y = (rand() as i32).abs() % (h_f * 0.34) as i32;
                let length = 24.0 * ui_sf + (rand() as f32 / u64::MAX as f32) * 86.0 * ui_sf;
                let angle = 0.15 + (rand() as f32 / u64::MAX as f32) * 0.70;
                (x, y, length, angle)
            }
            1 => {
                // left
                let x = (rand() as i32).abs() % (w_f * 0.38) as i32;
                let y = (h_f * 0.18) as i32
                    + (rand() as i32).abs() % (height as i32 - (h_f * 0.18) as i32).max(1);
                let length = 30.0 * ui_sf + (rand() as f32 / u64::MAX as f32) * 110.0 * ui_sf;
                let angle = 0.45 + (rand() as f32 / u64::MAX as f32) * 0.70;
                (x, y, length, angle)
            }
            _ => {
                // right
                let x = (w_f * 0.76) as i32
                    + (rand() as i32).abs() % (width as i32 - (w_f * 0.76) as i32).max(1);
                let y = (rand() as i32).abs() % height as i32;
                let length = 34.0 * ui_sf + (rand() as f32 / u64::MAX as f32) * 116.0 * ui_sf;
                let angle = 1.85 + (rand() as f32 / u64::MAX as f32) * 0.70;
                (x, y, length, angle)
            }
        };
        let dx = angle.cos() * length;
        let dy = angle.sin() * length;
        let alpha = 8 + (rand() % 27) as u8;
        draw_line(
            &mut img,
            x as f32,
            y as f32,
            x as f32 + dx,
            y as f32 + dy,
            Rgba([18, 62, 86, alpha]),
            1.0 * ui_sf,
        );
    }

    img
}

/// Visual weight of an hourly rhythm chart. The compact profile is what fits in
/// the lock-screen summary card; the full profile is the standalone panel.
struct RhythmChartStyle {
    show_value_axis: bool,
    show_hour_labels: bool,
    show_legend: bool,
    grid_rows: i32,
    today_stroke: f32,
    today_glow: f32,
    yesterday_area_alpha: u8,
    yesterday_outline_alpha: u8,
    dash_len: f32,
    dash_gap: f32,
    outline_stroke: f32,
    current_dot_radius: f32,
    label_font: f32,
}

impl RhythmChartStyle {
    fn compact(sf: f32) -> Self {
        Self {
            show_value_axis: false,
            show_hour_labels: true,
            show_legend: true,
            grid_rows: 3,
            today_stroke: 1.8 * sf,
            today_glow: 3.5 * sf,
            // 30, not 42 (T10.195 review open point 2): lowers the "yesterday"
            // area fill toward the WCAG 1.4.11 decorative allowance while the
            // dashed outline (which carries the actual shape) keeps its own
            // higher-contrast alpha below.
            yesterday_area_alpha: 30,
            yesterday_outline_alpha: AXIS_ACCENT_ALPHA,
            dash_len: 4.0 * sf,
            dash_gap: 4.0 * sf,
            outline_stroke: 1.0 * sf,
            current_dot_radius: 3.0 * sf,
            label_font: 10.0 * sf,
        }
    }

    fn full(sf: f32) -> Self {
        Self {
            show_value_axis: true,
            show_hour_labels: true,
            show_legend: true,
            grid_rows: 5,
            today_stroke: 1.5 * sf,
            today_glow: 3.5 * sf,
            // 27, not 38 — same ratio as `compact`'s 42 -> 30 (T10.195 review
            // open point 2: "full 按同比例降低").
            yesterday_area_alpha: 27,
            yesterday_outline_alpha: AXIS_ACCENT_ALPHA,
            dash_len: 5.0 * sf,
            dash_gap: 5.0 * sf,
            outline_stroke: 1.2 * sf,
            current_dot_radius: 3.5 * sf,
            label_font: 14.0 * sf,
        }
    }
}

/// Dashed stroke that follows a polyline, so a curve can carry a dashed outline
/// without being decomposed into straight axis-aligned runs.
fn draw_dashed_polyline(
    img: &mut RgbaImage,
    points: &[(f32, f32)],
    color: Rgba<u8>,
    dash_len: f32,
    gap_len: f32,
    thickness: f32,
) {
    if points.len() < 2 || dash_len <= 0.0 {
        return;
    }
    let period = dash_len + gap_len.max(0.0);
    let mut travelled = 0.0_f32;
    for segment in points.windows(2) {
        let (ax, ay) = segment[0];
        let (bx, by) = segment[1];
        let seg_len = ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt();
        if seg_len <= f32::EPSILON {
            continue;
        }
        let mut consumed = 0.0_f32;
        while consumed < seg_len {
            let phase = (travelled + consumed) % period;
            if phase < dash_len {
                let remaining_dash = (dash_len - phase).min(seg_len - consumed);
                let t0 = consumed / seg_len;
                let t1 = (consumed + remaining_dash) / seg_len;
                draw_line(
                    img,
                    ax + (bx - ax) * t0,
                    ay + (by - ay) * t0,
                    ax + (bx - ax) * t1,
                    ay + (by - ay) * t1,
                    color,
                    thickness,
                );
                consumed += remaining_dash.max(0.5);
            } else {
                consumed += (period - phase).min(seg_len - consumed).max(0.5);
            }
        }
        travelled = (travelled + seg_len) % period;
    }
}

/// Draws the shared "24 小时节奏" chart: yesterday as a translucent filled area
/// with a dashed outline, today as a solid curve truncated at the current hour.
///
/// `x1..x2` / `y1..y2` is the plot band itself — callers reserve their own space
/// for the section title, legend and hour labels around it.
#[allow(clippy::too_many_arguments)]
fn draw_hourly_rhythm_chart(
    img: &mut RgbaImage,
    font: &FontRef,
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
    today: &[i64],
    yesterday: &[i64],
    current_hour: usize,
    style: &RhythmChartStyle,
    sf: f32,
) {
    let has_today = today.iter().any(|&v| v > 0);
    let has_yesterday = yesterday.iter().any(|&v| v > 0);

    if !has_today && !has_yesterday {
        // Honest empty state instead of a flat line pretending to be a reading.
        let text = "今日与昨日均无记录";
        let tw = text_width(font, text, style.label_font);
        draw_text(
            img,
            font,
            text,
            x1 + ((x2 - x1) as f32 - tw) as i32 / 2,
            y1 + (y2 - y1) / 2 + (style.label_font * 0.35) as i32,
            style.label_font,
            Rgba([174, 196, 224, 120]),
        );
        return;
    }

    // One shared axis so the two days are actually comparable.
    let combined: Vec<i64> = today.iter().chain(yesterday.iter()).cloned().collect();
    let max_val = nice_axis_max(&combined);
    let baseline_y = y2 as f32;
    // Both series share one x mapping: hour -> x1 + hour / axis_span * width.
    // Today's series is shorter than yesterday's, so the denominator must come
    // from the day length, never from the slice length.
    let axis_span = (today.len().max(yesterday.len()).max(2) - 1) as f32;

    if style.grid_rows > 0 {
        for row in 0..=style.grid_rows {
            let y = y1 + ((y2 - y1) * row) / style.grid_rows;
            if row == style.grid_rows {
                draw_line(
                    img,
                    x1 as f32,
                    y as f32,
                    x2 as f32,
                    y as f32,
                    Rgba([ACCENT_AXIS[0], ACCENT_AXIS[1], ACCENT_AXIS[2], 70]),
                    1.0 * sf,
                );
            } else {
                draw_dashed_line(
                    img,
                    (x1 as f32, y as f32),
                    (x2 as f32, y as f32),
                    Rgba([ACCENT_AXIS[0], ACCENT_AXIS[1], ACCENT_AXIS[2], 40]),
                    (5.0 * sf, 7.0 * sf),
                    0.9 * sf,
                );
            }
            if style.show_value_axis {
                let value = max_val * (style.grid_rows - row) as f64 / style.grid_rows as f64;
                let label = if row == style.grid_rows {
                    "0".to_string()
                } else {
                    format_axis_token(value)
                };
                let lw = text_width(font, &label, style.label_font);
                draw_text(
                    img,
                    font,
                    &label,
                    x1 - (14.0 * sf) as i32 - lw as i32,
                    y + (style.label_font * 0.35) as i32,
                    style.label_font,
                    Rgba([178, 191, 214, 150]),
                );
            }
        }
    }

    // Yesterday: full day, translucent area plus a thin dashed outline. Drawn
    // first so today's solid curve always wins the overlap.
    if has_yesterday {
        let yesterday_values: Vec<f64> = yesterday.iter().map(|&v| v as f64).collect();
        let yesterday_points = monotone_curve_points(
            &yesterday_values,
            x1 as f32,
            x2 as f32,
            y1 as f32,
            y2 as f32,
            max_val,
            axis_span,
        );
        if yesterday_points.len() > 1 {
            // Area fill stays ACCENT_NEUTRAL (the pill's own neutral token);
            // only the outline moves to ACCENT_AXIS (T10.195 review P3-4/§6.3).
            fill_curve_area(
                img,
                &yesterday_points,
                baseline_y,
                ACCENT_NEUTRAL,
                style.yesterday_area_alpha,
            );
            draw_dashed_polyline(
                img,
                &yesterday_points,
                Rgba([
                    ACCENT_AXIS[0],
                    ACCENT_AXIS[1],
                    ACCENT_AXIS[2],
                    style.yesterday_outline_alpha,
                ]),
                style.dash_len,
                style.dash_gap,
                style.outline_stroke,
            );
        }
    }

    // Today: solid curve that stops at the current hour. Hours that have not
    // happened yet are stored as 0, so they are cut away rather than drawn —
    // otherwise the curve would fall to the baseline and show a collapse in
    // usage that is really just the rest of the day not existing yet.
    if !today.is_empty() {
        let last_hour = current_hour.min(today.len() - 1);
        let today_values: Vec<f64> = today[..=last_hour].iter().map(|&v| v as f64).collect();
        let today_points = monotone_curve_points(
            &today_values,
            x1 as f32,
            x2 as f32,
            y1 as f32,
            y2 as f32,
            max_val,
            axis_span,
        );
        if today_points.len() > 1 {
            for segment in today_points.windows(2) {
                draw_line(
                    img,
                    segment[0].0,
                    segment[0].1,
                    segment[1].0,
                    segment[1].1,
                    Rgba([ACCENT_PRIMARY[0], ACCENT_PRIMARY[1], ACCENT_PRIMARY[2], 60]),
                    style.today_glow,
                );
            }
            for segment in today_points.windows(2) {
                draw_line(
                    img,
                    segment[0].0,
                    segment[0].1,
                    segment[1].0,
                    segment[1].1,
                    ACCENT_PRIMARY,
                    style.today_stroke,
                );
            }
        }
        // Before 01:00 there is only one sample, so there is no line to draw —
        // but the reading still exists and deserves its marker.
        let (mx, my) = today_points.last().copied().unwrap_or_else(|| {
            (
                x1 as f32 + (last_hour as f32 / axis_span.max(1.0)) * (x2 - x1) as f32,
                y2 as f32 - (today[last_hour] as f32 / max_val.max(1.0) as f32) * (y2 - y1) as f32,
            )
        });
        draw_circle(
            img,
            mx as i32,
            my as i32,
            (style.current_dot_radius * 1.6) as i32,
            Rgba([ACCENT_PRIMARY[0], ACCENT_PRIMARY[1], ACCENT_PRIMARY[2], 60]),
        );
        draw_circle(
            img,
            mx as i32,
            my as i32,
            style.current_dot_radius as i32,
            ACCENT_PRIMARY,
        );
    }

    if style.show_hour_labels {
        for hour in [0_i32, 6, 12, 18, 24] {
            let label = format!("{hour:02}");
            let tw = text_width(font, &label, style.label_font);
            let x = x1 as f32 + (hour as f32 / axis_span.max(1.0)) * (x2 - x1) as f32;
            // Keep the first and last label inside the plot band.
            let text_x = (x - tw / 2.0).max(x1 as f32).min(x2 as f32 - tw).round() as i32;
            draw_text(
                img,
                font,
                &label,
                text_x,
                y2 + (style.label_font * 1.15) as i32,
                style.label_font,
                Rgba([174, 196, 224, 118]),
            );
        }
    }

    if style.show_legend {
        let legend_font = style.label_font;
        let swatch = 18.0 * sf;
        let gap = 6.0 * sf;
        let today_label = "今日";
        let yesterday_label = "昨日";
        let today_w = text_width(font, today_label, legend_font);
        let yesterday_w = text_width(font, yesterday_label, legend_font);
        let total = swatch + gap + today_w + 14.0 * sf + swatch + gap + yesterday_w;
        let mut cursor = x2 as f32 - total;
        let legend_y = y1 as f32 - 7.0 * sf;

        draw_line(
            img,
            cursor,
            legend_y,
            cursor + swatch,
            legend_y,
            ACCENT_PRIMARY,
            style.today_stroke,
        );
        draw_text(
            img,
            font,
            today_label,
            (cursor + swatch + gap) as i32,
            (legend_y + legend_font * 0.35) as i32,
            legend_font,
            Rgba([174, 196, 224, 170]),
        );
        cursor += swatch + gap + today_w + 14.0 * sf;

        draw_dashed_polyline(
            img,
            &[(cursor, legend_y), (cursor + swatch, legend_y)],
            Rgba([
                ACCENT_AXIS[0],
                ACCENT_AXIS[1],
                ACCENT_AXIS[2],
                style.yesterday_outline_alpha,
            ]),
            style.dash_len,
            style.dash_gap,
            style.outline_stroke,
        );
        draw_text(
            img,
            font,
            yesterday_label,
            (cursor + swatch + gap) as i32,
            (legend_y + legend_font * 0.35) as i32,
            legend_font,
            Rgba([174, 196, 224, 170]),
        );
    }
}

/// Index of the last hourly bucket that has any elapsed time in it.
///
/// The current hour is included even though it is only partially over: a
/// partial bucket is a real reading, whereas hour+1 is a structural zero.
/// Takes `now` explicitly rather than calling `Local::now()` itself (T10.195
/// review P3-2): callers pass `stats.generated_at`.
fn current_hour_index(now: DateTime<Local>) -> usize {
    now.hour() as usize
}

fn draw_lockscreen_summary_card(
    img: &mut RgbaImage,
    font: &FontRef,
    bounds: PixelRect,
    stats: &WallStats,
    sf: f32,
) {
    let (x1, y1, x2, y2) = bounds;
    let px = |value: f32| -> i32 { (value * sf).round() as i32 };
    let pad = px(30.0);
    let card_width = x2 - x1;

    draw_card(
        img,
        (x1, y1, x2, y2),
        px(24.0),
        Rgba([3, 10, 22, 176]),
        Rgba([132, 178, 226, 48]),
    );

    // Quiet header: the card reads as one product surface instead of a stack
    // of dashboard widgets competing with the Windows lock-screen UI.
    draw_circle(img, x1 + pad, y1 + px(34.0), px(4.0).max(2), ACCENT_PRIMARY);
    draw_text(
        img,
        font,
        METRIC_LABEL_EFFECTIVE_TOKENS,
        x1 + pad + px(14.0),
        y1 + px(40.0),
        15.0 * sf,
        TEXT_PRIMARY,
    );
    let brand = "TOKENLEDGER";
    let brand_font = 10.5 * sf;
    let brand_width = text_width(font, brand, brand_font);
    draw_text(
        img,
        font,
        brand,
        x2 - pad - brand_width as i32,
        y1 + px(39.0),
        brand_font,
        Rgba([174, 196, 224, 142]),
    );

    // T10.195 review P3-1: one shared MetricTexts computation for both
    // metrics, instead of each inlining its own format_known_*/ChangeBadge
    // call — see metric_texts's own doc comment.
    let texts = metric_texts(stats);
    let value_font = fit_font_size(
        font,
        &texts.token_value,
        46.0 * sf,
        card_width as f32 - (pad * 2) as f32 - 74.0 * sf,
        31.0 * sf,
    );
    let value_y = y1 + px(105.0);
    draw_text(
        img,
        font,
        &texts.token_value,
        x1 + pad,
        value_y,
        value_font,
        TEXT_PRIMARY,
    );
    // No separate "Tokens" unit label here (T10.195): METRIC_LABEL_EFFECTIVE_TOKENS
    // above already names the unit, so repeating it next to the number was
    // redundant once the title changed from "今日消耗" to "有效 Token".

    let badge_width =
        draw_lockscreen_badge(img, font, x1 + pad, y1 + px(126.0), &texts.token_badge, sf);
    draw_text(
        img,
        font,
        COMPARE_LABEL,
        x1 + pad + badge_width + px(12.0),
        y1 + px(146.0),
        12.0 * sf,
        TEXT_SECONDARY,
    );

    let separator_y = y1 + px(178.0);
    draw_line(
        img,
        (x1 + pad) as f32,
        separator_y as f32,
        (x2 - pad) as f32,
        separator_y as f32,
        Rgba([112, 148, 190, 50]),
        0.9 * sf,
    );

    let middle_x = x1 + card_width / 2;
    draw_text(
        img,
        font,
        METRIC_LABEL_RECORD_COUNT,
        x1 + pad,
        y1 + px(211.0),
        12.0 * sf,
        TEXT_SECONDARY,
    );
    draw_text(
        img,
        font,
        &texts.record_value,
        x1 + pad,
        y1 + px(246.0),
        25.0 * sf,
        TEXT_PRIMARY,
    );

    draw_line(
        img,
        middle_x as f32,
        (y1 + px(198.0)) as f32,
        middle_x as f32,
        (y1 + px(256.0)) as f32,
        Rgba([112, 148, 190, 42]),
        0.8 * sf,
    );

    let model_x = middle_x + px(24.0);
    draw_text(
        img,
        font,
        "主力模型",
        model_x,
        y1 + px(211.0),
        12.0 * sf,
        TEXT_SECONDARY,
    );
    // T10.195 review P2-2: "暂无数据" claims a successful read that simply
    // found no top model; a failed read must say "不可得" instead.
    let model_name = if stats.today_total == STAT_UNKNOWN {
        UNKNOWN_TEXT
    } else {
        stats
            .model_ranking
            .first()
            .map(|(name, _)| name.as_str())
            .unwrap_or("暂无数据")
    };
    let model_text = truncate_text(font, model_name, 15.0 * sf, (x2 - pad - model_x) as f32);
    draw_text(
        img,
        font,
        &model_text,
        model_x,
        y1 + px(245.0),
        15.0 * sf,
        TEXT_PRIMARY,
    );

    draw_text(
        img,
        font,
        "24 小时节奏",
        x1 + pad,
        y1 + px(286.0),
        11.0 * sf,
        Rgba([174, 196, 224, 156]),
    );
    // The plot band is 92 layout units tall. The previous 22-unit band over a
    // ~330-unit width was a 15:1 box, so no interpolation could make the line
    // read as a curve; the height is the fix, the interpolation is the polish.
    let rhythm_bounds = (x1 + pad, y1 + px(312.0), x2 - pad, y1 + px(404.0));
    if stats.today_total == STAT_UNKNOWN {
        // T10.195 review P2-2: a failed read leaves both `hourly_trend` and
        // `yesterday_hourly_trend` at `vec![0; 24]` (fetch_stats_at's failure
        // path), which would otherwise hit `draw_hourly_rhythm_chart`'s own
        // "今日与昨日均无记录" branch — a real, honest message for a genuinely
        // quiet day, but a false one for a read that never happened. One
        // "不可得" line in the same plot band instead.
        let (rx1, ry1, rx2, ry2) = rhythm_bounds;
        let tw = text_width(font, UNKNOWN_TEXT, 11.0 * sf);
        draw_text(
            img,
            font,
            UNKNOWN_TEXT,
            ((rx1 + rx2) as f32 / 2.0 - tw / 2.0) as i32,
            (ry1 + ry2) / 2,
            11.0 * sf,
            Rgba([174, 196, 224, 170]),
        );
    } else {
        let (rx1, ry1, rx2, ry2) = rhythm_bounds;
        draw_hourly_rhythm_chart(
            img,
            font,
            rx1,
            ry1,
            rx2,
            ry2,
            &stats.hourly_trend,
            &stats.yesterday_hourly_trend,
            current_hour_index(stats.generated_at),
            &RhythmChartStyle::compact(sf),
            sf,
        );
    }
}

// Full-size standalone rhythm panel. Kept as a layout alternative for a future
// user-selectable lock-screen mode; it now shares draw_hourly_rhythm_chart with
// the summary card so the two can no longer drift apart.
#[allow(dead_code)]
fn draw_lockscreen_main_trend(
    img: &mut RgbaImage,
    font: &FontRef,
    bounds: PixelRect,
    stats: &WallStats,
    sf: f32,
) {
    let (x1, y1, x2, y2) = bounds;
    draw_hourly_rhythm_chart(
        img,
        font,
        x1,
        y1,
        x2,
        y2,
        &stats.hourly_trend,
        &stats.yesterday_hourly_trend,
        current_hour_index(stats.generated_at),
        &RhythmChartStyle::full(sf),
        sf,
    );
}

/// The lock-screen change pill. Colour is always `ACCENT_NEUTRAL`: never
/// red/green for down/up (T10.190 plan §4 P9 / §6.8) — direction is conveyed
/// only by `text` itself (T10.195 review P2-1: `text` is `ChangeBadge::text()`'s
/// output, e.g. "+17% ↑"/"不可得"/"基线缺失"/"新增"/"持平" (T10.210), drawn verbatim here — this
/// function used to re-derive its own arrow-first, sign-kept label from the
/// string's leading character, e.g. "↓-3.0%" against the desktop's
/// "-3.0% ↓"; that duplicated, drifting logic is gone, see P3-7 item 2).
fn draw_lockscreen_badge(
    img: &mut RgbaImage,
    font: &FontRef,
    x: i32,
    y: i32,
    text: &str,
    sf: f32,
) -> i32 {
    let label = text;
    let h = (28.0 * sf) as i32;
    let w = text_width(font, label, 12.0 * sf) as i32 + (24.0 * sf) as i32;

    // Same alpha regardless of the badge's state — see NEUTRAL_ACCENT_ALPHA's
    // doc comment; the states differ only in `label`'s text.
    let fill = Rgba([
        ACCENT_NEUTRAL[0],
        ACCENT_NEUTRAL[1],
        ACCENT_NEUTRAL[2],
        NEUTRAL_ACCENT_ALPHA,
    ]);

    draw_card(img, (x, y, x + w, y + h), h / 2, fill, Rgba([0, 0, 0, 0]));

    let f = 12.0 * sf;
    let text_w = text_width(font, label, f);
    let baseline = y + h / 2 + (f * 0.34) as i32;
    draw_text(
        img,
        font,
        label,
        x + ((w as f32 - text_w) / 2.0) as i32,
        baseline,
        f,
        TEXT_PRIMARY,
    );

    w
}

#[allow(dead_code)]
fn draw_lockscreen_kpi_panel(
    img: &mut RgbaImage,
    font: &FontRef,
    bounds: PixelRect,
    stats: &WallStats,
    sf: f32,
) {
    let (x1, y1, x2, y2) = bounds;
    let pad = (24.0 * sf) as i32;
    let dot = (8.0 * sf).max(6.0) as i32;

    let f_label = 14.0 * sf;
    let f_value = 30.0 * sf;
    let f_body = 12.0 * sf;

    let draw_section_title = |img_ref: &mut RgbaImage, y: i32, col: Rgba<u8>, title: &str| {
        draw_dot_title(
            img_ref,
            font,
            (x1 + pad, y),
            (dot, (12.0 * sf) as i32),
            title,
            f_label,
            (col, TEXT_PRIMARY),
        );
    };

    // 1. Today Tokens
    let val_y1 = y1 + (30.0 * sf) as i32;
    draw_section_title(img, val_y1, ACCENT_PRIMARY, METRIC_LABEL_EFFECTIVE_TOKENS);

    let value_y = y1 + (78.0 * sf) as i32;
    let value_text = format_known_tokens(stats.today_total);
    let fit_sz = fit_font_size(
        font,
        &value_text,
        f_value,
        x2 as f32 - x1 as f32 - pad as f32 * 2.0 - 70.0 * sf,
        19.0 * sf,
    );

    draw_text(
        img,
        font,
        &value_text,
        x1 + pad,
        value_y,
        fit_sz,
        TEXT_PRIMARY,
    );
    // No separate "Tokens" unit label (T10.195): title says 有效 Token
    // already; see the identical fix in draw_lockscreen_summary_card.

    let pct_txt = ChangeBadge::classify(stats.today_total, stats.yesterday_total).text();

    let badge_w = draw_lockscreen_badge(
        img,
        font,
        x1 + pad,
        value_y + (48.0 * sf) as i32,
        &pct_txt,
        sf,
    );
    draw_text(
        img,
        font,
        COMPARE_LABEL,
        x1 + pad + badge_w + (12.0 * sf) as i32,
        value_y + (53.0 * sf) as i32,
        f_body,
        TEXT_SECONDARY,
    );

    // Separator 1
    let sep1 = y1 + (170.0 * sf) as i32;
    draw_line(
        img,
        (x1 + pad) as f32,
        sep1 as f32,
        (x2 - pad) as f32,
        sep1 as f32,
        Rgba([70, 108, 150, 62]),
        0.8 * sf,
    );

    // 2. Requests
    let val_y2 = y1 + (205.0 * sf) as i32;
    draw_section_title(img, val_y2, ACCENT_PRIMARY, METRIC_LABEL_RECORD_COUNT);

    let req_y = y1 + (252.0 * sf) as i32;
    let req_text = format_known_count(stats.today_requests);
    let req_fit_sz = fit_font_size(
        font,
        &req_text,
        f_value,
        x2 as f32 - x1 as f32 - pad as f32 * 2.0,
        19.0 * sf,
    );
    draw_text(
        img,
        font,
        &req_text,
        x1 + pad,
        req_y,
        req_fit_sz,
        TEXT_PRIMARY,
    );

    let pct_r_txt = ChangeBadge::classify(stats.today_requests, stats.yesterday_requests).text();
    let badge_w_r = draw_lockscreen_badge(
        img,
        font,
        x1 + pad,
        req_y + (48.0 * sf) as i32,
        &pct_r_txt,
        sf,
    );
    draw_text(
        img,
        font,
        COMPARE_LABEL,
        x1 + pad + badge_w_r + (12.0 * sf) as i32,
        req_y + (53.0 * sf) as i32,
        f_body,
        TEXT_SECONDARY,
    );

    // Separator 2
    let sep2 = y1 + (340.0 * sf) as i32;
    draw_line(
        img,
        (x1 + pad) as f32,
        sep2 as f32,
        (x2 - pad) as f32,
        sep2 as f32,
        Rgba([70, 108, 150, 62]),
        0.8 * sf,
    );

    // 3. Compact Trend Sparkline
    let val_y3 = y1 + (372.0 * sf) as i32;
    draw_section_title(img, val_y3, ACCENT_PRIMARY, "24 小时趋势");

    let compact_vals = smooth_series(&bucket_hourly_values(&stats.hourly_trend, 2), 1);
    let spark_x1 = x1 + pad;
    let spark_y1 = y1 + (424.0 * sf) as i32;
    let spark_x2 = x2 - pad;
    let spark_y2 = y2 - (32.0 * sf) as i32;
    let max_val = compact_vals
        .iter()
        .cloned()
        .fold(f64::MIN, f64::max)
        .max(1.0);

    let pts = series_points(
        &compact_vals,
        spark_x1 as f32,
        spark_y1 as f32,
        spark_x2 as f32,
        spark_y2 as f32,
        max_val,
    );
    if pts.len() > 1 {
        for i in 0..(pts.len() - 1) {
            let p1 = pts[i];
            let p2 = pts[i + 1];
            draw_line(img, p1.0, p1.1, p2.0, p2.1, ACCENT_PRIMARY, 2.4 * sf);
        }
    }
}

#[allow(dead_code)]
fn draw_lockscreen_tool_distribution_panel(
    img: &mut RgbaImage,
    font: &FontRef,
    bounds: PixelRect,
    stats: &WallStats,
    sf: f32,
) {
    let (x1, y1, x2, y2) = bounds;
    let pad = (28.0 * sf) as i32;
    let f_label = 14.0 * sf;
    draw_text(
        img,
        font,
        "工具分布",
        x1 + pad,
        y1 + (26.0 * sf) as i32,
        f_label,
        TEXT_PRIMARY,
    );

    let mut positive_tools = stats.tool_distribution.clone();
    positive_tools.retain(|item| item.1 > 0);
    let total: i64 = positive_tools.iter().map(|item| item.1).sum();

    let f_body = 12.0 * sf;
    let f_value = 17.0 * sf;
    let f_small = 12.0 * sf;

    if total <= 0 {
        draw_text(
            img,
            font,
            "暂无数据",
            x1 + pad,
            y1 + (88.0 * sf) as i32,
            f_body,
            TEXT_SECONDARY,
        );
        return;
    }

    let w = x2 - x1;
    let h = y2 - y1;
    let cx = x1 + (w as f32 * 0.67) as i32;
    let cy = y1 + (h as f32 * 0.56) as i32;
    let r_out = (38.0 * sf).max((w as f32 * 0.19).min(h as f32 * 0.33));
    let r_in = r_out * 0.67;

    // One same-view slot assignment for both the donut and its legend below
    // (T10.187, R-8(c)); see draw_reference_tool_distribution for the same pattern.
    let tool_names: Vec<String> = positive_tools.iter().map(|item| item.0.clone()).collect();
    let tool_colors = hud_tool_colors_for_view(&tool_names);

    // Draw donut
    let mut slices = Vec::new();
    for (idx, item) in positive_tools.iter().enumerate() {
        slices.push((item.1 as f32, tool_colors[idx]));
    }
    draw_donut(img, cx, cy, r_in, r_out, &slices);

    let total_text = format_tokens(total);
    let fit_sz = fit_font_size(font, &total_text, f_value, r_in * 1.50, 11.0 * sf);
    let value_w = text_width(font, &total_text, fit_sz);
    // "有效 Token", not "Tokens" (T10.195 review P3-7 item 1): see the
    // identical fix in draw_reference_tool_distribution. This panel is dead
    // code (#[allow(dead_code)] above), but keeping its wording consistent
    // costs nothing and avoids a stale string if it is ever revived.
    let label = METRIC_LABEL_EFFECTIVE_TOKENS;
    let label_w = text_width(font, label, f_small);

    let value_h = fit_sz;
    let label_h = f_small;
    let group_h = value_h + (4.0 * sf) + label_h;
    let value_y = cy - (group_h / 2.0) as i32;
    let label_y = value_y + (value_h + 4.0 * sf) as i32;

    draw_text(
        img,
        font,
        &total_text,
        cx - (value_w / 2.0) as i32,
        value_y,
        fit_sz,
        TEXT_PRIMARY,
    );
    draw_text(
        img,
        font,
        label,
        cx - (label_w / 2.0) as i32,
        label_y,
        f_small,
        TEXT_SECONDARY,
    );

    // Draw legend (Top 3 tools)
    let legend_items: Vec<&(String, i64)> = positive_tools.iter().take(3).collect();
    let legend_x = x1 + pad;
    let legend_y = y1 + (82.0 * sf) as i32;
    let row_gap = (32.0 * sf) as i32;
    let dot = (9.0 * sf).max(6.0) as i32;
    // right-align percentages at a fixed column so they don't overlap the donut
    let pct_right = cx - (r_out as i32) - (12.0 * sf) as i32;

    for (idx, item) in legend_items.iter().enumerate() {
        let y = legend_y + idx as i32 * row_gap;
        // legend_items is positive_tools' own first 3 entries (same order),
        // so its index also indexes tool_colors (T10.187, R-8(c)).
        let color = tool_colors[idx];
        let pct = format!(
            "{}%",
            ((item.1 as f32 / total as f32) * 100.0).round() as i32
        );

        let display_name = tool_display_name(&item.0);

        let dot_center_y = y - (f_body * 0.34) as i32;
        draw_circle(img, legend_x + dot / 2, dot_center_y, dot / 2, color);
        // name, truncated to fit before pct column
        let name_max =
            (pct_right - legend_x - dot - (28.0 * sf) as i32).max((32.0 * sf) as i32) as f32;
        let name_trunc = truncate_text(font, &display_name, f_body, name_max);
        draw_text(
            img,
            font,
            &name_trunc,
            legend_x + dot + (10.0 * sf) as i32,
            y,
            f_body,
            TEXT_PRIMARY,
        );
        // pct right-aligned
        let pct_w = text_width(font, &pct, f_body);
        draw_text(
            img,
            font,
            &pct,
            pct_right - pct_w as i32,
            y,
            f_body,
            TEXT_SECONDARY,
        );
    }
}

// ============ EXPOSED GENERATOR ENTRY POINTS ============

pub fn draw_desktop_wallpaper_image_with_stats(
    stats: &WallStats,
    width: u32,
    height: u32,
) -> Option<RgbaImage> {
    let font_data = load_system_font()?;
    let font = FontRef::try_from_slice(&font_data).ok()?;

    let mut img = RgbaImage::new(width, height);

    // 1. Background gradient
    draw_vertical_gradient(&mut img, BG_TOP, BG_BOTTOM);

    // 2. Ambient radial blooms — non-tool accents (T10.195, replacing
    // APPLE_BLUE/APPLE_INDIGO/APPLE_PURPLE; T10.190 plan §4 P9 / §6.8). The
    // second and third blooms use the axis and neutral tokens, not
    // tool-identity colours (T10.195 review P3-4).
    let sf = width as f32 / 1920.0;
    draw_ambient_blob(
        &mut img,
        (width as f32 * 0.18) as i32,
        (height as f32 * 0.12) as i32,
        (width as f32 * 0.32) as i32,
        ACCENT_PRIMARY,
        46,
    );
    draw_ambient_blob(
        &mut img,
        (width as f32 * 0.86) as i32,
        (height as f32 * 0.90) as i32,
        (width as f32 * 0.34) as i32,
        ACCENT_NEUTRAL,
        40,
    );
    draw_ambient_blob(
        &mut img,
        (width as f32 * 0.50) as i32,
        (height as f32 * 0.50) as i32,
        (width as f32 * 0.30) as i32,
        ACCENT_AXIS,
        22,
    );

    let px = |val: f32| -> i32 { (val * sf).round() as i32 };

    let content_w = (width as i32 - px(170.0)).min(px(1280.0));
    let top_h = px(300.0);
    let mid_h = px(190.0);
    let heat_h = px(200.0);
    let gap = px(18.0);
    let content_h = top_h + mid_h + heat_h + gap * 2;

    let x1 = (width as i32 - content_w) / 2;
    let x2 = x1 + content_w;
    let y1 = px(50.0).max((height as i32 - content_h) / 2);
    let y2 = y1 + top_h;
    let mid_y1 = y2 + gap;
    let mid_y2 = mid_y1 + mid_h;
    let heat_y1 = mid_y2 + gap;
    let heat_y2 = heat_y1 + heat_h;
    let radius = px(24.0);
    let desktop_card_fill = Rgba([255, 255, 255, 14]);
    let desktop_card_border = Rgba([255, 255, 255, 18]);

    // 3. Render Top trend panel
    draw_reference_trend_panel(&mut img, &font, (x1, y1, x2, y2), stats, sf);

    // 4. Render Middle card (Metrics + Ranking + Distribution)
    draw_card(
        &mut img,
        (x1, mid_y1, x2, mid_y2),
        radius,
        desktop_card_fill,
        desktop_card_border,
    );

    // Draw vertical dividers
    let col1 = x1 + (content_w as f32 * 0.25) as i32;
    let col2 = x1 + (content_w as f32 * 0.46) as i32;
    let col3 = x1 + (content_w as f32 * 0.74) as i32;
    for &sx in &[col1, col2, col3] {
        draw_line(
            &mut img,
            sx as f32,
            (mid_y1 + px(28.0)) as f32,
            sx as f32,
            (mid_y2 - px(28.0)) as f32,
            Rgba([85, 120, 165, 95]),
            1.0 * sf,
        );
    }

    // T10.195 review P3-1: one shared MetricTexts computation for both
    // metrics, instead of each inlining its own format_known_*/ChangeBadge
    // call — see metric_texts's own doc comment.
    let texts = metric_texts(stats);

    // Column 1: Today tokens
    draw_reference_metric(
        &mut img,
        &font,
        (x1, mid_y1, col1, mid_y2),
        sf,
        ReferenceMetricContent {
            title: METRIC_LABEL_EFFECTIVE_TOKENS,
            value: &texts.token_value,
            // No unit subtitle (T10.195): the title already says "有效
            // Token", so a separate "Tokens" subtitle would just repeat it
            // (it made sense only under the old "今日消耗" title).
            subtitle: "",
            color: ACCENT_PRIMARY,
            badge_text: &texts.token_badge,
        },
    );

    // Column 2: Today requests
    draw_reference_metric(
        &mut img,
        &font,
        (col1, mid_y1, col2, mid_y2),
        sf,
        ReferenceMetricContent {
            title: METRIC_LABEL_RECORD_COUNT,
            value: &texts.record_value,
            subtitle: "",
            color: ACCENT_PRIMARY,
            badge_text: &texts.record_badge,
        },
    );

    // Column 3: Model ranking
    draw_reference_model_ranking(&mut img, &font, (col2, mid_y1, col3, mid_y2), stats, sf);

    // Column 4: Tool distribution
    draw_reference_tool_distribution(&mut img, &font, (col3, mid_y1, x2, mid_y2), stats, sf);

    // 5. Render Bottom heatmap panel
    draw_card(
        &mut img,
        (x1, heat_y1, x2, heat_y2),
        radius,
        desktop_card_fill,
        desktop_card_border,
    );
    draw_reference_heatmap_panel(&mut img, &font, (x1, heat_y1, x2, heat_y2), stats, sf);

    Some(img)
}

pub fn draw_desktop_wallpaper_image(db_path: &Path, width: u32, height: u32) -> Option<RgbaImage> {
    let stats = fetch_stats(db_path);
    draw_desktop_wallpaper_image_with_stats(&stats, width, height)
}

pub fn draw_lockscreen_wallpaper_image_with_stats(
    stats: &WallStats,
    width: u32,
    height: u32,
) -> Option<RgbaImage> {
    let font_data = load_system_font()?;
    let font = FontRef::try_from_slice(&font_data).ok()?;

    let ui_sf = (width as f32 / 1920.0).min(height as f32 / 1080.0);
    let mut img = draw_lockscreen_scene_background(width, height, ui_sf);
    let px = |value: f32| -> i32 { (value * ui_sf).round() as i32 };

    // A single telemetry card stays in the right safe zone. Windows owns the
    // center/top clock region and the lower-left sign-in region, so both remain
    // deliberately free of product UI at every 16:9 resolution.
    let margin = px(72.0);
    let card_width = px(390.0);
    // 436 = 312 (header/metrics block, unchanged) + 92 (plot band) + 18 (hour
    // labels) + 14 (bottom padding). The rhythm chart needs a band tall enough
    // for curvature to be visible at all; see docs/design/windows-lockscreen-rhythm-v1.md.
    let card_height = px(436.0);
    let x2 = width as i32 - margin;
    let x1 = x2 - card_width;
    // Clamp so the taller card still clears the top safe zone and the bottom
    // edge on short panels. Because `ui_sf` already tracks height, centring wins
    // at every resolution checked (1366x768 -> y1 229/y2 539 at sf 0.71;
    // 1024x768 -> y1 267/y2 500 at sf 0.53); the clamp is a guard, not the
    // normal path.
    let y1 = ((height as i32 - card_height) / 2)
        .max(px(96.0))
        .min((height as i32 - card_height - px(48.0)).max(px(48.0)));
    let y2 = y1 + card_height;

    draw_lockscreen_summary_card(&mut img, &font, (x1, y1, x2, y2), stats, ui_sf);

    Some(img)
}

pub fn draw_lockscreen_wallpaper_image(
    db_path: &Path,
    width: u32,
    height: u32,
) -> Option<RgbaImage> {
    let stats = fetch_stats(db_path);
    draw_lockscreen_wallpaper_image_with_stats(&stats, width, height)
}

// ============ SYSTEM WALLPAPER SETTERS ============

#[cfg(target_os = "windows")]
pub fn set_wallpaper(path: &Path) -> bool {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    // Convert to backslashes for standard Windows safety
    let win_path_str = path.to_string_lossy().replace("/", "\\");
    let clean_path = Path::new(&win_path_str);

    let path_wstr: Vec<u16> = OsStr::new(clean_path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    #[link(name = "user32")]
    extern "system" {
        pub fn SystemParametersInfoW(
            uiAction: u32,
            uiParam: u32,
            pvParam: *const u16,
            fWinIni: u32,
        ) -> i32;
    }

    unsafe {
        SystemParametersInfoW(
            0x0014, // SPI_SETDESKWALLPAPER
            0,
            path_wstr.as_ptr(),
            0x01 | 0x02, // SPIF_UPDATEINIFILE | SPIF_SENDCHANGE
        ) != 0
    }
}

#[cfg(target_os = "macos")]
pub fn set_wallpaper(path: &Path) -> bool {
    // Two-step: clear every desktop to its default (missing value), then
    // assign the new picture. The clear happens fast enough that the
    // wallpaper agent treats the subsequent assign as an in-place
    // replacement and skips the ~0.8–1.2s cross-fade transition. Skipping
    // the transition removes the visible flicker to the previous /
    // system-default wallpaper that users reported as a 1s revert.
    let clear_script =
        "tell application \"System Events\" to tell every desktop to set picture to missing value"
            .to_string();
    if let Err(e) = std::process::Command::new("osascript")
        .args(["-e", &clear_script])
        .status()
    {
        log::warn!("macOS wallpaper clear step failed: {}", e);
    }
    std::thread::sleep(std::time::Duration::from_millis(80));
    let path_str = path.to_string_lossy().to_string();
    // AppleScript string literal: a `"` or `\` in the path must not end it.
    let set_script = format!(
        "tell application \"System Events\" to tell every desktop to set picture to POSIX file \"{}\"",
        path_str.replace('\\', "\\\\").replace('"', "\\\"")
    );
    match std::process::Command::new("osascript")
        .args(["-e", &set_script])
        .status()
    {
        Ok(status) => status.success(),
        Err(e) => {
            log::error!("Failed to execute osascript to set wallpaper: {}", e);
            false
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn set_wallpaper(path: &Path) -> bool {
    log::warn!(
        "Desktop wallpaper setting is not yet supported on this platform (path={:?}); skipping.",
        path
    );
    true
}

pub fn set_lockscreen(path: &Path) -> Result<(bool, String), String> {
    if !path.exists() {
        return Err(format!("Lockscreen image does not exist: {:?}", path));
    }

    #[cfg(target_os = "windows")]
    {
        use windows::core::HSTRING;
        use windows::Storage::StorageFile;
        use windows::System::UserProfile::LockScreen;

        let path_str = path.to_string_lossy().replace("/", "\\");

        let run = || -> Result<bool, Box<dyn std::error::Error>> {
            use std::future::IntoFuture;
            let hpath = HSTRING::from(&path_str);
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            let file = rt.block_on(StorageFile::GetFileFromPathAsync(&hpath)?.into_future())?;
            let set_op = LockScreen::SetImageFileAsync(&file)?;
            rt.block_on(set_op.into_future())?;
            Ok(true)
        };

        match run() {
            Ok(_) => Ok((
                true,
                "Lock-screen set successfully via WinRT API".to_string(),
            )),
            Err(e) => Err(format!("WinRT error: {}", e)),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Lockscreen wallpaper is only supported on Windows".to_string())
    }
}

#[cfg(test)]
mod fetch_stats_tests {
    use super::*;
    use chrono::NaiveDate;
    use rusqlite::params;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_db_path() -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before UNIX epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("tokenledger-wallpaper-{nanos}.db"))
    }

    #[test]
    fn fetch_stats_uses_effective_tokens_without_cached_volume() {
        let db_path = temp_db_path();
        let conn = rusqlite::Connection::open(&db_path).expect("open temp database");
        conn.execute_batch(
            "CREATE TABLE token_logs (
                tool TEXT NOT NULL,
                model TEXT NOT NULL,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                cached_tokens INTEGER NOT NULL DEFAULT 0,
                timestamp TEXT NOT NULL
            );",
        )
        .expect("create token_logs table");

        // T10.195 review P2-3 added an inclusive `<= now` upper bound to
        // every "today" query. This test (unlike every other one in this
        // module) exercises the public `fetch_stats` wrapper, which calls
        // `Local::now()` itself rather than a pinned clock, so these rows
        // must be timestamped safely in the past relative to the REAL wall
        // clock the test happens to run under -- a fixed "09:15/09:45" wall
        // time would fail whenever the suite runs before 09:45 local time.
        // Four and two seconds before "now" clear that bound regardless of
        // the hour, at the cost of a theoretical (~4-in-86400-seconds) flake
        // if the suite starts in the first moments of a new day or hour.
        let now = Local::now();
        let row_a_time = now - Duration::seconds(4);
        let row_b_time = now - Duration::seconds(2);
        let today = now.format("%Y-%m-%d").to_string();
        let hour = row_a_time.hour() as usize;
        conn.execute(
            "INSERT INTO token_logs (tool, model, input_tokens, output_tokens, cached_tokens, timestamp)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                "claude",
                "claude-test",
                100,
                50,
                900,
                row_a_time.format("%Y-%m-%d %H:%M:%S").to_string()
            ],
        )
        .expect("insert cached claude row");
        conn.execute(
            "INSERT INTO token_logs (tool, model, input_tokens, output_tokens, cached_tokens, timestamp)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                "codex",
                "codex-test",
                20,
                30,
                400,
                row_b_time.format("%Y-%m-%d %H:%M:%S").to_string()
            ],
        )
        .expect("insert cached codex row");
        drop(conn);

        let stats = fetch_stats(&db_path);
        let _ = fs::remove_file(&db_path);

        assert_eq!(stats.today_total, 200);
        assert_eq!(stats.today_requests, 2);
        assert_eq!(stats.hourly_trend[hour], 200);
        assert_eq!(
            stats.tool_distribution,
            vec![("claude".to_string(), 150), ("codex".to_string(), 50)]
        );
        assert!(stats
            .heatmap
            .iter()
            .any(|(date, total)| date == &today && *total == 200));
    }

    /// Creates a fresh temp SQLite database with the `token_logs` schema and
    /// the given `(tool, model, input_tokens, output_tokens, timestamp)` rows.
    fn make_db(rows: &[(&str, &str, i64, i64, &str)]) -> std::path::PathBuf {
        let db_path = temp_db_path();
        let conn = rusqlite::Connection::open(&db_path).expect("open temp database");
        conn.execute_batch(
            "CREATE TABLE token_logs (
                tool TEXT NOT NULL,
                model TEXT NOT NULL,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                cached_tokens INTEGER NOT NULL DEFAULT 0,
                timestamp TEXT NOT NULL
            );",
        )
        .expect("create token_logs table");
        for (tool, model, input, output, timestamp) in rows {
            conn.execute(
                "INSERT INTO token_logs (tool, model, input_tokens, output_tokens, cached_tokens, timestamp)
                 VALUES (?1, ?2, ?3, ?4, 0, ?5)",
                params![tool, model, input, output, timestamp],
            )
            .expect("insert row");
        }
        drop(conn);
        db_path
    }

    /// `now` as an injected `DateTime<Local>`, built from a `NaiveDateTime` so
    /// tests never depend on the wall clock (T10.195 scope item 5).
    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> DateTime<Local> {
        use chrono::TimeZone;
        let naive = NaiveDate::from_ymd_opt(y, mo, d)
            .expect("valid date")
            .and_hms_opt(h, mi, s)
            .expect("valid time");
        Local.from_local_datetime(&naive).single().expect(
            "test instant must be unambiguous in the host's local timezone (Asia/Shanghai has no DST)",
        )
    }

    // ---- Yesterday-cutoff window: pure function (T10.190 plan §4 P9) ----

    #[test]
    fn yesterday_window_cuts_at_the_exact_time_of_day_including_edges() {
        let mid_afternoon = NaiveDate::from_ymd_opt(2026, 9, 26)
            .unwrap()
            .and_hms_opt(14, 5, 30)
            .unwrap();
        assert_eq!(
            yesterday_same_time_window(mid_afternoon),
            (
                "2026-09-25 00:00:00".to_string(),
                "2026-09-25 14:05:30".to_string()
            )
        );

        // Midnight: today has had 0 minutes, so the only fair baseline is 0
        // minutes of yesterday too -- the window collapses to empty.
        let midnight = NaiveDate::from_ymd_opt(2026, 9, 26)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap();
        let (from, to) = yesterday_same_time_window(midnight);
        assert_eq!(
            from, to,
            "midnight must produce an empty (zero-width) window"
        );
        assert_eq!(from, "2026-09-25 00:00:00");

        // One second before midnight: nearly the whole day counts.
        let last_second = NaiveDate::from_ymd_opt(2026, 9, 26)
            .unwrap()
            .and_hms_opt(23, 59, 59)
            .unwrap();
        assert_eq!(
            yesterday_same_time_window(last_second),
            (
                "2026-09-25 00:00:00".to_string(),
                "2026-09-25 23:59:59".to_string()
            )
        );

        // Year rollover: "yesterday" must land on Dec 31 of the PREVIOUS year.
        let new_year = NaiveDate::from_ymd_opt(2026, 1, 1)
            .unwrap()
            .and_hms_opt(0, 30, 0)
            .unwrap();
        assert_eq!(
            yesterday_same_time_window(new_year),
            (
                "2025-12-31 00:00:00".to_string(),
                "2025-12-31 00:30:00".to_string()
            )
        );
    }

    #[test]
    fn yesterday_window_string_construction_is_unaffected_by_a_real_dst_transition() {
        // Regression guard for using `.naive_local()` (plain wall-clock
        // fields) rather than `.naive_utc()` or any other UTC-touching path:
        // feeding a real DST-transition instant through a timezone-aware
        // `DateTime<Tz>::naive_local()` must yield exactly the plain
        // date/time answer, with no leftover UTC-offset artefact. This machine
        // runs Asia/Shanghai (no DST), so `chrono_tz::America::New_York` (an
        // already-linked dependency, used elsewhere in this crate) stands in
        // for a real DST-observing host. 2026-03-08 is the US spring-forward
        // day (02:00 -> 03:00); 2026-11-01 is the US fall-back day
        // (02:00 -> 01:00, the 01:xx hour occurs twice in wall-clock terms).
        use chrono::TimeZone;
        use chrono_tz::America::New_York;

        let day_after_spring_forward = New_York.with_ymd_and_hms(2026, 3, 9, 9, 30, 0).unwrap();
        assert_eq!(
            yesterday_same_time_window(day_after_spring_forward.naive_local()),
            (
                "2026-03-08 00:00:00".to_string(),
                "2026-03-08 09:30:00".to_string()
            )
        );

        let day_after_fall_back = New_York.with_ymd_and_hms(2026, 11, 2, 9, 30, 0).unwrap();
        assert_eq!(
            yesterday_same_time_window(day_after_fall_back.naive_local()),
            (
                "2026-11-01 00:00:00".to_string(),
                "2026-11-01 09:30:00".to_string()
            )
        );
    }

    #[test]
    fn fetch_stats_at_cuts_yesterday_correctly_across_a_real_dst_transition() {
        // End-to-end companion to the string-construction test just above:
        // that one only calls `yesterday_same_time_window` directly with a
        // hand-built `NaiveDateTime`, so it would not catch a future
        // regression that swapped `fetch_stats_at`'s own `now.naive_local()`
        // for `now.naive_utc()` (this machine's Asia/Shanghai has no DST, so
        // a plain `at(...)` `DateTime<Local>` instant can never exercise that
        // swap). `fetch_stats_at` is generic over the timezone (P3-6)
        // specifically so a test can drive it with a real
        // `chrono_tz::America::New_York` instant instead.
        use chrono::TimeZone;
        use chrono_tz::America::New_York;

        // Spring-forward day (2026-03-08, 02:00 -> 03:00 local): "now" is the
        // day after, at 09:30 New York wall-clock time.
        let db_path = make_db(&[
            ("claude", "m", 100, 0, "2026-03-08 09:00:00"),
            ("claude", "m", 900, 0, "2026-03-08 15:00:00"),
            ("claude", "m", 50, 0, "2026-03-09 08:00:00"),
        ]);
        let now = New_York.with_ymd_and_hms(2026, 3, 9, 9, 30, 0).unwrap();
        let stats = fetch_stats_at(&db_path, now);
        let _ = fs::remove_file(&db_path);
        assert_eq!(
            stats.yesterday_total, 100,
            "only the pre-cutoff row must count across the spring-forward boundary"
        );
        assert_eq!(stats.yesterday_requests, 1);
        assert_eq!(stats.today_total, 50);

        // Fall-back day (2026-11-01, 02:00 -> 01:00 local, so 01:xx occurs
        // twice in wall-clock terms): "now" is the day after, at 09:30 New
        // York wall-clock time.
        let db_path = make_db(&[
            ("claude", "m", 200, 0, "2026-11-01 09:00:00"),
            ("claude", "m", 900, 0, "2026-11-01 15:00:00"),
            ("claude", "m", 60, 0, "2026-11-02 08:00:00"),
        ]);
        let now = New_York.with_ymd_and_hms(2026, 11, 2, 9, 30, 0).unwrap();
        let stats = fetch_stats_at(&db_path, now);
        let _ = fs::remove_file(&db_path);
        assert_eq!(
            stats.yesterday_total, 200,
            "only the pre-cutoff row must count across the fall-back boundary"
        );
        assert_eq!(stats.yesterday_requests, 1);
        assert_eq!(stats.today_total, 60);
    }

    // ---- Yesterday-cutoff window: end to end through fetch_stats_at ----

    #[test]
    fn fetch_stats_at_cuts_yesterday_at_the_same_time_of_day_as_now() {
        let db_path = make_db(&[
            // Yesterday, before the cutoff: must be counted.
            ("claude", "m", 100, 0, "2026-09-25 09:00:00"),
            // Yesterday, after the cutoff: must NOT be counted -- this is the
            // exact P9 bug (the old query ran to yesterday's midnight and
            // would have included this row).
            ("claude", "m", 900, 0, "2026-09-25 15:00:00"),
            // Today, before "now": counted as today's total.
            ("claude", "m", 50, 0, "2026-09-26 08:00:00"),
        ]);
        let stats = fetch_stats_at(&db_path, at(2026, 9, 26, 9, 30, 0));
        let _ = fs::remove_file(&db_path);

        assert_eq!(
            stats.yesterday_total, 100,
            "only the pre-cutoff row must count"
        );
        assert_eq!(stats.yesterday_requests, 1);
        assert_eq!(stats.today_total, 50);
    }

    #[test]
    fn fetch_stats_at_includes_the_row_exactly_at_the_cutoff_instant() {
        // T10.195 review P2-3 (the reviewer's S6): the previous revision made
        // this bound exclusive, so a row timestamped exactly at yesterday's
        // cutoff instant did not count -- disagreeing with the dashboard's
        // own `comparison_period` (commands/mod.rs), which only skips a row
        // strictly outside `[window_start, window_end]` and so counts it. The
        // bound must be inclusive to match.
        let db_path = make_db(&[("claude", "m", 500, 0, "2026-09-25 09:30:00")]);
        let stats = fetch_stats_at(&db_path, at(2026, 9, 26, 9, 30, 0));
        let _ = fs::remove_file(&db_path);
        assert_eq!(stats.yesterday_total, 500);
        assert_eq!(stats.yesterday_requests, 1);
    }

    #[test]
    fn fetch_stats_at_excludes_a_today_row_timestamped_after_now() {
        // T10.195 review P2-3 (the reviewer's S9): the dashboard's own
        // `query_bounds` caps `StatsRange::Today` at `current_end = now`, so a
        // row timestamped later than `now` (clock skew, or a seeded/backfilled
        // row ahead of the wall clock) must not inflate today's total,
        // requests, hourly trend, tool distribution or model ranking -- the
        // previous revision had no upper bound on any of these four "today"
        // queries at all.
        let db_path = make_db(&[
            ("claude", "m", 100, 0, "2026-09-26 09:00:00"), // before now: counted
            ("codex", "m2", 900, 0, "2026-09-26 15:00:00"), // after now: must NOT count
        ]);
        let stats = fetch_stats_at(&db_path, at(2026, 9, 26, 9, 30, 0));
        let _ = fs::remove_file(&db_path);

        assert_eq!(stats.today_total, 100);
        assert_eq!(stats.today_requests, 1);
        assert_eq!(stats.hourly_trend[15], 0, "the future hour must stay at 0");
        assert_eq!(
            stats.tool_distribution,
            vec![("claude".to_string(), 100)],
            "the future row's tool must not appear"
        );
        assert_eq!(
            stats.model_ranking,
            vec![("m".to_string(), 100)],
            "the future row's model must not appear"
        );
    }

    #[test]
    fn fetch_stats_at_midnight_now_has_no_yesterday_baseline_even_with_data() {
        let db_path = make_db(&[
            ("claude", "m", 100, 0, "2026-09-25 00:00:01"),
            ("claude", "m", 200, 0, "2026-09-25 23:00:00"),
        ]);
        let stats = fetch_stats_at(&db_path, at(2026, 9, 26, 0, 0, 0));
        let _ = fs::remove_file(&db_path);

        assert_eq!(
            stats.yesterday_total, 0,
            "cutoff at 00:00:00 must exclude the whole of yesterday"
        );
        assert_ne!(
            stats.yesterday_total, STAT_UNKNOWN,
            "this is a real, successfully-read zero, not a failed read"
        );
        assert_eq!(
            ChangeBadge::classify(stats.today_total, stats.yesterday_total),
            ChangeBadge::Flat,
            "both sides are a real, successfully-read 0"
        );
    }

    #[test]
    fn fetch_stats_at_handles_a_duplicated_local_timestamp_deterministically() {
        // Simulates the wall-clock ambiguity a DST fall-back overlap produces:
        // two distinct real instants sharing one naive local timestamp string
        // (T10.190 plan §4 P9 edge cases). The query cannot tell them apart --
        // neither can any other timestamp-string query in this file -- so the
        // only property this asserts is that it does not panic, and both rows
        // are treated the same way (both counted, since the cutoff is after
        // their shared timestamp).
        let db_path = make_db(&[
            ("claude", "m", 111, 0, "2026-09-25 01:30:00"),
            ("codex", "m", 222, 0, "2026-09-25 01:30:00"),
        ]);
        let stats = fetch_stats_at(&db_path, at(2026, 9, 26, 2, 0, 0));
        let _ = fs::remove_file(&db_path);

        assert_eq!(stats.yesterday_total, 333);
        assert_eq!(stats.yesterday_requests, 2);
    }

    // ---- No baseline (a day with no records yesterday) ----

    #[test]
    fn fetch_stats_at_shows_no_baseline_when_yesterday_has_no_records_at_all() {
        let db_path = make_db(&[("claude", "m", 100, 0, "2026-09-26 09:00:00")]); // today only
        let stats = fetch_stats_at(&db_path, at(2026, 9, 26, 15, 0, 0));
        let _ = fs::remove_file(&db_path);

        assert_eq!(stats.yesterday_total, 0);
        assert_eq!(stats.today_total, 100);
        assert_eq!(
            ChangeBadge::classify(stats.today_total, stats.yesterday_total),
            ChangeBadge::New,
            "zero yesterday and a positive today must show 新增, not a percentage"
        );
    }

    // ---- draw_card: rounded-rect border at radius == half an extent (T10.210) ----

    #[test]
    fn draw_card_borders_the_whole_ring_when_radius_equals_both_half_extents() {
        // Reproduces the bug (T10.195 review follow-up / root R-58, R-65): the
        // old border test branched on `dx > 0 && dy > 0` to decide "am I in
        // the rounded corner", using `dx = |px-cx| - (half_w - r_f)` etc. When
        // `radius` equals a half-extent (a full capsule -- both the
        // model-ranking bar and the change-pill background draw with
        // `radius = height / 2`), that axis's term is always >= 0, so nearly
        // every pixel took the "corner" branch; for a fully round shape
        // (radius == half_w == half_h, e.g. this circle, or any stubby
        // capsule close to it) that branch's own 0.75px-inset re-derivation of
        // the same threshold only lit up within a sliver of the four
        // axis-aligned points, leaving the diagonal portions of the ring
        // undrawn (shown as "fill" -- transparent for a track-only shape, so
        // the ring effectively failed to draw at all there).
        let mut img: RgbaImage = ImageBuffer::new(40, 40);
        let border = Rgba([220, 40, 40, 255]);
        draw_card(&mut img, (0, 0, 40, 40), 20, Rgba([0, 0, 0, 0]), border);

        // The four axis-aligned edge points, 1px in from the true boundary
        // (already correct before this fix).
        assert_eq!(*img.get_pixel(20, 1), border, "top edge");
        assert_eq!(*img.get_pixel(20, 39), border, "bottom edge");
        assert_eq!(*img.get_pixel(1, 20), border, "left edge");
        assert_eq!(*img.get_pixel(39, 20), border, "right edge");

        // The four 45-degree diagonal points -- on a radius-20 circle
        // centred at (20, 20), (20 + 14, 20 + 14) etc. sit ~0.2px inside the
        // true boundary (14*sqrt(2) ~= 19.8), so they belong to the border
        // ring too. The old formula left these as untouched fill.
        assert_eq!(*img.get_pixel(34, 34), border, "bottom-right diagonal");
        assert_eq!(*img.get_pixel(6, 34), border, "bottom-left diagonal");
        assert_eq!(*img.get_pixel(34, 6), border, "top-right diagonal");
        assert_eq!(*img.get_pixel(6, 6), border, "top-left diagonal");

        // Deep interior (dead centre) and well outside the circle both stay
        // untouched (fill is transparent here) -- the fix must not turn the
        // whole shape into a border either.
        assert_eq!(img.get_pixel(20, 20)[3], 0, "centre must stay untouched");
        assert_eq!(
            img.get_pixel(0, 0)[3],
            0,
            "outside the circle must stay untouched"
        );
    }

    #[test]
    fn draw_card_fills_the_body_of_a_wide_capsule_and_clamps_an_oversized_radius() {
        // The model-ranking bar and change-pill track draw a *wide* capsule
        // (radius = height / 2, width >> height). Its straight middle run
        // must be solid fill, not border, and a radius the caller
        // over-specifies (bigger than either half-extent) must be clamped
        // rather than producing a malformed shape.
        let mut img: RgbaImage = ImageBuffer::new(200, 40);
        let fill = Rgba([10, 200, 10, 255]);
        let border = Rgba([200, 10, 10, 255]);
        // radius (30) exceeds half_h (20): must clamp to 20, not misbehave.
        draw_card(&mut img, (0, 0, 200, 40), 30, fill, border);

        assert_eq!(*img.get_pixel(100, 20), fill, "dead centre of the long run");
        assert_eq!(
            *img.get_pixel(60, 20),
            fill,
            "well inside, away from either rounded end"
        );
        assert_eq!(*img.get_pixel(100, 0), border, "top edge, mid-length");
        assert_eq!(
            img.get_pixel(0, 0)[3],
            0,
            "rounded-off bounding-box corner stays untouched"
        );
    }

    // ---- ChangeBadge (T10.195 review P2-1) ----

    #[test]
    fn change_badge_classifies_unknown_new_flat_and_directional_cases() {
        // Either side unknown.
        assert_eq!(
            ChangeBadge::classify(STAT_UNKNOWN, 100),
            ChangeBadge::Unknown,
            "today failed to read"
        );
        assert_eq!(
            ChangeBadge::classify(100, STAT_UNKNOWN),
            ChangeBadge::Unknown,
            "yesterday failed to read"
        );
        assert_eq!(
            ChangeBadge::classify(STAT_UNKNOWN, STAT_UNKNOWN),
            ChangeBadge::Unknown
        );

        // 0 / 0: yesterday is a real 0 baseline and today is also 0 -- flat,
        // not "new" (today is not > 0) and not unknown (root's "0/0" case).
        assert_eq!(ChangeBadge::classify(0, 0), ChangeBadge::Flat);

        // 0 / positive: today dropped to a real, successfully-read 0 -- a
        // genuine, computable -100% change, not "unknown" or "new".
        assert_eq!(ChangeBadge::classify(0, 100), ChangeBadge::Down(-100.0));

        // Positive yesterday of 0: new.
        assert_eq!(ChangeBadge::classify(100, 0), ChangeBadge::New);

        // Equal, both positive: flat.
        assert_eq!(ChangeBadge::classify(100, 100), ChangeBadge::Flat);

        // +-0.01%: inside the 0.05% "flat" band on both sides of zero.
        assert_eq!(ChangeBadge::classify(10_001, 10_000), ChangeBadge::Flat);
        assert_eq!(ChangeBadge::classify(9_999, 10_000), ChangeBadge::Flat);

        // Directional cases.
        assert_eq!(ChangeBadge::classify(120, 100), ChangeBadge::Up(20.0));
        match ChangeBadge::classify(80, 100) {
            ChangeBadge::Down(pct) => assert!((pct - (-20.0)).abs() < 1e-9),
            other => panic!("expected Down(-20.0), got {other:?}"),
        }
    }

    // T10.210 (T10.195 review P3-8): the cloud RPC's own "cannot prove a
    // baseline" 0/0 must classify as `BaselineMissing`, not `Unknown` — the
    // read succeeded, unlike a genuine read failure.
    #[test]
    fn change_badge_classifies_cloud_baseline_missing_separately_from_unknown() {
        assert_eq!(
            ChangeBadge::classify(500, STAT_BASELINE_MISSING),
            ChangeBadge::BaselineMissing,
        );
        // Still distinguishable from a genuine read failure on either side.
        assert_ne!(ChangeBadge::BaselineMissing, ChangeBadge::Unknown);
        assert_eq!(
            ChangeBadge::classify(STAT_UNKNOWN, STAT_BASELINE_MISSING),
            ChangeBadge::Unknown,
            "today failing to read still wins over a baseline-missing yesterday"
        );
    }

    #[test]
    fn change_badge_text_matches_the_dashboards_formatting_rules() {
        assert_eq!(ChangeBadge::Unknown.text(), "不可得");
        assert_eq!(ChangeBadge::BaselineMissing.text(), "基线缺失");
        assert_eq!(ChangeBadge::New.text(), "新增");
        assert_eq!(ChangeBadge::Flat.text(), "持平");
        // 20% is >= 10%, so it rounds to an integer (no decimal), same as
        // the dashboard's formatChangePercent.
        assert_eq!(ChangeBadge::Up(20.0).text(), "+20% ↑");
        assert_eq!(ChangeBadge::Down(-20.0).text(), "−20% ↓");

        // The fixture's own S1 scenario (960,822 today vs 1,155,624
        // yesterday-full-day, T10.195 review §四): magnitude 16.858...%,
        // >= 10% so it rounds to an integer -- "−16.9%" (this task's own
        // one-decimal display) becomes "−17%" (the dashboard's
        // formatChangePercent), matching root's "−16.9% → −17%" example.
        assert_eq!(ChangeBadge::classify(960_822, 1_155_624).text(), "−17% ↓");

        // U+2212 MINUS SIGN, never an ASCII hyphen.
        assert!(ChangeBadge::Down(-5.0).text().starts_with('\u{2212}'));
        assert!(!ChangeBadge::Down(-5.0).text().contains('-'));
    }

    #[test]
    fn format_change_magnitude_rounds_to_an_integer_at_ten_percent() {
        assert_eq!(format_change_magnitude(9.94), "9.9");
        assert_eq!(format_change_magnitude(-9.94), "9.9");
        assert_eq!(format_change_magnitude(10.0), "10");
        assert_eq!(format_change_magnitude(16.858), "17");
        assert_eq!(format_change_magnitude(-16.858), "17");
        assert_eq!(format_change_magnitude(100.0), "100");
    }

    // ---- Unknown fields (a read failure is never drawn as 0) ----

    #[test]
    fn fetch_stats_at_reports_unknown_not_zero_when_the_table_is_missing() {
        let db_path = temp_db_path();
        // Open (creating an empty, valid SQLite file) but never create
        // token_logs: every query below must fail to prepare, and every
        // scalar field must stay at STAT_UNKNOWN rather than read back as 0.
        drop(rusqlite::Connection::open(&db_path).expect("open temp database"));

        let stats = fetch_stats_at(&db_path, at(2026, 9, 26, 9, 0, 0));
        let _ = fs::remove_file(&db_path);

        assert_eq!(stats.today_total, STAT_UNKNOWN);
        assert_eq!(stats.today_requests, STAT_UNKNOWN);
        assert_eq!(stats.yesterday_total, STAT_UNKNOWN);
        assert_eq!(stats.yesterday_requests, STAT_UNKNOWN);
        assert_eq!(format_known_tokens(stats.today_total), UNKNOWN_TEXT);
        assert_eq!(format_known_count(stats.today_requests), UNKNOWN_TEXT);
        assert_eq!(
            ChangeBadge::classify(stats.today_total, stats.yesterday_total),
            ChangeBadge::Unknown
        );
    }

    #[test]
    fn format_known_helpers_treat_a_real_zero_and_a_failed_read_differently() {
        assert_eq!(format_known_tokens(0), "0", "a real zero must stay 0");
        assert_eq!(format_known_tokens(1_234_000), format_tokens(1_234_000));
        assert_eq!(format_known_tokens(STAT_UNKNOWN), UNKNOWN_TEXT);

        assert_eq!(format_known_count(0), "0");
        assert_eq!(format_known_count(42), "42");
        assert_eq!(format_known_count(STAT_UNKNOWN), UNKNOWN_TEXT);
    }

    // ---- metric_texts (T10.195 review P3-1) ----
    //
    // A minimal `WallStats` builder for these tests: only the four scalar
    // fields matter, so the rest are filled with harmless empty/zero
    // defaults (`generated_at` is unused by `metric_texts` itself).

    fn wall_stats_scalars(
        today_total: i64,
        yesterday_total: i64,
        today_requests: i64,
        yesterday_requests: i64,
    ) -> WallStats {
        WallStats {
            today_total,
            yesterday_total,
            today_requests,
            yesterday_requests,
            hourly_trend: vec![0; 24],
            yesterday_hourly_trend: vec![0; 24],
            tool_distribution: Vec::new(),
            model_ranking: Vec::new(),
            heatmap: Vec::new(),
            generated_at: at(2026, 9, 26, 12, 0, 0),
        }
    }

    #[test]
    fn metric_texts_shows_unknown_not_zero_when_a_read_failed() {
        // The reviewer's FI-4 (rendering STAT_UNKNOWN as a plain 0) must trip
        // this test: it is the one place both the desktop KPI row and the
        // lock-screen summary card get their card text from.
        let stats = wall_stats_scalars(STAT_UNKNOWN, STAT_UNKNOWN, STAT_UNKNOWN, STAT_UNKNOWN);
        let texts = metric_texts(&stats);
        assert_eq!(texts.token_value, UNKNOWN_TEXT);
        assert_eq!(texts.token_badge, UNKNOWN_TEXT);
        assert_eq!(texts.record_value, UNKNOWN_TEXT);
        assert_eq!(texts.record_badge, UNKNOWN_TEXT);
    }

    #[test]
    fn metric_texts_shows_a_real_zero_as_flat_not_unknown() {
        let stats = wall_stats_scalars(0, 0, 0, 0);
        let texts = metric_texts(&stats);
        assert_eq!(texts.token_value, "0");
        assert_eq!(texts.token_badge, "持平");
        assert_eq!(texts.record_value, "0");
        assert_eq!(texts.record_badge, "持平");
    }

    #[test]
    fn metric_texts_shows_new_when_yesterday_is_zero_and_today_is_positive() {
        let stats = wall_stats_scalars(500, 0, 12, 0);
        let texts = metric_texts(&stats);
        assert_eq!(texts.token_value, format_tokens(500));
        assert_eq!(texts.token_badge, "新增");
        assert_eq!(texts.record_value, "12");
        assert_eq!(texts.record_badge, "新增");
    }

    #[test]
    fn metric_texts_shows_flat_when_today_equals_yesterday() {
        let stats = wall_stats_scalars(500, 500, 12, 12);
        let texts = metric_texts(&stats);
        assert_eq!(texts.token_value, format_tokens(500));
        assert_eq!(texts.token_badge, "持平");
        assert_eq!(texts.record_value, "12");
        assert_eq!(texts.record_badge, "持平");
    }

    // ---- Wording (T10.195 scope item 3) ----

    #[test]
    fn wording_matches_the_current_terminology_not_the_retired_labels() {
        assert_eq!(METRIC_LABEL_EFFECTIVE_TOKENS, "有效 Token");
        assert_eq!(METRIC_LABEL_RECORD_COUNT, "记录数");
        assert_eq!(COMPARE_LABEL, "较昨日同期");
        assert_eq!(UNKNOWN_TEXT, "不可得");
        for retired in [
            "今日消耗",
            "今日使用",
            "请求次数",
            "较昨日",
            "对比昨日",
            "vs 昨日",
        ] {
            assert_ne!(METRIC_LABEL_EFFECTIVE_TOKENS, retired);
            assert_ne!(METRIC_LABEL_RECORD_COUNT, retired);
            assert_ne!(COMPARE_LABEL, retired);
        }
    }

    // ---- Non-tool colour mapping (T10.195 scope item 1; inverted by the
    // T10.195 review P3-4 fix round) ----

    #[test]
    fn non_tool_accents_are_not_sourced_from_the_palette_b_slot_table_except_primary() {
        // ACCENT_* must NOT alias the tool-identity slot table (T10.195
        // review P3-4: the original revision aliased ACCENT_VIOLET/
        // ACCENT_TEAL to slots 2/3, so a non-tool background glow and the
        // model-ranking bar/title silently carried an actual tool's identity
        // colour, diluting GLB-05). ACCENT_PRIMARY is the sole accepted
        // exception: it deliberately matches slot 1 (user decision U-4,
        // T10.187) — but is still its own independent literal, not an alias,
        // so it cannot drift silently if the slot table ever changes.
        assert_eq!(ACCENT_PRIMARY, TOOL_CHART_SLOT_COLORS_DARK[0]);
        for (index, &slot_color) in TOOL_CHART_SLOT_COLORS_DARK.iter().enumerate() {
            if index == 0 {
                continue; // ACCENT_PRIMARY's accepted exception, asserted above.
            }
            for accent in [ACCENT_PRIMARY, ACCENT_AXIS, ACCENT_NEUTRAL] {
                assert_ne!(
                    accent,
                    slot_color,
                    "non-tool accent {:?} must not equal tool chart slot {} ({:?})",
                    accent,
                    index + 1,
                    slot_color
                );
            }
        }
        // ACCENT_NEUTRAL aliasing the "other" bucket (not a numbered slot) is
        // intentional (DESIGN §4.4) and unaffected by the rule above.
        assert_eq!(ACCENT_NEUTRAL, TOOL_CHART_COLOR_OTHER_DARK);

        // None of the retired Apple colours are reachable through these names.
        let retired = [
            Rgba([10, 132, 255, 255]), // APPLE_BLUE
            Rgba([48, 209, 88, 255]),  // APPLE_GREEN
            Rgba([94, 92, 230, 255]),  // APPLE_INDIGO
            Rgba([191, 90, 242, 255]), // APPLE_PURPLE
            Rgba([255, 55, 95, 255]),  // APPLE_PINK
        ];
        for accent in [ACCENT_PRIMARY, ACCENT_AXIS, ACCENT_NEUTRAL] {
            for &old in &retired {
                assert_ne!(
                    accent, old,
                    "a non-tool accent must not be a retired Apple colour"
                );
            }
        }
    }

    // ---- WCAG contrast for the neutral pill fill / axis reference line ----
    //
    // Re-derives the figures recorded in docs/task-logs/T10.195/ directly in
    // Rust, against every backdrop this file actually composites these
    // accents over, so a future edit to an alpha or a backdrop colour trips a
    // test instead of silently regressing an accessibility figure nobody
    // reruns by hand. Matches the sRGB relative luminance / contrast-ratio
    // formulas from WCAG 2.x §1.4.3/§1.4.11.

    fn srgb_to_linear(c: u8) -> f64 {
        let cs = c as f64 / 255.0;
        if cs <= 0.04045 {
            cs / 12.92
        } else {
            ((cs + 0.055) / 1.055).powf(2.4)
        }
    }

    fn relative_luminance(c: Rgba<u8>) -> f64 {
        0.2126 * srgb_to_linear(c[0])
            + 0.7152 * srgb_to_linear(c[1])
            + 0.0722 * srgb_to_linear(c[2])
    }

    fn contrast_ratio(a: Rgba<u8>, b: Rgba<u8>) -> f64 {
        let la = relative_luminance(a);
        let lb = relative_luminance(b);
        let (lighter, darker) = if la >= lb { (la, lb) } else { (lb, la) };
        (lighter + 0.05) / (darker + 0.05)
    }

    /// Samples the REAL production lock-screen backdrop at 1920x1080 —
    /// `draw_lockscreen_scene_background`'s decoded-and-cropped embedded
    /// bitmap, not its procedural-gradient fallback (T10.195 review P3-5: the
    /// fallback only ever renders if the bitmap decode fails, which it does
    /// not on any supported build). Returns the raw bitmap colour (opaque, no
    /// card-fill blend yet) at the summary card's own top and bottom edges,
    /// each averaged over a small patch so one noisy/grainy pixel cannot swing
    /// the result. Callers blend the result with the card's own fill
    /// (`Rgba([3, 10, 22, 176])`, alpha 176, matching `draw_card`'s
    /// `blend_colors(pixel, fill, fill[3])`) to get the card's actual
    /// composited colour.
    fn lockscreen_card_bitmap_samples() -> (Rgba<u8>, Rgba<u8>) {
        let width = 1920u32;
        let height = 1080u32;
        let ui_sf = (width as f32 / 1920.0).min(height as f32 / 1080.0);
        let background = draw_lockscreen_scene_background(width, height, ui_sf);

        // Mirrors draw_lockscreen_wallpaper_image_with_stats's own card bounds.
        let px = |value: f32| -> i32 { (value * ui_sf).round() as i32 };
        let margin = px(72.0);
        let card_width = px(390.0);
        let card_height = px(436.0);
        let x2 = width as i32 - margin;
        let x1 = x2 - card_width;
        let y1 = ((height as i32 - card_height) / 2)
            .max(px(96.0))
            .min((height as i32 - card_height - px(48.0)).max(px(48.0)));
        let y2 = y1 + card_height;
        let center_x = (x1 + x2) / 2;

        let average_patch = |cx: i32, cy: i32| -> Rgba<u8> {
            let mut sums = [0u32; 3];
            let mut count = 0u32;
            for dy in -3..=3 {
                for dx in -3..=3 {
                    let x = (cx + dx).clamp(0, width as i32 - 1) as u32;
                    let y = (cy + dy).clamp(0, height as i32 - 1) as u32;
                    let p = background.get_pixel(x, y);
                    sums[0] += p[0] as u32;
                    sums[1] += p[1] as u32;
                    sums[2] += p[2] as u32;
                    count += 1;
                }
            }
            Rgba([
                (sums[0] / count) as u8,
                (sums[1] / count) as u8,
                (sums[2] / count) as u8,
                255,
            ])
        };

        (
            average_patch(center_x, y1 + 4),
            average_patch(center_x, y2 - 4),
        )
    }

    #[test]
    fn neutral_accent_alpha_clears_both_contrast_thresholds_on_the_desktop_panel() {
        // The two opaque surfaces NEUTRAL_ACCENT_ALPHA composites the change
        // pill over on the desktop: the KPI/trend panel fill at both gradient
        // stops (DESKTOP_CARD_FILL alpha 14 over BG_TOP/BG_BOTTOM —
        // reproduced here as literals so this test does not depend on that
        // private constant's current name). See the sibling test below for
        // the lock-screen card, sampled from the real embedded bitmap.
        let desktop_panel_top =
            blend_colors(Rgba([22, 22, 28, 255]), Rgba([255, 255, 255, 255]), 14);
        let desktop_panel_bottom =
            blend_colors(Rgba([6, 6, 10, 255]), Rgba([255, 255, 255, 255]), 14);

        for backdrop in [desktop_panel_top, desktop_panel_bottom] {
            let fill = blend_colors(backdrop, ACCENT_NEUTRAL, NEUTRAL_ACCENT_ALPHA);
            let fill_vs_backdrop = contrast_ratio(fill, backdrop);
            let text_vs_fill = contrast_ratio(TEXT_PRIMARY, fill);
            assert!(
                fill_vs_backdrop >= 3.0,
                "pill fill vs backdrop {:?} = {:.2}:1, needs >= 3:1 (graphic)",
                backdrop,
                fill_vs_backdrop
            );
            assert!(
                text_vs_fill >= 4.5,
                "TEXT_PRIMARY vs pill fill on backdrop {:?} = {:.2}:1, needs >= 4.5:1 (text)",
                backdrop,
                text_vs_fill
            );
        }
    }

    #[test]
    fn neutral_accent_alpha_clears_both_contrast_thresholds_on_the_real_lockscreen_card() {
        // T10.195 review P3-5: the pre-fix-round version of this test
        // approximated the lock-screen card's backdrop with
        // `draw_lockscreen_scene_background`'s procedural-gradient fallback,
        // which the production path essentially never reaches (the embedded
        // bitmap decodes successfully on every supported build). This samples
        // the real decoded-and-cropped bitmap instead.
        let (top, bottom) = lockscreen_card_bitmap_samples();
        for bitmap_sample in [top, bottom] {
            let card_bg = blend_colors(bitmap_sample, Rgba([3, 10, 22, 255]), 176);
            let fill = blend_colors(card_bg, ACCENT_NEUTRAL, NEUTRAL_ACCENT_ALPHA);
            let fill_vs_backdrop = contrast_ratio(fill, card_bg);
            let text_vs_fill = contrast_ratio(TEXT_PRIMARY, fill);
            assert!(
                fill_vs_backdrop >= 3.0,
                "pill fill vs the real lock-screen card {:?} = {:.2}:1, needs >= 3:1 (graphic)",
                card_bg,
                fill_vs_backdrop
            );
            assert!(
                text_vs_fill >= 4.5,
                "TEXT_PRIMARY vs pill fill on the real lock-screen card {:?} = {:.2}:1, needs >= 4.5:1 (text)",
                card_bg,
                text_vs_fill
            );
        }
    }

    #[test]
    fn axis_accent_alpha_clears_the_graphic_threshold_for_the_yesterday_line() {
        // The "yesterday" reference line/legend swatch (desktop trend panel's
        // dotted curve, lock-screen rhythm chart's dashed outline) draws
        // ACCENT_AXIS directly on the raw backdrop: the desktop's raw
        // gradient (no panel-fill overlay sits under the top trend panel) and
        // the lock screen's real embedded-bitmap card are the darkest cases.
        // No text is ever drawn on top of this line, so only the graphic
        // (>= 3:1) threshold applies (T10.195 review P3-4).
        let (top, bottom) = lockscreen_card_bitmap_samples();
        let lock_card_top = blend_colors(top, Rgba([3, 10, 22, 255]), 176);
        let lock_card_bottom = blend_colors(bottom, Rgba([3, 10, 22, 255]), 176);

        for backdrop in [
            Rgba([22, 22, 28, 255]), // BG_TOP
            Rgba([6, 6, 10, 255]),   // BG_BOTTOM
            lock_card_top,
            lock_card_bottom,
        ] {
            let line = blend_colors(backdrop, ACCENT_AXIS, AXIS_ACCENT_ALPHA);
            let line_vs_backdrop = contrast_ratio(line, backdrop);
            assert!(
                line_vs_backdrop >= 3.0,
                "yesterday line vs backdrop {:?} = {:.2}:1, needs >= 3:1 (graphic)",
                backdrop,
                line_vs_backdrop
            );
        }
    }

    #[test]
    fn model_ranking_bar_fill_clears_the_graphic_threshold_against_its_track() {
        // The bar fill draws directly on top of its own track
        // (Rgba([70, 90, 125, 130]) over the panel), fully occluding it, so
        // the track — not the panel — is the fill's real adjacent colour.
        // A slot-2-aliased "violet" only reached ~2.78:1 there (a
        // pre-existing gap under the retired APPLE_PURPLE too, ~2.74:1);
        // ACCENT_PRIMARY is what the bar and its title dot use instead
        // (T10.195 review P3-4: not a tool-slot colour other than the
        // accepted primary/slot-1 exception).
        for panel in [
            blend_colors(BG_TOP, Rgba([255, 255, 255, 255]), 14),
            blend_colors(BG_BOTTOM, Rgba([255, 255, 255, 255]), 14),
        ] {
            let track = blend_colors(panel, Rgba([70, 90, 125, 255]), 130);
            let fill = blend_colors(track, ACCENT_PRIMARY, 235);
            let fill_vs_track = contrast_ratio(fill, track);
            assert!(
                fill_vs_track >= 3.0,
                "model-ranking bar fill vs track {:?} = {:.2}:1, needs >= 3:1 (graphic)",
                track,
                fill_vs_track
            );
        }
    }

    // ---- The change pill is neutral: pixel-level guard ----
    //
    // These two tests call load_system_font(); if this machine has none of
    // the configured system fonts (it always does on the Windows dev/CI
    // machine this task gates on), they skip rather than fail, since the
    // colour-selection logic they guard is already covered without a font by
    // `change_badge_classifies_unknown_new_flat_and_directional_cases`
    // and `non_tool_accents_are_not_sourced_from_the_palette_b_slot_table_except_primary`.

    #[test]
    fn lockscreen_change_pill_fill_colour_is_identical_for_a_rise_and_a_fall() {
        let Some(font_data) = load_system_font() else {
            return;
        };
        let font = FontRef::try_from_slice(&font_data).expect("parse system font");
        let bg = Rgba([20, 20, 20, 255]);

        let mut up = RgbaImage::from_pixel(160, 40, bg);
        draw_lockscreen_badge(&mut up, &font, 4, 4, "+12.3%", 1.0);
        let mut down = RgbaImage::from_pixel(160, 40, bg);
        draw_lockscreen_badge(&mut down, &font, 4, 4, "-8.1%", 1.0);

        // The exact blended colour draw_card would have produced for the
        // pill's fill. Same alpha for the known and 不可得 cases (see
        // NEUTRAL_ACCENT_ALPHA's doc comment).
        let expected_fill = blend_colors(bg, ACCENT_NEUTRAL, NEUTRAL_ACCENT_ALPHA);
        let count =
            |img: &RgbaImage, colour: Rgba<u8>| img.pixels().filter(|&&p| p == colour).count();
        assert!(
            count(&up, expected_fill) > 20,
            "expected the neutral pill fill in the '+' render"
        );
        assert!(
            count(&down, expected_fill) > 20,
            "expected the SAME neutral pill fill in the '-' render"
        );
    }

    #[test]
    fn desktop_metric_change_pill_fill_colour_is_identical_for_a_rise_and_a_fall() {
        let Some(font_data) = load_system_font() else {
            return;
        };
        let font = FontRef::try_from_slice(&font_data).expect("parse system font");
        let bg = Rgba([20, 20, 20, 255]);
        let bounds = (0, 0, 300, 220);

        let mut up = RgbaImage::from_pixel(300, 220, bg);
        draw_reference_metric(
            &mut up,
            &font,
            bounds,
            1.0,
            ReferenceMetricContent {
                title: "T",
                value: "1",
                subtitle: "",
                color: ACCENT_PRIMARY,
                badge_text: "+5.0% ↑",
            },
        );
        let mut down = RgbaImage::from_pixel(300, 220, bg);
        draw_reference_metric(
            &mut down,
            &font,
            bounds,
            1.0,
            ReferenceMetricContent {
                title: "T",
                value: "1",
                subtitle: "",
                color: ACCENT_PRIMARY,
                badge_text: "−5.0% ↓",
            },
        );

        let expected_fill = blend_colors(bg, ACCENT_NEUTRAL, NEUTRAL_ACCENT_ALPHA);
        let count =
            |img: &RgbaImage, colour: Rgba<u8>| img.pixels().filter(|&&p| p == colour).count();
        assert!(
            count(&up, expected_fill) > 20,
            "expected the neutral pill fill in the '+' render"
        );
        assert!(
            count(&down, expected_fill) > 20,
            "expected the SAME neutral pill fill in the '-' render"
        );
    }

    // ---- P2-2: every panel draws its frame plus one 「不可得」 line on a
    // failed read -- never a curve, empty cells, bars, or a ring (T10.195
    // review P2-2, root's fix-round item 3). Each test below renders the
    // same panel-drawing function twice onto a flat, known canvas: once with
    // STAT_UNKNOWN scalars, once with real, single-item data engineered so
    // the data-ink pixel/region this test samples is unambiguous (one
    // model/tool at 100% share). The unknown render must leave that exact
    // pixel/region untouched; the known render must not -- which also proves
    // the sampled coordinate is meaningful, rather than the first assertion
    // passing vacuously because nothing was ever going to be drawn there.

    #[test]
    fn trend_panel_draws_no_curve_when_unknown_but_draws_one_when_known() {
        let Some(font_data) = load_system_font() else {
            return;
        };
        let font = FontRef::try_from_slice(&font_data).expect("parse system font");
        let bg = Rgba([20, 20, 20, 255]);
        let bounds = (0, 0, 700, 300);
        let sf = 1.0f32;
        // Mirrors draw_reference_trend_panel's own chart bbox formula so the
        // sampled region can never overlap the unconditional clock/date/
        // legend/now-marker "frame" drawn above and around it.
        let pad_x = (58.0 * sf) as i32;
        let bottom_pad = (46.0 * sf) as i32;
        let cx1 = pad_x + (30.0 * sf) as i32;
        let cy1 = (128.0 * sf) as i32;
        let cx2 = 700 - pad_x;
        let cy2 = 300 - bottom_pad;

        let mut unknown_stats =
            wall_stats_scalars(STAT_UNKNOWN, STAT_UNKNOWN, STAT_UNKNOWN, STAT_UNKNOWN);
        unknown_stats.generated_at = at(2026, 9, 26, 12, 0, 0);
        let mut unknown_img = RgbaImage::from_pixel(700, 300, bg);
        draw_reference_trend_panel(&mut unknown_img, &font, bounds, &unknown_stats, sf);

        let mut known_stats = wall_stats_scalars(500_000, 400_000, 900, 800);
        known_stats.generated_at = at(2026, 9, 26, 12, 0, 0);
        known_stats.hourly_trend = (0..24).map(|h| 1000 * (h + 1) as i64).collect();
        known_stats.yesterday_hourly_trend = (0..24).map(|h| 800 * (h + 1) as i64).collect();
        let mut known_img = RgbaImage::from_pixel(700, 300, bg);
        draw_reference_trend_panel(&mut known_img, &font, bounds, &known_stats, sf);

        // ACCENT_PRIMARY is drawn as today's curve at alpha 255 -- `draw_line`
        // gives its core (within thickness-1.0 of the exact centreline) full
        // alpha, so `blend_colors` reproduces it exactly regardless of
        // backdrop. Present somewhere in the plot band when known, absent
        // everywhere in it when unknown.
        let count_primary_in_bbox = |img: &RgbaImage| -> usize {
            let mut n = 0;
            for y in cy1..cy2 {
                for x in cx1..cx2 {
                    if *img.get_pixel(x as u32, y as u32) == ACCENT_PRIMARY {
                        n += 1;
                    }
                }
            }
            n
        };
        assert_eq!(
            count_primary_in_bbox(&unknown_img),
            0,
            "STAT_UNKNOWN must draw no curve pixels in the trend panel's plot band"
        );
        assert!(
            count_primary_in_bbox(&known_img) > 0,
            "a real reading must still draw today's curve (sanity check on the sampled band)"
        );
    }

    #[test]
    fn model_ranking_panel_draws_no_bar_when_unknown_but_draws_one_when_known() {
        let Some(font_data) = load_system_font() else {
            return;
        };
        let font = FontRef::try_from_slice(&font_data).expect("parse system font");
        let bg = Rgba([20, 20, 20, 255]);
        let bounds = (0, 0, 800, 400);
        // sf = 1.0 makes `bar_h` exactly 4 and its rounding radius (bar_h/2)
        // exactly half that height -- a fully-rounded "stadium" shape with no
        // straight vertical run at all, which is `draw_card`'s own degenerate
        // case: every pixel (not just the true end caps) is then classified
        // as border, not fill, by its `on_border` distance field, so a
        // transparent border (as this bar and its track both pass) paints
        // nothing anywhere in the shape. sf = 2.0 keeps the bar tall enough
        // (8px, radius 4) to have a genuine flat interior, which is all this
        // test means to exercise; the possible sf = 1.0 rendering gap in
        // `draw_card` itself is out of scope here (not part of P2-2) and is
        // flagged separately.
        let sf = 2.0f32;
        // Mirrors draw_reference_model_ranking's own row/bar geometry.
        let pad = (24.0 * sf) as i32;
        let rank_col_w = (22.0 * sf) as i32;
        let name_x = pad + rank_col_w;
        let bar_offset_y = (28.0 * sf) as i32;
        let row_y_start = (58.0 * sf) as i32;
        let bar_h = 4.max((4.0 * sf) as i32);

        // `unknown_stats` carries the SAME non-empty `model_ranking` as
        // `known_stats` below, differing only in `today_total`/the other
        // scalars: `has_value` (which gates whether ANY track/bar draws at
        // all) depends only on `model_ranking` itself, not on
        // `today_total`, so if the STAT_UNKNOWN guard were the only thing
        // keeping this row from drawing, giving it real ranking data here
        // is what makes that removal actually show up as a track -- an
        // empty `model_ranking` would have kept the row blank either way
        // (via `has_value`, independently of the guard) and made this test
        // pass even with the guard deleted.
        let mut unknown_stats =
            wall_stats_scalars(STAT_UNKNOWN, STAT_UNKNOWN, STAT_UNKNOWN, STAT_UNKNOWN);
        unknown_stats.generated_at = at(2026, 9, 26, 12, 0, 0);
        unknown_stats.model_ranking = vec![("solo-model".to_string(), 1000)];
        let mut unknown_img = RgbaImage::from_pixel(800, 400, bg);
        draw_reference_model_ranking(&mut unknown_img, &font, bounds, &unknown_stats, sf);

        // A single model at 100% share of today's total: the fill spans the
        // entire track. Scan a box well inside the bar (clear of its rounded
        // end caps) rather than one hand-picked pixel, so the assertion does
        // not hinge on this test's own arithmetic being pixel-exact.
        let mut known_stats = wall_stats_scalars(1000, 900, 5, 4);
        known_stats.generated_at = at(2026, 9, 26, 12, 0, 0);
        known_stats.model_ranking = vec![("solo-model".to_string(), 1000)];
        let mut known_img = RgbaImage::from_pixel(800, 400, bg);
        draw_reference_model_ranking(&mut known_img, &font, bounds, &known_stats, sf);

        // The fill draws on top of the track (already blended onto `bg` at
        // its own alpha 130), not directly onto `bg` -- same double blend as
        // `model_ranking_bar_fill_clears_the_graphic_threshold_against_its_track`
        // above.
        let expected_track = blend_colors(bg, Rgba([70, 90, 125, 255]), 130);
        let expected_fill = blend_colors(expected_track, ACCENT_PRIMARY, 235);
        let box_x = (name_x + bar_h)..(name_x + bar_h + 40);
        let box_y = (row_y_start + bar_offset_y)..(row_y_start + bar_offset_y + bar_h);
        let count_in_box = |img: &RgbaImage, colour: Rgba<u8>| -> usize {
            let mut n = 0;
            for y in box_y.clone() {
                for x in box_x.clone() {
                    if *img.get_pixel(x as u32, y as u32) == colour {
                        n += 1;
                    }
                }
            }
            n
        };
        assert_eq!(
            count_in_box(&unknown_img, expected_track),
            0,
            "STAT_UNKNOWN must draw no bar (not even the empty track) in the model-ranking panel, even with real ranking data"
        );
        assert_eq!(
            count_in_box(&unknown_img, expected_fill),
            0,
            "STAT_UNKNOWN must draw no bar fill in the model-ranking panel"
        );
        assert!(
            count_in_box(&known_img, expected_fill) > 0,
            "a real reading must still draw the bar fill (sanity check on the sampled box)"
        );
    }

    #[test]
    fn tool_distribution_panel_draws_no_ring_when_unknown_but_draws_one_when_known() {
        let Some(font_data) = load_system_font() else {
            return;
        };
        let font = FontRef::try_from_slice(&font_data).expect("parse system font");
        let bg = Rgba([20, 20, 20, 255]);
        let bounds = (0, 0, 400, 260);
        let sf = 1.0f32;
        // Mirrors draw_reference_tool_distribution's own ring geometry.
        let w = 400i32;
        let h = 260i32;
        let cx = (w as f32 * 0.31) as i32;
        let cy = (h as f32 * 0.56) as i32;
        let r_out = (34.0 * sf).max((w as f32 * 0.19).min(h as f32 * 0.34));
        let r_in = r_out * 0.68;
        let sample_x = cx as u32;
        let sample_y = (cy as f32 - (r_in + r_out) / 2.0) as u32;

        // `unknown_stats` carries the SAME non-empty `tool_distribution` as
        // `known_stats` below (differing only in `today_total`/the other
        // scalars): the panel's pre-existing "total <= 0" branch already
        // guarantees no ring for an EMPTY distribution regardless of the
        // STAT_UNKNOWN guard, so an empty fixture here would pass even with
        // that guard deleted.
        let mut unknown_stats =
            wall_stats_scalars(STAT_UNKNOWN, STAT_UNKNOWN, STAT_UNKNOWN, STAT_UNKNOWN);
        unknown_stats.generated_at = at(2026, 9, 26, 12, 0, 0);
        unknown_stats.tool_distribution = vec![("solo-tool".to_string(), 1000)];
        let mut unknown_img = RgbaImage::from_pixel(400, 260, bg);
        draw_reference_tool_distribution(&mut unknown_img, &font, bounds, &unknown_stats, sf);
        assert_eq!(
            *unknown_img.get_pixel(sample_x, sample_y),
            bg,
            "STAT_UNKNOWN must draw no donut ring in the tool-distribution panel, even with real tool data"
        );

        // A single tool at 100% share: the wedge covers the whole ring, so
        // straight up from centre is unambiguously inside it regardless of
        // the donut's own start-angle convention.
        let mut known_stats = wall_stats_scalars(1000, 900, 5, 4);
        known_stats.generated_at = at(2026, 9, 26, 12, 0, 0);
        known_stats.tool_distribution = vec![("solo-tool".to_string(), 1000)];
        let mut known_img = RgbaImage::from_pixel(400, 260, bg);
        draw_reference_tool_distribution(&mut known_img, &font, bounds, &known_stats, sf);
        assert_ne!(
            *known_img.get_pixel(sample_x, sample_y),
            bg,
            "a real reading must still draw the ring (sanity check on the sampled pixel)"
        );
    }

    #[test]
    fn heatmap_panel_draws_no_cells_when_unknown_but_draws_one_when_known() {
        let Some(font_data) = load_system_font() else {
            return;
        };
        let font = FontRef::try_from_slice(&font_data).expect("parse system font");
        let bg = Rgba([20, 20, 20, 255]);
        let bounds = (0, 0, 900, 200);
        let sf = 1.0f32;
        let now = at(2026, 9, 26, 12, 0, 0);
        // Mirrors draw_reference_heatmap_panel's own grid/date geometry.
        let pad_x = (48.0 * sf) as i32;
        let legend_w = (118.0 * sf) as i32;
        let chart_x1 = pad_x;
        let chart_x2 = 900 - pad_x - legend_w;
        let chart_y1 = (76.0 * sf) as i32;
        let chart_y2 = 200 - (32.0 * sf) as i32;
        let avail_w = chart_x2 - chart_x1;
        let avail_h = chart_y2 - chart_y1;
        let sq = ((avail_w as f32 / (52.0 + 51.0 * 0.42)) as i32)
            .min((avail_h as f32 / (7.0 + 6.0 * 0.42)) as i32)
            .max(4);
        let gap = 1.max((sq as f32 * 0.42) as i32);
        let grid_w = 52 * sq + 51 * gap;
        let grid_h = 7 * sq + 6 * gap;
        let start_x = chart_x1 + 0.max((avail_w - grid_w) / 2);
        let start_y = chart_y1 + 0.max((avail_h - grid_h) / 2);
        let days_to_sunday = (now.weekday().number_from_sunday() as i64 - 1 + 7) % 7;
        let current_week_sunday = now - Duration::days(days_to_sunday);
        let start_date = current_week_sunday - Duration::weeks(51);
        let sample_x = (start_x + sq / 2) as u32;
        let sample_y = (start_y + sq / 2) as u32;

        let mut unknown_stats =
            wall_stats_scalars(STAT_UNKNOWN, STAT_UNKNOWN, STAT_UNKNOWN, STAT_UNKNOWN);
        unknown_stats.generated_at = now;
        let mut unknown_img = RgbaImage::from_pixel(900, 200, bg);
        draw_reference_heatmap_panel(&mut unknown_img, &font, bounds, &unknown_stats, sf);
        assert_eq!(
            *unknown_img.get_pixel(sample_x, sample_y),
            bg,
            "STAT_UNKNOWN must draw no heatmap cells"
        );

        // col 0 / row 0 of the grid is exactly `start_date` (51 weeks before
        // this week's Sunday) -- comfortably in the past, never the
        // is_future skip branch.
        let mut known_stats = wall_stats_scalars(1000, 900, 5, 4);
        known_stats.generated_at = now;
        known_stats.heatmap = vec![(start_date.format("%Y-%m-%d").to_string(), 2_000_000)];
        let mut known_img = RgbaImage::from_pixel(900, 200, bg);
        draw_reference_heatmap_panel(&mut known_img, &font, bounds, &known_stats, sf);
        assert_ne!(
            *known_img.get_pixel(sample_x, sample_y),
            bg,
            "a real reading must still draw that cell (sanity check on the sampled pixel)"
        );
    }

    #[test]
    fn lockscreen_rhythm_draws_no_curve_when_unknown_but_draws_one_when_known() {
        let Some(font_data) = load_system_font() else {
            return;
        };
        let font = FontRef::try_from_slice(&font_data).expect("parse system font");
        let bg = Rgba([20, 20, 20, 255]);
        let bounds = (0, 0, 360, 420);
        let sf = 1.0f32;
        // Mirrors draw_lockscreen_summary_card's own rhythm_bounds formula.
        let px = |value: f32| -> i32 { (value * sf).round() as i32 };
        let pad = px(30.0);
        let rx1 = pad;
        let ry1 = px(312.0);
        let rx2 = 360 - pad;
        let ry2 = px(404.0);

        // `unknown_stats` carries the SAME non-zero hourly series as
        // `known_stats` below (differing only in `today_total`/the other
        // scalars): `draw_hourly_rhythm_chart` has its own separate "今日与
        // 昨日均无记录" guard for a genuinely all-zero series, which an
        // all-`vec![0; 24]` fixture (this struct's own default) would trip
        // regardless of the STAT_UNKNOWN guard one level up, in
        // `draw_lockscreen_summary_card` itself -- masking that guard's
        // removal.
        let mut unknown_stats =
            wall_stats_scalars(STAT_UNKNOWN, STAT_UNKNOWN, STAT_UNKNOWN, STAT_UNKNOWN);
        unknown_stats.generated_at = at(2026, 9, 26, 12, 0, 0);
        unknown_stats.hourly_trend = (0..24).map(|h| 1000 * (h + 1) as i64).collect();
        unknown_stats.yesterday_hourly_trend = (0..24).map(|h| 800 * (h + 1) as i64).collect();
        let mut unknown_img = RgbaImage::from_pixel(360, 420, bg);
        draw_lockscreen_summary_card(&mut unknown_img, &font, bounds, &unknown_stats, sf);

        let mut known_stats = wall_stats_scalars(500_000, 400_000, 900, 800);
        known_stats.generated_at = at(2026, 9, 26, 12, 0, 0);
        known_stats.hourly_trend = (0..24).map(|h| 1000 * (h + 1) as i64).collect();
        known_stats.yesterday_hourly_trend = (0..24).map(|h| 800 * (h + 1) as i64).collect();
        let mut known_img = RgbaImage::from_pixel(360, 420, bg);
        draw_lockscreen_summary_card(&mut known_img, &font, bounds, &known_stats, sf);

        let count_primary_in_bbox = |img: &RgbaImage| -> usize {
            let mut n = 0;
            for y in ry1..ry2 {
                for x in rx1..rx2 {
                    if *img.get_pixel(x as u32, y as u32) == ACCENT_PRIMARY {
                        n += 1;
                    }
                }
            }
            n
        };
        assert_eq!(
            count_primary_in_bbox(&unknown_img),
            0,
            "STAT_UNKNOWN must draw no curve pixels in the lock-screen rhythm band"
        );
        assert!(
            count_primary_in_bbox(&known_img) > 0,
            "a real reading must still draw today's curve (sanity check on the sampled band)"
        );
    }

    // ---- P3-2: drawing reads stats.generated_at, never an independent clock ----

    #[test]
    fn trend_panel_clock_reflects_the_stats_own_generated_at_not_the_wall_clock() {
        // A regression back to an independent `Local::now()` call is
        // deterministically detectable without OCR: two renders built from
        // otherwise-identical stats, differing ONLY in `generated_at`, are
        // REQUIRED to draw different clock digits if the panel actually
        // reads that field. If it instead reads the real wall clock, both
        // renders (executed moments apart, not 12-odd hours apart) would
        // draw the SAME digits regardless of the differing `generated_at`
        // inputs.
        let Some(font_data) = load_system_font() else {
            return;
        };
        let font = FontRef::try_from_slice(&font_data).expect("parse system font");
        let bg = Rgba([20, 20, 20, 255]);
        let bounds = (0, 0, 700, 300);
        let sf = 1.0f32;
        // The clock ("time_text", f_clock = 58*sf) is centred and drawn at
        // y1 + 22*sf, well above the chart bbox other tests use.
        let clock_y1 = (8.0 * sf) as u32;
        let clock_y2 = (95.0 * sf) as u32;

        let mut stats_a = wall_stats_scalars(500_000, 400_000, 900, 800);
        stats_a.generated_at = at(2026, 9, 26, 9, 0, 0);
        let mut img_a = RgbaImage::from_pixel(700, 300, bg);
        draw_reference_trend_panel(&mut img_a, &font, bounds, &stats_a, sf);

        let mut stats_b = wall_stats_scalars(500_000, 400_000, 900, 800);
        stats_b.generated_at = at(2026, 9, 26, 21, 45, 0);
        let mut img_b = RgbaImage::from_pixel(700, 300, bg);
        draw_reference_trend_panel(&mut img_b, &font, bounds, &stats_b, sf);

        let mut differs = false;
        for y in clock_y1..clock_y2 {
            for x in 0..700u32 {
                if img_a.get_pixel(x, y) != img_b.get_pixel(x, y) {
                    differs = true;
                }
            }
        }
        assert!(
            differs,
            "two renders with different stats.generated_at (09:00 vs 21:45) must draw \
             different clock text; identical output means the panel is reading the real \
             wall clock instead of the injected 'now'"
        );
    }

    // ---- P3-3: the desktop compare label is opaque ----

    #[test]
    fn desktop_metric_compare_label_uses_opaque_text_secondary() {
        let Some(font_data) = load_system_font() else {
            return;
        };
        let font = FontRef::try_from_slice(&font_data).expect("parse system font");
        let bg = Rgba([20, 20, 20, 255]);
        let bounds = (0, 0, 300, 220);
        let sf = 1.0f32;
        let badge_text = "+5.0% \u{2191}";

        let mut img = RgbaImage::from_pixel(300, 220, bg);
        draw_reference_metric(
            &mut img,
            &font,
            bounds,
            sf,
            ReferenceMetricContent {
                title: "T",
                value: "1",
                subtitle: "",
                color: ACCENT_PRIMARY,
                badge_text,
            },
        );

        // Mirrors draw_reference_metric's own COMPARE_LABEL geometry, so this
        // test does not depend on `badge_text`'s exact width being guessed.
        let pad = (26.0 * sf) as i32;
        let bh = (26.0 * sf) as i32;
        let f_small = 12.0 * sf;
        let bw = text_width(&font, badge_text, f_small) as i32 + (22.0 * sf) as i32;
        let badge_x = 300 - pad - bw;
        let badge_y = 220 - (44.0 * sf) as i32;
        let f_label_cmp = 12.0 * sf;
        let label_w = text_width(&font, COMPARE_LABEL, f_label_cmp);
        let row_center_y = badge_y + bh / 2;
        let label_baseline = row_center_y + (f_label_cmp * 0.34) as i32;
        let label_x = badge_x - (10.0 * sf) as i32 - label_w as i32;

        // Compare with an opaque control rendered with the very same font and
        // geometry. Anti-aliasing affects both images equally: no glyph must
        // happen to contain a fully covered pixel, and alpha 191 cannot pass
        // as opaque merely because it exceeds a blend threshold.
        let mut expected = RgbaImage::from_pixel(300, 220, bg);
        draw_text(
            &mut expected,
            &font,
            COMPARE_LABEL,
            label_x,
            label_baseline,
            f_label_cmp,
            TEXT_SECONDARY,
        );
        let mut compared_ink = false;
        for y in (label_baseline - f_label_cmp as i32 - 2).max(0)..(label_baseline + 2).min(220) {
            for x in label_x.max(0)..(label_x + label_w as i32 + 2).min(300) {
                let control = expected.get_pixel(x as u32, y as u32);
                compared_ink |= *control != bg;
                assert_eq!(
                    img.get_pixel(x as u32, y as u32),
                    control,
                    "compare label must match opaque TEXT_SECONDARY at ({x}, {y})"
                );
            }
        }
        assert!(
            compared_ink,
            "the control font must render visible label glyphs"
        );
    }

    /// Spiky hourly token data is exactly the shape that makes uniform
    /// Catmull-Rom overshoot. The monotone interpolant must stay inside the
    /// bracketing samples so the lock-screen curve never draws usage the ledger
    /// does not contain.
    #[test]
    fn monotone_interpolation_never_overshoots_the_sampled_values() {
        let samples: Vec<f64> = vec![
            0.0, 0.0, 0.0, 12_000.0, 0.0, 0.0, 800.0, 40_000.0, 39_000.0, 100.0, 0.0, 0.0, 5.0,
            90_000.0, 0.0, 0.0, 0.0, 1_200.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        ];
        let tangents = monotone_tangents(&samples);

        for i in 0..samples.len() - 1 {
            let lo = samples[i].min(samples[i + 1]);
            let hi = samples[i].max(samples[i + 1]);
            for step in 0..=32 {
                let t = step as f64 / 32.0;
                let v = monotone_hermite_at(&samples, &tangents, i, t);
                assert!(
                    v >= lo - 1e-6 && v <= hi + 1e-6,
                    "segment {i} at t={t} produced {v}, outside [{lo}, {hi}]"
                );
            }
        }
    }

    #[test]
    fn monotone_interpolation_passes_through_every_sample() {
        let samples: Vec<f64> = vec![3.0, 17.0, 5.0, 5.0, 42.0, 0.0];
        let tangents = monotone_tangents(&samples);
        for i in 0..samples.len() - 1 {
            assert!((monotone_hermite_at(&samples, &tangents, i, 0.0) - samples[i]).abs() < 1e-9);
            assert!(
                (monotone_hermite_at(&samples, &tangents, i, 1.0) - samples[i + 1]).abs() < 1e-9
            );
        }
    }

    #[test]
    fn monotone_interpolation_invents_no_peaks_on_a_flat_or_rising_series() {
        // A plateau must stay flat, and a rising run must stay non-decreasing.
        let samples: Vec<f64> = vec![0.0, 0.0, 0.0, 10.0, 20.0, 20.0, 20.0, 35.0];
        let tangents = monotone_tangents(&samples);
        let mut previous = f64::NEG_INFINITY;
        for i in 0..samples.len() - 1 {
            for step in 0..=16 {
                let v = monotone_hermite_at(&samples, &tangents, i, step as f64 / 16.0);
                assert!(
                    v >= previous - 1e-9,
                    "series dipped at segment {i}: {v} < {previous}"
                );
                previous = v;
            }
        }
    }

    #[test]
    fn curve_points_are_dense_and_stay_inside_the_plot_band() {
        let values: Vec<f64> = (0..24).map(|h| (h * 37 % 11) as f64 * 900.0).collect();
        let max_val = nice_axis_max(&values.iter().map(|&v| v as i64).collect::<Vec<_>>());

        let points = monotone_curve_points(&values, 100.0, 400.0, 20.0, 120.0, max_val, 23.0);

        assert!(points.len() > 23 * RHYTHM_SUBSAMPLES_PER_HOUR);
        for &(x, y) in &points {
            assert!((100.0..=400.0).contains(&x), "x={x} left the plot band");
            assert!((20.0..=120.0).contains(&y), "y={y} left the plot band");
        }
        assert!((points[0].0 - 100.0).abs() < 1e-3);
        assert!((points.last().unwrap().0 - 400.0).abs() < 0.5);
    }

    /// A truncated "today" slice must land on the same x grid as a full-length
    /// "yesterday" — that is the whole point of passing `axis_span` explicitly.
    #[test]
    fn a_truncated_series_ends_at_its_own_hour_not_at_the_right_edge() {
        let full: Vec<f64> = (0..24).map(|h| 100.0 + h as f64).collect();
        let today = &full[..=13];

        let points = monotone_curve_points(today, 100.0, 400.0, 20.0, 120.0, 200.0, 23.0);

        let last = points.last().expect("curve has points");
        let expected_x = 100.0 + 13.0 / 23.0 * 300.0;
        assert!((last.0 - expected_x).abs() < 0.5, "last_x={}", last.0);

        // And the terminal y must be hour 13's real value, not a dive to zero.
        let expected_y = 120.0 - (113.0 / 200.0) * 100.0;
        assert!((last.1 - expected_y).abs() < 0.5, "last_y={}", last.1);

        // Hour 0 of both series shares an x, so the two days remain comparable.
        let yesterday = monotone_curve_points(&full, 100.0, 400.0, 20.0, 120.0, 200.0, 23.0);
        assert!((points[0].0 - yesterday[0].0).abs() < 1e-3);
    }

    #[test]
    fn curve_points_handle_degenerate_series_and_spans() {
        // Fewer than two samples cannot describe a curve.
        assert!(monotone_curve_points(&[7.0], 0.0, 100.0, 0.0, 50.0, 10.0, 23.0).is_empty());
        assert!(monotone_curve_points(&[], 0.0, 100.0, 0.0, 50.0, 10.0, 23.0).is_empty());

        // A flat zero day sits exactly on the baseline.
        let flat = vec![0.0_f64; 24];
        let points = monotone_curve_points(&flat, 0.0, 100.0, 0.0, 50.0, 1.0, 23.0);
        assert!(points.iter().all(|&(_, y)| (y - 50.0).abs() < 1e-3));

        // A nonsensical span falls back to the slice length instead of dividing
        // by zero and emitting NaN/inf coordinates.
        let fallback = monotone_curve_points(&flat, 0.0, 100.0, 0.0, 50.0, 1.0, 0.0);
        assert!(fallback
            .iter()
            .all(|&(x, y)| x.is_finite() && y.is_finite()));
        assert!((fallback.last().unwrap().0 - 100.0).abs() < 0.5);
    }

    #[test]
    fn nice_axis_max_is_shared_between_today_and_yesterday() {
        let today: Vec<i64> = vec![0, 0, 900, 0];
        let yesterday: Vec<i64> = vec![0, 4_100, 0, 0];
        let combined: Vec<i64> = today.iter().chain(yesterday.iter()).cloned().collect();

        let shared = nice_axis_max(&combined);
        assert!(shared >= 4_100.0);
        assert!(shared >= nice_axis_max(&today));
        assert!(shared >= nice_axis_max(&yesterday));
    }

    #[test]
    fn area_fill_stays_between_the_curve_and_the_baseline() {
        let mut img = RgbaImage::from_pixel(40, 40, Rgba([0, 0, 0, 255]));
        // Horizontal curve at y = 10, baseline at y = 30.
        let points: Vec<(f32, f32)> = (5..35).map(|x| (x as f32, 10.0)).collect();
        fill_curve_area(&mut img, &points, 30.0, Rgba([0, 255, 0, 255]), 128);

        assert!(img.get_pixel(20, 20)[1] > 0, "band interior was not filled");
        assert_eq!(img.get_pixel(20, 5)[1], 0, "pixels above the curve leaked");
        assert_eq!(
            img.get_pixel(20, 35)[1],
            0,
            "pixels below the baseline leaked"
        );
        assert_eq!(img.get_pixel(2, 20)[1], 0, "fill escaped the x range");
    }

    #[test]
    fn area_fill_is_clipped_to_the_image_and_ignores_transparent_layers() {
        let mut img = RgbaImage::from_pixel(20, 20, Rgba([0, 0, 0, 255]));
        let out_of_bounds = vec![(-50.0_f32, -40.0_f32), (90.0, 90.0)];
        // Must not panic or write outside the buffer.
        fill_curve_area(&mut img, &out_of_bounds, 10.0, ACCENT_PRIMARY, 60);

        let mut untouched = RgbaImage::from_pixel(20, 20, Rgba([0, 0, 0, 255]));
        let points: Vec<(f32, f32)> = (0..20).map(|x| (x as f32, 2.0)).collect();
        fill_curve_area(&mut untouched, &points, 18.0, ACCENT_PRIMARY, 0);
        assert_eq!(untouched.get_pixel(10, 10)[1], 0, "alpha 0 must be a no-op");
    }
}

/// T10.187: the wallpaper's `hud_tool_color` now shares the same tool ->
/// chart-slot rules as the desktop app and Android (R-8) instead of its own
/// Apple-colour table (T10.178 review P2-7). These tests read the same JSON
/// fixtures as tests/frontend-contracts.test.mjs (T10.178 review P2-6;
/// fixtures moved to `fixtures/tool-chart-slots-v1/` in the T10.187 review
/// P3-3 fix round), so a change to the shared vectors is caught by both
/// language's test suites. `palette_b_fixture_dark_slots_match_the_wallpaper_table_and_other_colour`
/// additionally checks this file's own colour table against the same
/// fixture the desktop TS copies are checked against (T10.187 review P2-1),
/// so this file drifting away from tokens.css/types.ts/chartTheme.ts is
/// caught even though neither language reads the other's source.
#[cfg(test)]
mod tool_chart_slot_tests {
    use super::*;
    use serde_json::Value;

    const FIXTURE: &str = include_str!("../../fixtures/tool-chart-slots-v1/slots.json");
    const PALETTE_B_FIXTURE: &str =
        include_str!("../../fixtures/tool-chart-slots-v1/palette-b.json");

    fn fixture() -> Value {
        serde_json::from_str(FIXTURE).expect("slots.json must be valid JSON")
    }

    fn palette_b_fixture() -> Value {
        serde_json::from_str(PALETTE_B_FIXTURE).expect("palette-b.json must be valid JSON")
    }

    /// Parses a `#rrggbb` (or `rrggbb`) fixture literal into the same `Rgba<u8>`
    /// shape the production colour tables use, so the two can be compared
    /// directly with `assert_eq!` instead of re-stringifying one side.
    fn hex_to_rgba(hex: &str) -> Rgba<u8> {
        let hex = hex.trim_start_matches('#');
        let value = u32::from_str_radix(hex, 16).expect("fixture colour must be valid hex");
        Rgba([
            ((value >> 16) & 0xff) as u8,
            ((value >> 8) & 0xff) as u8,
            (value & 0xff) as u8,
            255,
        ])
    }

    fn assert_slot(name: &str, expected: u64) {
        assert_eq!(
            u64::from(tool_chart_slot(name)),
            expected,
            "tool_chart_slot({name:?})"
        );
    }

    fn fixture_slots(fx: &Value, key: &str) -> Vec<(String, u64)> {
        fx[key]
            .as_object()
            .unwrap_or_else(|| panic!("fixture.{key} must be an object"))
            .iter()
            .map(|(name, slot)| (name.clone(), slot.as_u64().expect("slot must be a number")))
            .collect()
    }

    #[test]
    fn fixture_registered_names_match_the_shared_slot_table() {
        let fx = fixture();
        let entries = fixture_slots(&fx, "registered");
        assert!(!entries.is_empty());
        for (name, slot) in entries {
            assert_slot(&name, slot);
        }
    }

    #[test]
    fn fixture_aliases_resolve_to_their_canonical_slot() {
        let fx = fixture();
        let entries = fixture_slots(&fx, "aliases");
        assert!(!entries.is_empty());
        for (name, slot) in entries {
            assert_slot(&name, slot);
        }
    }

    #[test]
    fn fixture_hashed_unregistered_names_match_the_shared_fnv_vectors() {
        let fx = fixture();
        let entries = fixture_slots(&fx, "hashedUnregistered");
        assert!(!entries.is_empty());
        for (name, slot) in entries {
            assert_slot(&name, slot);
        }
    }

    fn fixture_names(case: &Value) -> Vec<String> {
        case["namesInRankOrder"]
            .as_array()
            .expect("namesInRankOrder must be an array")
            .iter()
            .map(|v| v.as_str().expect("name must be a string").to_string())
            .collect()
    }

    #[test]
    fn fixture_collision_and_wrap_sequence_matches_assign_tool_chart_slots() {
        let fx = fixture();
        let case = &fx["collisionAndWrap"];
        let names = fixture_names(case);
        let expected: Vec<u32> = case["slots"]
            .as_array()
            .expect("slots must be an array")
            .iter()
            .map(|v| v.as_u64().expect("slot must be a number") as u32)
            .collect();
        let got: Vec<u32> = assign_tool_chart_slots(&names)
            .into_iter()
            .map(|assignment| match assignment {
                ToolChartSlotAssignment::Slot(slot) => slot,
                ToolChartSlotAssignment::Other => {
                    panic!("collisionAndWrap fixture must not overflow into 'other'")
                }
            })
            .collect();
        assert_eq!(got, expected, "names {names:?}");
    }

    #[test]
    fn fixture_nine_tool_view_gives_the_ninth_entry_the_neutral_other_slot() {
        let fx = fixture();
        let case = &fx["nineToolView"];
        let names = fixture_names(case);
        let expected = case["assignment"]
            .as_array()
            .expect("assignment must be an array");
        let got = assign_tool_chart_slots(&names);
        assert_eq!(got.len(), expected.len());
        for (assignment, expected_value) in got.iter().zip(expected.iter()) {
            match assignment {
                ToolChartSlotAssignment::Slot(slot) => {
                    assert_eq!(
                        u64::from(*slot),
                        expected_value.as_u64().expect("expected a slot number")
                    );
                }
                ToolChartSlotAssignment::Other => {
                    assert_eq!(expected_value.as_str(), Some("other"));
                }
            }
        }
    }

    #[test]
    fn fnv1a_fixed_vectors_match_the_desktop_and_android_implementations() {
        // Same vectors as src/types.test.ts's "R-8(a) fixed hash vectors" test
        // (T10.178 review §2.1/§2.2 cross-checked these against Android too):
        // both ends hash the same normalised UTF-16 code units, so an
        // unregistered name lands on the same slot everywhere it is drawn.
        for (name, expected) in [
            ("", 6u32),
            ("x", 8),
            ("some_future_tool", 5),
            ("未来工具", 1),
            ("cursor", 8),
            ("cline", 1),
        ] {
            assert_eq!(tool_chart_slot(name), expected, "tool_chart_slot({name:?})");
        }
        // Leading/trailing whitespace is trimmed before hashing.
        assert_eq!(tool_chart_slot("  cursor  "), tool_chart_slot("cursor"));
        assert_eq!(tool_chart_slot("\tcline\n"), tool_chart_slot("cline"));
    }

    #[test]
    fn tool_chart_slot_is_case_insensitive_and_resolves_aliases_before_the_table() {
        assert_eq!(tool_chart_slot("CLAUDE"), tool_chart_slot("claude"));
        assert_eq!(tool_chart_slot("Codex"), tool_chart_slot("codex"));
        assert_eq!(tool_chart_slot("mavis"), tool_chart_slot("marvis"));
        assert_eq!(tool_chart_slot(" MAVIS "), tool_chart_slot("marvis"));
    }

    #[test]
    fn assign_tool_chart_slots_shifts_a_same_slot_collision_and_wraps_from_8_to_1() {
        assert_eq!(
            assign_tool_chart_slots(&["codex".to_string(), "marvis".to_string()]),
            vec![
                ToolChartSlotAssignment::Slot(2),
                ToolChartSlotAssignment::Slot(3)
            ]
        );
        assert_eq!(
            assign_tool_chart_slots(&[
                "antigravity".to_string(),
                "claude".to_string(),
                "gemini".to_string()
            ]),
            vec![
                ToolChartSlotAssignment::Slot(1),
                ToolChartSlotAssignment::Slot(6),
                ToolChartSlotAssignment::Slot(2),
            ],
            "claude (slot 6) must not move just because a later name collides elsewhere"
        );
        assert_eq!(
            assign_tool_chart_slots(&["minimax".to_string(), "zcode".to_string(), "x".to_string()]),
            vec![
                ToolChartSlotAssignment::Slot(8),
                ToolChartSlotAssignment::Slot(1),
                ToolChartSlotAssignment::Slot(2),
            ],
            "zcode must wrap from slot 8 to slot 1"
        );
    }

    #[test]
    fn assign_tool_chart_slots_gives_the_9th_plus_ranked_tool_the_other_slot() {
        let eight_distinct: Vec<String> = [
            "antigravity",
            "codex",
            "pi",
            "opencode",
            "reasonix",
            "claude",
            "kilo",
            "minimax",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let one_through_eight: Vec<ToolChartSlotAssignment> =
            (1..=8u32).map(ToolChartSlotAssignment::Slot).collect();
        assert_eq!(assign_tool_chart_slots(&eight_distinct), one_through_eight);

        let mut with_overflow = eight_distinct.clone();
        with_overflow.push("gemini".to_string());
        with_overflow.push("workbuddy".to_string());
        let got = assign_tool_chart_slots(&with_overflow);
        assert_eq!(got[0..8].to_vec(), one_through_eight);
        assert_eq!(got[8], ToolChartSlotAssignment::Other);
        assert_eq!(got[9], ToolChartSlotAssignment::Other);
    }

    #[test]
    fn hud_tool_color_matches_palette_b_dark_values_in_slot_order() {
        // Palette B (T10.187, user decision U-4), dark values, in slot order.
        let expected_dark_hex = [
            "6b9dff", "907adc", "2dd4bf", "fbbf24", "fb7185", "3fe480", "3dbdf7", "fb923c",
        ];
        let slot_probe = [
            "antigravity",
            "codex",
            "pi",
            "opencode",
            "reasonix",
            "claude",
            "kilo",
            "minimax",
        ];
        for (tool, hex) in slot_probe.iter().zip(expected_dark_hex.iter()) {
            let want = u32::from_str_radix(hex, 16).expect("valid hex fixture literal");
            let want_rgba = Rgba([
                ((want >> 16) & 0xff) as u8,
                ((want >> 8) & 0xff) as u8,
                (want & 0xff) as u8,
                255,
            ]);
            assert_eq!(hud_tool_color(tool), want_rgba, "{tool} (#{hex})");
        }
    }

    #[test]
    fn colors_for_view_gives_the_9th_plus_ranked_tool_one_shared_neutral_other_colour() {
        let slot_probe = [
            "antigravity",
            "codex",
            "pi",
            "opencode",
            "reasonix",
            "claude",
            "kilo",
            "minimax",
        ];
        let with_overflow: Vec<String> = slot_probe
            .iter()
            .map(|s| s.to_string())
            .chain(["gemini".to_string(), "workbuddy".to_string()])
            .collect();
        let colors = hud_tool_colors_for_view(&with_overflow);
        assert_eq!(
            colors[8], colors[9],
            "rank 9 and rank 10 share the same 'other' colour"
        );
        assert_eq!(colors[8], TOOL_CHART_COLOR_OTHER_DARK);
        assert!(
            !colors[0..8].contains(&TOOL_CHART_COLOR_OTHER_DARK),
            "the neutral colour must be none of the 8 identity slots"
        );
    }

    #[test]
    fn colors_for_view_matches_the_single_tool_lookup_when_nothing_collides() {
        let names = vec!["claude".to_string(), "codex".to_string(), "pi".to_string()];
        let view_colors = hud_tool_colors_for_view(&names);
        for (name, color) in names.iter().zip(view_colors.iter()) {
            assert_eq!(hud_tool_color(name), *color, "{name}");
        }
    }

    #[test]
    fn palette_b_fixture_dark_slots_match_the_wallpaper_table_and_other_colour() {
        // T10.187 review P2-1: reads the SAME external fixture
        // tests/frontend-contracts.test.mjs checks tokens.css, types.ts and
        // chartTheme.ts's fallback against, so this file's own colour table
        // drifting away from any of those three desktop copies turns a test
        // red on at least one side -- unlike
        // `hud_tool_color_matches_palette_b_dark_values_in_slot_order` above,
        // which only guards this file's table against a literal hex list
        // copied into this same file (it would not notice tokens.css,
        // types.ts or chartTheme.ts changing without this file changing too).
        let fx = palette_b_fixture();
        let dark_slots = fx["dark"]["slots"]
            .as_array()
            .expect("fixture.dark.slots must be an array");
        assert_eq!(
            dark_slots.len(),
            8,
            "fixture.dark.slots must hold exactly 8 colours"
        );
        let expected: Vec<Rgba<u8>> = dark_slots
            .iter()
            .map(|v| hex_to_rgba(v.as_str().expect("fixture.dark.slots[] must be a string")))
            .collect();
        assert_eq!(
            TOOL_CHART_SLOT_COLORS_DARK.to_vec(),
            expected,
            "TOOL_CHART_SLOT_COLORS_DARK vs fixture.dark.slots"
        );

        let other = fx["dark"]["other"]
            .as_str()
            .expect("fixture.dark.other must be a string");
        assert_eq!(
            TOOL_CHART_COLOR_OTHER_DARK,
            hex_to_rgba(other),
            "TOOL_CHART_COLOR_OTHER_DARK vs fixture.dark.other"
        );
    }

    #[test]
    fn ecmascript_trim_probes_match_the_shared_fixture_vectors() {
        // T10.187 review P3-1: 12 vectors ported from Android's
        // LedgerTokensTest.kt trimProbes map, added to the shared fixture so
        // desktop TS, this file and (eventually) Android all read the same
        // vectors. Each exercises the full tool_chart_slot pipeline (trim,
        // then alias/table/hash), not is_ecmascript_trimmable in isolation --
        // see fixtures/tool-chart-slots-v1/slots.json's "trimProbes" comment
        // for why each individual case is interesting.
        let fx = fixture();
        let cases = fx["trimProbes"]["cases"]
            .as_array()
            .expect("fixture.trimProbes.cases must be an array");
        assert!(!cases.is_empty());
        for case in cases {
            let name = case["name"]
                .as_str()
                .expect("trimProbes.cases[].name must be a string");
            let slot = case["slot"]
                .as_u64()
                .expect("trimProbes.cases[].slot must be a number");
            assert_slot(name, slot);
        }
    }
}

/// Same golden strings as `src/utils/toolDisplayName.test.ts`. A display name
/// that changes in only one language fails one of these two tests (TOKE-12).
#[cfg(test)]
mod tool_display_name_tests {
    use super::tool_display_name;
    use serde_json::Value;

    const FIXTURE: &str = include_str!("../../fixtures/tool-display-names-v1/names.json");

    const GOLDEN: &[(&str, &str)] = &[
        ("opencode", "OpenCode"),
        ("OpenCode", "OpenCode"),
        ("workbuddy", "WorkBuddy"),
        ("deepseek", "DeepSeek"),
        ("deepseekgui", "DeepSeek"),
        ("dsh", "DeepSeek"),
        ("qclaw", "QClaw"),
        ("minimax", "MiniMax"),
        ("zcode", "ZCode"),
        ("kimidesktop", "Kimi"),
        ("KimiDesktop", "Kimi"),
        ("mavis", "Marvis"),
        ("marvis", "Marvis"),
        ("codex", "Codex"),
        (" codex ", "Codex"),
        ("CODEX", "Codex"),
        ("claude", "Claude"),
        ("reasonix", "ReasoniX"),
        ("antigravity", "Antigravity"),
        ("gemini", "Gemini"),
        ("hermes", "Hermes"),
        ("pi", "Pi"),
        ("grok", "Grok"),
        ("kilo", "Kilo"),
        ("kimi", "Kimi"),
        ("trae", "Trae"),
        ("", "未命名工具"),
        ("   ", "未命名工具"),
        ("cursor", "Cursor"),
        ("未来工具", "未来工具"),
        ("\u{feff}codex", "Codex"),
        ("\u{0085}codex", "\u{0085}codex"),
    ];

    #[test]
    fn golden_names_match_the_shared_fixture_and_the_desktop_table() {
        for (id, name) in GOLDEN {
            assert_eq!(tool_display_name(id), *name, "{id:?}");
        }

        let fixture: Value = serde_json::from_str(FIXTURE).expect("names.json");
        let names = fixture["names"].as_object().expect("names");
        let aliases = fixture["aliases"].as_object().expect("aliases");
        assert_eq!(fixture["emptyLabel"], "未命名工具");
        for (id, name) in names {
            assert!(
                aliases.get(id).is_none(),
                "{id} is both a name and an alias"
            );
            assert_eq!(tool_display_name(id), name.as_str().unwrap(), "{id}");
        }
        for (alias, canonical) in aliases {
            let canonical = canonical.as_str().unwrap();
            let expected = names
                .get(canonical)
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("{alias} -> {canonical} missing from names"));
            assert_eq!(tool_display_name(alias), expected, "{alias}");
        }
    }
}
