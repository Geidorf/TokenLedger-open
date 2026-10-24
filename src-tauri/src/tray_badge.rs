//! Windows / Linux 托盘图标上的数字（菜单栏 / 托盘增强）。
//!
//! macOS 菜单栏有标题位，数字写在图标旁；Windows 与 Linux 的托盘只有一个图标，
//! 开启「托盘显示数字」后把整枚图标换成一块带数字的徽章：今日预估费用或最紧额度的可用百分比。
//! 这里只做纯计算（选文字、画像素），不碰窗口与托盘句柄，方便单测。

/// 徽章边长（逻辑像素）。系统按 DPI 缩到 16/20/24，32 在 100%–200% 缩放下都清楚。
pub const BADGE_SIZE: u32 = 32;
const PADDING: u32 = 3;
const GLYPH_ROWS: usize = 5;

/// 徽章底色，与看板额度档位同一组阈值（低于 20% 告急、低于 50% 偏紧）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BadgeTone {
    Accent,
    Warn,
    Critical,
    Muted,
}

impl BadgeTone {
    fn rgb(self) -> [u8; 3] {
        match self {
            BadgeTone::Accent => [0x4f, 0x46, 0xe5],
            BadgeTone::Warn => [0xb4, 0x53, 0x09],
            BadgeTone::Critical => [0xdc, 0x26, 0x26],
            BadgeTone::Muted => [0x4b, 0x55, 0x63],
        }
    }
}

/// 一块徽章要画的内容：按信息量从多到少排的候选文字（放不下就退到下一个）与底色。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BadgeSpec {
    pub candidates: Vec<String>,
    pub tone: BadgeTone,
}

/// 今日预估费用（美元）。读不到写「--」而不是 0（GLB-01）。
pub fn cost_badge(cost: Option<f64>) -> BadgeSpec {
    let Some(cost) = cost.filter(|value| value.is_finite() && *value >= 0.0) else {
        return BadgeSpec {
            candidates: vec!["--".to_string()],
            tone: BadgeTone::Muted,
        };
    };
    let candidates = if cost < 9.95 {
        // 一位小数；0.04 以下写 $0，不写成误导的 $0.0。
        let tenths = (cost * 10.0).round() as u64;
        if tenths == 0 {
            vec!["$0".to_string()]
        } else {
            vec![
                format!("${}.{}", tenths / 10, tenths % 10),
                format!("{}.{}", tenths / 10, tenths % 10),
            ]
        }
    } else if cost < 999.5 {
        let whole = cost.round() as u64;
        vec![format!("${whole}"), format!("{whole}")]
    } else if cost < 9_950.0 {
        let hundreds = (cost / 100.0).round() as u64;
        vec![format!("{}.{}k", hundreds / 10, hundreds % 10)]
    } else {
        let thousands = ((cost / 1_000.0).round() as u64).min(99);
        vec![format!("{thousands}k")]
    };
    BadgeSpec {
        candidates,
        tone: BadgeTone::Accent,
    }
}

/// 最紧额度的可用百分比；没有可读窗口写「--」。
pub fn quota_badge(remaining: Option<u8>) -> BadgeSpec {
    let Some(remaining) = remaining.map(|value| value.min(100)) else {
        return BadgeSpec {
            candidates: vec!["--".to_string()],
            tone: BadgeTone::Muted,
        };
    };
    let tone = if remaining < 20 {
        BadgeTone::Critical
    } else if remaining < 50 {
        BadgeTone::Warn
    } else {
        BadgeTone::Accent
    };
    BadgeSpec {
        candidates: vec![format!("{remaining}%"), format!("{remaining}")],
        tone,
    }
}

