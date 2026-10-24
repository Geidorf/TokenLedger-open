//! 终端表格与数字排版。中文与全角字符按两列宽对齐。

use chrono::{DateTime, Local};
use serde_json::Value;

#[derive(Clone, Copy)]
pub(crate) enum Align {
    Left,
    Right,
}

pub(crate) struct Table {
    headers: Vec<(String, Align)>,
    rows: Vec<Vec<String>>,
}

impl Table {
    pub(crate) fn new(headers: &[(&str, Align)]) -> Self {
        Self {
            headers: headers
                .iter()
                .map(|(name, align)| (name.to_string(), *align))
                .collect(),
            rows: Vec::new(),
        }
    }

    pub(crate) fn row(&mut self, cells: Vec<String>) {
        self.rows.push(cells);
    }

    pub(crate) fn render(&self) -> String {
        let mut widths: Vec<usize> = self
            .headers
            .iter()
            .map(|(name, _)| display_width(name))
            .collect();
        for row in &self.rows {
            for (index, cell) in row.iter().enumerate() {
                if let Some(width) = widths.get_mut(index) {
                    *width = (*width).max(display_width(cell));
                }
            }
        }
        let line = |cells: Vec<&str>| -> String {
            let mut text = String::new();
            for (index, cell) in cells.iter().enumerate() {
                let width = widths.get(index).copied().unwrap_or(0);
                let pad = " ".repeat(width.saturating_sub(display_width(cell)));
                if index > 0 {
                    text.push_str("  ");
                }
                match self.headers.get(index).map(|(_, align)| *align) {
                    Some(Align::Right) => {
                        text.push_str(&pad);
                        text.push_str(cell);
                    }
                    _ => {
                        text.push_str(cell);
                        text.push_str(&pad);
                    }
                }
            }
            let mut text = text.trim_end().to_string();
            text.push('\n');
            text
        };
        let mut out = line(self.headers.iter().map(|(name, _)| name.as_str()).collect());
        out.push_str(&line(
            widths
                .iter()
                .map(|width| "─".repeat(*width))
                .collect::<Vec<_>>()
                .iter()
                .map(String::as_str)
                .collect(),
        ));
        for row in &self.rows {
            out.push_str(&line(row.iter().map(String::as_str).collect()));
        }
        out
    }
}

/// 终端里占几列：东亚宽字符与全角符号算 2 列，其余算 1 列。
pub(crate) fn display_width(text: &str) -> usize {
    text.chars()
        .map(|ch| {
            let code = ch as u32;
            let wide = matches!(code,
                0x1100..=0x115F
                | 0x2E80..=0x303E
                | 0x3041..=0x33FF
                | 0x3400..=0x4DBF
                | 0x4E00..=0x9FFF
                | 0xA000..=0xA4CF
                | 0xAC00..=0xD7A3
                | 0xF900..=0xFAFF
                | 0xFE30..=0xFE4F
                | 0xFF00..=0xFF60
                | 0xFFE0..=0xFFE6
                | 0x1F300..=0x1F64F
                | 0x1F900..=0x1F9FF
                | 0x20000..=0x3FFFD);
            if wide {
                2
            } else {
                1
            }
        })
        .sum()
}

/// Token 与次数：千以下原样，往上用 K / M / B 保留两位小数。缺失显示「—」。
pub(crate) fn fmt_tokens(value: &Value) -> String {
    let Some(number) = value.as_f64() else {
        return "—".to_string();
    };
    let abs = number.abs();
    if abs < 1_000.0 {
        return format!("{number:.0}");
    }
    let (scaled, suffix) = if abs >= 1e9 {
        (number / 1e9, "B")
    } else if abs >= 1e6 {
        (number / 1e6, "M")
    } else {
        (number / 1e3, "K")
    };
    format!("{scaled:.2}{suffix}")
}

/// 预估费用（美元）；`null` 表示价格不可得，显示「—」而不是 $0。
pub(crate) fn fmt_cost(value: &Value) -> String {
    match value.as_f64() {
        Some(cost) => format!("${cost:.2}"),
        None => "—".to_string(),
    }
}

pub(crate) fn fmt_percent(value: f64) -> String {
    if (value - value.round()).abs() < 0.05 {
        format!("{value:.0}%")
    } else {
        format!("{value:.1}%")
    }
}

/// RFC 3339 时间换成本地 `MM-DD HH:MM`；解析不了就原样返回。
pub(crate) fn fmt_local_time(value: Option<&str>) -> String {
    let Some(raw) = value else {
        return "—".to_string();
    };
    match DateTime::parse_from_rfc3339(raw) {
        Ok(time) => time.with_timezone(&Local).format("%m-%d %H:%M").to_string(),
        Err(_) => raw.to_string(),
    }
}