/// 3×5 点阵；每行低三位从左到右。`.` 只占一列。
fn glyph(ch: char) -> Option<(usize, [u8; GLYPH_ROWS])> {
    let rows = match ch {
        '0' => [0b111, 0b101, 0b101, 0b101, 0b111],
        '1' => [0b010, 0b110, 0b010, 0b010, 0b111],
        '2' => [0b111, 0b001, 0b111, 0b100, 0b111],
        '3' => [0b111, 0b001, 0b111, 0b001, 0b111],
        '4' => [0b101, 0b101, 0b111, 0b001, 0b001],
        '5' => [0b111, 0b100, 0b111, 0b001, 0b111],
        '6' => [0b111, 0b100, 0b111, 0b101, 0b111],
        '7' => [0b111, 0b001, 0b001, 0b001, 0b001],
        '8' => [0b111, 0b101, 0b111, 0b101, 0b111],
        '9' => [0b111, 0b101, 0b111, 0b001, 0b111],
        '%' => [0b101, 0b001, 0b010, 0b100, 0b101],
        '$' => [0b011, 0b110, 0b010, 0b011, 0b110],
        'k' => [0b100, 0b101, 0b110, 0b101, 0b101],
        '-' => [0b000, 0b000, 0b111, 0b000, 0b000],
        '.' => return Some((1, [0, 0, 0, 0, 1])),
        _ => return None,
    };
    Some((3, rows))
}

/// 文字的点阵宽度（列数，字间 1 列）；含不认识的字符时返回 None。
fn text_columns(text: &str) -> Option<usize> {
    let mut total = 0;
    for (index, ch) in text.chars().enumerate() {
        let (width, _) = glyph(ch)?;
        total += width + usize::from(index > 0);
    }
    Some(total)
}

/// 选一条放得下的文字与横向放大倍数：横向至少放大 2 倍才看得清，放不下就退到下一条候选。
pub fn fit_text(spec: &BadgeSpec, size: u32) -> Option<(String, u32)> {
    let room = size.saturating_sub(PADDING * 2) as usize;
    spec.candidates.iter().find_map(|text| {
        let columns = text_columns(text)?;
        let scale = (room / columns.max(1)) as u32;
        (scale >= 2).then(|| (text.clone(), scale.min(4)))
    })
}

/// 画一块 `size`×`size` 的 RGBA 徽章：圆角底色 + 居中的白色点阵数字。字太宽时返回 None，
/// 调用方保持原图标。
pub fn render_badge(spec: &BadgeSpec, size: u32) -> Option<Vec<u8>> {
    let (text, scale_x) = fit_text(spec, size)?;
    // 纵向比横向多放大一半，数字瘦高些，16px 托盘里也认得出。
    let room = size.saturating_sub(PADDING * 2);
    let scale_y = ((scale_x * 3).div_ceil(2))
        .min(room / GLYPH_ROWS as u32)
        .max(1);
    let side = size as usize;
    let mut pixels = vec![0u8; side * side * 4];
    let [r, g, b] = spec.tone.rgb();
    let radius = (size as f64) * 0.22;
    for y in 0..side {
        for x in 0..side {
            let coverage =
                rounded_rect_coverage(x as f64 + 0.5, y as f64 + 0.5, size as f64, radius);
            if coverage > 0.0 {
                let offset = (y * side + x) * 4;
                pixels[offset..offset + 4].copy_from_slice(&[
                    r,
                    g,
                    b,
                    (coverage * 255.0).round() as u8,
                ]);
            }
        }
    }
    let columns = text_columns(&text)?;
    let width = columns * scale_x as usize;
    let height = GLYPH_ROWS * scale_y as usize;
    let left = (side - width) / 2;
    let top = (side - height) / 2;
    let mut cursor = left;
    for ch in text.chars() {
        let (glyph_width, rows) = glyph(ch)?;
        for (row, bits) in rows.iter().enumerate() {
            for column in 0..glyph_width {
                if bits & (1 << (glyph_width - 1 - column)) == 0 {
                    continue;
                }
                for dy in 0..scale_y as usize {
                    for dx in 0..scale_x as usize {
                        let x = cursor + column * scale_x as usize + dx;
                        let y = top + row * scale_y as usize + dy;
                        let offset = (y * side + x) * 4;
                        pixels[offset..offset + 4].copy_from_slice(&[255, 255, 255, 255]);
                    }
                }
            }
        }
        cursor += (glyph_width + 1) * scale_x as usize;
    }
    Some(pixels)
}

/// 圆角矩形在像素中心处的覆盖率（角上做 1px 抗锯齿，其余要么 0 要么 1）。
fn rounded_rect_coverage(x: f64, y: f64, size: f64, radius: f64) -> f64 {
    let cx = x.clamp(radius, size - radius);
    let cy = y.clamp(radius, size - radius);
    let distance = ((x - cx).powi(2) + (y - cy).powi(2)).sqrt();
    (radius - distance + 0.5).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cost_badge_keeps_one_decimal_below_ten_dollars_and_never_draws_unknown_as_zero() {
        assert_eq!(cost_badge(Some(1.234)).candidates[0], "$1.2");
        assert_eq!(cost_badge(Some(0.01)).candidates, vec!["$0"]);
        assert_eq!(cost_badge(Some(12.6)).candidates[0], "$13");
        assert_eq!(cost_badge(Some(1_234.0)).candidates, vec!["1.2k"]);
        assert_eq!(cost_badge(Some(250_000.0)).candidates, vec!["99k"]);
        let unknown = cost_badge(None);
        assert_eq!(unknown.candidates, vec!["--"]);
        assert_eq!(unknown.tone, BadgeTone::Muted);
        assert_eq!(cost_badge(Some(f64::NAN)).tone, BadgeTone::Muted);
    }

    #[test]
    fn quota_badge_uses_the_dashboard_tiers() {
        assert_eq!(quota_badge(Some(12)).tone, BadgeTone::Critical);
        assert_eq!(quota_badge(Some(20)).tone, BadgeTone::Warn);
        assert_eq!(quota_badge(Some(49)).tone, BadgeTone::Warn);
        assert_eq!(quota_badge(Some(50)).tone, BadgeTone::Accent);
        assert_eq!(quota_badge(Some(37)).candidates[0], "37%");
        assert_eq!(quota_badge(None).candidates, vec!["--"]);
    }

    #[test]
    fn wide_text_falls_back_to_the_shorter_candidate() {
        // 「100%」要 15 列，26px 里横向只能放大 1 倍：退到「100」。
        assert_eq!(
            fit_text(&quota_badge(Some(100)), BADGE_SIZE),
            Some(("100".to_string(), 2))
        );
        assert_eq!(
            fit_text(&quota_badge(Some(37)), BADGE_SIZE),
            Some(("37%".to_string(), 2))
        );
        assert_eq!(
            fit_text(&quota_badge(Some(5)), BADGE_SIZE),
            Some(("5%".to_string(), 3))
        );
        assert_eq!(
            fit_text(&cost_badge(Some(4.2)), BADGE_SIZE),
            Some(("$4.2".to_string(), 2))
        );
        assert_eq!(
            fit_text(&cost_badge(Some(123.0)), BADGE_SIZE),
            Some(("123".to_string(), 2))
        );
    }

    #[test]
    fn rendered_badge_is_square_rgba_with_transparent_corners_and_white_digits() {
        let pixels = render_badge(&quota_badge(Some(37)), BADGE_SIZE).expect("fits");
        assert_eq!(pixels.len(), (BADGE_SIZE * BADGE_SIZE * 4) as usize);
        assert_eq!(pixels[3], 0, "top-left corner stays transparent");
        let white = pixels
            .chunks(4)
            .filter(|pixel| pixel == &[255, 255, 255, 255])
            .count();
        assert!(white > 40, "digits are drawn ({white} white pixels)");
        let center = ((BADGE_SIZE / 2) * BADGE_SIZE * 4 + 4) as usize;
        assert_eq!(pixels[center + 3], 255, "badge body is opaque");
    }

    #[test]
    fn unknown_characters_are_rejected_instead_of_drawn_blank() {
        let spec = BadgeSpec {
            candidates: vec!["€5".to_string()],
            tone: BadgeTone::Accent,
        };
        assert_eq!(render_badge(&spec, BADGE_SIZE), None);
    }
}
