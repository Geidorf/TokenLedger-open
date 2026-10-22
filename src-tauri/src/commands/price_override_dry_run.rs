//! Read-only dry run of the price override migration (T10.189, U-8).
//!
//! Before the release that migrates old override files, root runs the
//! migration on a COPY of a user's real `prices.json` and shows the user
//! what it would take out. The copy is opened read-only and nothing is
//! written anywhere: no backup, no state record, no notice. From `src-tauri`:
//!
//! ```text
//! TOKENLEDGER_PRICE_DRY_RUN_FILE=/path/to/copy/prices.json \
//!   cargo test -j 3 --lib dry_run_a_copy_of_prices_json -- --ignored --nocapture
//! ```
//!
//! The report lists per model the prices the migration removes and keeps and
//! why, names the legacy traits that make it migrate the whole file (review
//! P3-a) and lists the removed prices whose rate changes: those are the ones
//! to go through with the user.

use super::*;
use std::fmt::Write as _;
use std::io::Read as _;

const DRY_RUN_FILE_ENV: &str = "TOKENLEDGER_PRICE_DRY_RUN_FILE";
/// The app data directory's name on every platform (`app_paths::APP_ID`).
const APP_DATA_DIR_NAME: &str = "com.jeidorf.tokenledger";
/// Trait locations listed per kind before the list is cut short.
const LISTED_TRAIT_LOCATIONS: usize = 30;

/// Where a file shows the traits `has_legacy_override_traits` looks for.
#[derive(Default)]
struct LegacyTraits {
    pending_rows: Vec<String>,
    at_current_price: Vec<String>,
    dropped_model_pins: Vec<String>,
}

impl LegacyTraits {
    fn count(&self) -> usize {
        self.pending_rows.len() + self.at_current_price.len() + self.dropped_model_pins.len()
    }
}

fn legacy_trait_locations(defaults: &Value, overrides: &Map<String, Value>) -> LegacyTraits {
    let mut traits = LegacyTraits::default();
    for (model, entry) in overrides {
        let Some(fields) = entry.as_object() else {
            continue;
        };
        if price_override_status(entry) == Some("auto_discovered") {
            traits.pending_rows.push(model.clone());
            continue;
        }
        match defaults.get(model) {
            Some(bundled_entry) => {
                for field in PRICE_RATE_FIELDS {
                    let at_current = fields.get(field).is_some_and(|value| {
                        bundled_entry
                            .get(field)
                            .is_some_and(|bundled| price_values_equal(value, bundled))
                    });
                    if at_current {
                        traits.at_current_price.push(format!("{model}.{field}"));
                    }
                }
            }
            None if is_legacy_whole_table_pin(model, fields) => {
                traits.dropped_model_pins.push(model.clone());
            }
            None => {}
        }
    }
    traits
}

/// What the rules of `migrate_legacy_price_overrides` say about one rate
/// field; the report checks it against the migration's real output.
struct FieldVerdict {
    field: &'static str,
    value: Value,
    removed: bool,
    reason: String,
    /// Removed for equalling a price a released bundled table had but today's
    /// does not: a value typed on purpose can be hit by this (review P3-a).
    historical: bool,
}

struct ModelVerdict {
    kind: String,
    fields: Vec<FieldVerdict>,
    row_removed: bool,
    row_reason: String,
}

fn verdict(field: &'static str, value: &Value, removed: bool, reason: String) -> FieldVerdict {
    FieldVerdict {
        field,
        value: value.clone(),
        removed,
        reason,
        historical: false,
    }
}

/// Explains, by the rules the migration applies, what happens to `model`.
/// `before` and `after` are the explicit tables the migration compares
/// fallback estimates with (`migrate_legacy_price_overrides`).
fn explain_model(
    defaults: &Value,
    before: &Value,
    after: &Value,
    model: &str,
    entry: &Value,
) -> ModelVerdict {
    let Some(fields) = entry.as_object() else {
        return ModelVerdict {
            kind: "不是价格对象".to_string(),
            fields: Vec::new(),
            row_removed: false,
            row_reason: "原样保留".to_string(),
        };
    };
    let rates: Vec<(&'static str, &Value)> = PRICE_RATE_FIELDS
        .iter()
        .filter_map(|field| fields.get(*field).map(|value| (*field, value)))
        .collect();
    let bundled_entry = defaults.get(model);
    let at_current = |field: &str, value: &Value| {
        bundled_entry
            .and_then(|bundled| bundled.get(field))
            .is_some_and(|bundled| price_values_equal(value, bundled))
    };
    let status = price_override_status(entry);
    if status == Some("auto_discovered") {
        return ModelVerdict {
            kind: "待核价行（auto_discovered）".to_string(),
            fields: rates
                .iter()
                .map(|&(field, value)| {
                    verdict(
                        field,
                        value,
                        true,
                        "待核价行：旧版本保存时把自动发现的估算价整行写入".to_string(),
                    )
                })
                .collect(),
            row_removed: true,
            row_reason: "整行删除；这个型号回到待核价或改用内置价".to_string(),
        };
    }
    let all_removed = |verdicts: &[FieldVerdict]| {
        !verdicts.is_empty() && verdicts.iter().all(|verdict| verdict.removed)
    };
    if let Some(status @ ("user_edited" | "models_dev_imported")) = status {
        let fallback_key = price_override_fallback_key(entry);
        let fallbacks = [
            discovered_fallback_rates(before, &fallback_key),
            discovered_fallback_rates(after, &fallback_key),
        ];
        let earlier = legacy_fallback_price_candidates(&fallback_key);
        let imported = imported_price_fields(entry).unwrap_or_default();
        let fields: Vec<FieldVerdict> = rates
            .iter()
            .map(|&(field, value)| {
                if at_current(field, value) {
                    return verdict(field, value, true, "等于当前内置价".to_string());
                }
                if imported.contains(&field) {
                    return verdict(
                        field,
                        value,
                        false,
                        "models.dev 导入价（只在等于当前内置价时删除）".to_string(),
                    );
                }
                if bundled_entry.is_some() && is_legacy_bundled_price(model, field, value) {
                    return FieldVerdict {
                        historical: true,
                        ..verdict(
                            field,
                            value,
                            true,
                            "等于该型号某个已发布版本的内置价".to_string(),
                        )
                    };
                }
                let at_fallback = fallbacks.iter().any(|fallback| {
                    fallback
                        .get(field)
                        .is_some_and(|rate| price_values_equal(value, rate))
                });
                if at_fallback {
                    return verdict(
                        field,
                        value,
                        true,
                        format!("等于兜底估算（{fallback_key}，整理前或整理后）"),
                    );
                }
                let at_earlier_fallback = value.as_f64().is_some_and(|number| {
                    earlier
                        .get(field)
                        .is_some_and(|values| price_number_in(values, number))
                });
                if at_earlier_fallback {
                    return verdict(
                        field,
                        value,
                        true,
                        format!("等于旧版本给出的兜底估算（{fallback_key}）"),
                    );
                }
                verdict(
                    field,
                    value,
                    false,
                    "用户值：不等于任何一版内置价或兜底估算".to_string(),
                )
            })
            .collect();
        let row_removed = all_removed(&fields);
        return ModelVerdict {
            kind: format!("自动发现型号（{status}，兜底 {fallback_key}）"),
            row_reason: if row_removed {
                "价格全部删除，整行删除；这个型号回到待核价或改用内置价".to_string()
            } else {
                "保留剩下的价格与 _meta".to_string()
            },
            fields,
            row_removed,
        };
    }
    if bundled_entry.is_some() {
        let fields: Vec<FieldVerdict> = rates
            .iter()
            .map(|&(field, value)| {
                if at_current(field, value) {
                    verdict(field, value, true, "等于当前内置价".to_string())
                } else if is_legacy_bundled_price(model, field, value) {
                    FieldVerdict {
                        historical: true,
                        ..verdict(
                            field,
                            value,
                            true,
                            "等于该型号某个已发布版本的内置价".to_string(),
                        )
                    }
                } else {
                    verdict(
                        field,
                        value,
                        false,
                        "用户值：不等于当前或任何已发布版本的内置价".to_string(),
                    )
                }
            })
            .collect();
        let row_removed = all_removed(&fields);
        return ModelVerdict {
            kind: "内置型号".to_string(),
            row_reason: if row_removed {
                "价格全部删除，整行删除；以后跟随内置价".to_string()
            } else {
                "保留剩下的价格".to_string()
            },
            fields,
            row_removed,
        };
    }
    if is_legacy_whole_table_pin(model, fields) {
        return ModelVerdict {
            kind: "已从内置表移除的型号".to_string(),
            fields: rates
                .iter()
                .map(|&(field, value)| FieldVerdict {
                    historical: true,
                    ..verdict(
                        field,
                        value,
                        true,
                        "只含该型号在已发布版本里的内置价（旧版本整表保存的残留）".to_string(),
                    )
                })
                .collect(),
            row_removed: true,
            row_reason: "整行删除".to_string(),
        };
    }
    ModelVerdict {
        kind: "非内置型号".to_string(),
        fields: rates
            .iter()
            .map(|&(field, value)| {
                verdict(
                    field,
                    value,
                    false,
                    "用户自己添加的型号，或含不在历史里的值".to_string(),
                )
            })
            .collect(),
        row_removed: false,
        row_reason: "整行保留".to_string(),
    }
}

fn rate_text(value: &Value) -> String {
    match value.as_f64() {
        Some(number) => number_text(number),
        None => value.to_string(),
    }
}

/// A rate without the float noise an estimate carries (`0.15000000000000002`).
fn number_text(number: f64) -> String {
    let text = format!("{number:.9}");
    let text = text.trim_end_matches('0').trim_end_matches('.');
    if text == "-0" {
        "0".to_string()
    } else {
        text.to_string()
    }
}

fn listed(locations: &[String]) -> String {
    let mut text = locations
        .iter()
        .take(LISTED_TRAIT_LOCATIONS)
        .cloned()
        .collect::<Vec<_>>()
        .join("、");
    if locations.len() > LISTED_TRAIT_LOCATIONS {
        let _ = write!(text, "……（只列前 {LISTED_TRAIT_LOCATIONS} 处）");
    }
    text
}

/// What the migration would do to the override file `bytes`, as a report.
/// Pure: reads nothing but `defaults` and `bytes`, writes nothing.
fn dry_run_report(defaults: &Value, bytes: &[u8], name: &str) -> String {
    let mut out = String::new();
    let digest = price_overrides_digest(bytes);
    let _ = writeln!(out, "价格覆盖整理只读演练（T10.189，U-8）");
    let _ = writeln!(out, "文件：{name}（只读打开；本次运行不写任何文件）");
    let _ = writeln!(out, "大小：{} 字节；SHA-256：{digest}", bytes.len());
    let _ = writeln!(
        out,
        "前提：应用数据目录里没有与这个文件匹配的状态记录，即从不含 T10.171 的版本升级。"
    );
    let Ok(Value::Object(legacy)) = serde_json::from_slice::<Value>(bytes) else {
        let _ = writeln!(
            out,
            "判定：无法解析，或顶层不是 JSON 对象 → 升级后忽略这个文件并保持原样；不整理，不提示。"
        );
        return out;
    };
    let _ = writeln!(out, "顶层键：{} 个", legacy.len());

    let traits = legacy_trait_locations(defaults, &legacy);
    let migrates = has_legacy_override_traits(defaults, &legacy);
    let backup_file = format!("prices.legacy-backup-{}.json", &digest[..12]);
    let _ = writeln!(out);
    if traits.count() == 0 {
        let _ = writeln!(out, "旧版特征：无。");
    } else {
        let _ = writeln!(
            out,
            "旧版特征（命中任一即整理整份文件；共 {} 处）：",
            traits.count()
        );
        if !traits.pending_rows.is_empty() {
            let _ = writeln!(
                out,
                "  - 待核价行 {} 个：{}",
                traits.pending_rows.len(),
                listed(&traits.pending_rows)
            );
        }
        if !traits.at_current_price.is_empty() {
            let _ = writeln!(
                out,
                "  - 内置型号的价格等于当前内置价 {} 处：{}",
                traits.at_current_price.len(),
                listed(&traits.at_current_price)
            );
        }
        if !traits.dropped_model_pins.is_empty() {
            let _ = writeln!(
                out,
                "  - 已从内置表移除、只含历史内置价的型号 {} 个：{}",
                traits.dropped_model_pins.len(),
                listed(&traits.dropped_model_pins)
            );
        }
    }
    if (traits.count() > 0) != migrates {
        let _ = writeln!(
            out,
            "⚠ 特征清单与 has_legacy_override_traits 的判定不一致，以判定为准：{}",
            if migrates { "整理" } else { "不整理" }
        );
    }
    if !migrates {
        let _ = writeln!(
            out,
            "判定：不带旧版特征 → 升级后原样使用，只补记哈希；不删除任何价格，也不显示设置页提示。"
        );
    } else {
        let _ = writeln!(
            out,
            "判定：带旧版特征 → 升级后首次读取价格时整理整份文件；原文件先原样备份为 {backup_file}（同名文件内容不同时加 -2 等后缀）。"
        );
        let _ = writeln!(
            out,
            "注意（评审 P3-a）：判定针对整份文件。命中任一特征后，每个型号都按旧规则处理，不只上面列出的几处；请重点核对下面标 ⚠ 的删除。"
        );
    }

    let migrated = if migrates {
        migrate_legacy_price_overrides(defaults, &legacy)
    } else {
        legacy.clone()
    };
    let before = merge_price_overrides(defaults, &Value::Object(legacy.clone()));
    // The table the migration compares fallback estimates with after it has
    // settled every row that did not start as auto-discovered.
    let settled: Map<String, Value> = migrated
        .iter()
        .filter(|(model, _)| {
            !matches!(
                legacy.get(*model).and_then(price_override_status),
                Some("user_edited" | "models_dev_imported")
            )
        })
        .map(|(model, entry)| (model.clone(), entry.clone()))
        .collect();
    let after_settled = merge_price_overrides(defaults, &Value::Object(settled));
    let after = apply_price_overrides(defaults, &migrated);
    let notice = price_migration_notice(defaults, &legacy, &migrated, &digest, &backup_file, "");

    let mut kept_models = 0;
    let mut kept_fields = 0;
    let mut mismatches = 0;
    let mut model_lines = String::new();
    let mut changed_lines = String::new();
    for (model, entry) in &legacy {
        let explained = if migrates {
            explain_model(defaults, &before, &after_settled, model, entry)
        } else {
            ModelVerdict {
                kind: "文件不带旧版特征".to_string(),
                fields: PRICE_RATE_FIELDS
                    .iter()
                    .filter_map(|&field| {
                        entry
                            .get(field)
                            .map(|value| verdict(field, value, false, "原样保留".to_string()))
                    })
                    .collect(),
                row_removed: false,
                row_reason: "整行保留".to_string(),
            }
        };
        let kept = migrated.get(model);
        if kept.is_some() {
            kept_models += 1;
        }
        let row_mismatch = explained.row_removed != kept.is_none();
        mismatches += usize::from(row_mismatch);
        let _ = writeln!(
            model_lines,
            "[{model}] {} → {}{}",
            explained.kind,
            explained.row_reason,
            if row_mismatch {
                "　⚠ 与实际整理结果不一致"
            } else {
                ""
            }
        );
        let now = price_after_migration(&after, model, entry);
        for field in &explained.fields {
            let removed = !kept
                .and_then(Value::as_object)
                .is_some_and(|kept| kept.contains_key(field.field));
            let mismatch = removed != field.removed;
            mismatches += usize::from(mismatch);
            if !removed {
                kept_fields += 1;
            }
            let mut line = format!(
                "  {} {} = {}：{}",
                if removed { "删除" } else { "保留" },
                field.field,
                rate_text(&field.value),
                field.reason
            );
            if removed {
                let previous = field.value.as_f64();
                let current = now
                    .as_ref()
                    .and_then(|entry| effective_price_rate(entry, field.field));
                match (previous, current) {
                    (Some(previous), Some(current)) if price_numbers_equal(previous, current) => {
                        let _ = write!(line, " → 现价 {}（价格不变）", number_text(current));
                    }
                    (Some(previous), current) => {
                        let current_text = current.map_or_else(
                            || "改按工具兜底价估算".to_string(),
                            |current| format!("现价 {}", number_text(current)),
                        );
                        let _ = write!(line, " → {current_text}（价格会变化）");
                        let _ = writeln!(
                            changed_lines,
                            "  {model}.{}：{} → {}{}",
                            field.field,
                            number_text(previous),
                            current.map_or_else(
                                || "改按工具兜底价估算（这个型号不再有自己的价格）".to_string(),
                                number_text
                            ),
                            if field.historical {
                                "　⚠ 等于该型号某个已发布版本的内置价：若是有意填写的值，属于巧合误删（评审 P3-a）"
                            } else {
                                ""
                            }
                        );
                    }
                    (None, _) => {
                        let _ = write!(line, "（不是数字，不算价格）");
                    }
                }
            }
            if mismatch {
                line.push_str("　⚠ 与实际整理结果不一致");
            }
            let _ = writeln!(model_lines, "{line}");
        }
    }

    let _ = writeln!(out);
    match &notice {
        Some(notice) => {
            let _ = writeln!(
                out,
                "汇总：删除 {} 个型号的 {} 项价格，其中 {} 项删除后价格会变化，{} 项与现价相同；保留 {kept_models} 个型号的 {kept_fields} 项价格。",
                notice.models_cleared,
                notice.fields_cleared,
                notice.changed.len(),
                notice.fields_cleared - notice.changed.len()
            );
            let _ = writeln!(
                out,
                "设置页提示：会显示一次（{} 个型号、{} 项，其中 {} 项价格有变化），用户关闭后同一文件不再提示。",
                notice.models_cleared,
                notice.fields_cleared,
                notice.changed.len()
            );
        }
        None => {
            let _ = writeln!(
                out,
                "汇总：不删除任何价格；保留 {kept_models} 个型号的 {kept_fields} 项价格。设置页提示：不显示。"
            );
        }
    }
    let _ = writeln!(out);
    if changed_lines.is_empty() {
        let _ = writeln!(out, "删除后价格会变化：无。");
    } else {
        let changed = notice.as_ref().map_or(0, |notice| notice.changed.len());
        let _ = writeln!(
            out,
            "删除后价格会变化（{changed} 项，发布前与用户逐条核对）："
        );
        out.push_str(&changed_lines);
    }
    let _ = writeln!(out);
    let _ = writeln!(out, "逐型号：");
    out.push_str(&model_lines);
    let _ = writeln!(out);
    if mismatches == 0 {
        let _ = writeln!(out, "核对：逐项解释与实际整理结果一致。");
    } else {
        let _ = writeln!(
            out,
            "⚠ 核对：{mismatches} 处解释与实际整理结果不一致，以实际结果（删除 / 保留）为准，并把本报告交给 root。"
        );
    }
    out
}

/// A file's identity: volume and file index on Windows, device and inode on
/// Unix. Two paths with the same identity name the same file or folder.
#[derive(Debug, PartialEq, Eq)]
struct FileIdentity {
    volume: u64,
    index: u64,
}

#[cfg(windows)]
#[repr(C)]
struct FileTime {
    low: u32,
    high: u32,
}

/// `BY_HANDLE_FILE_INFORMATION`, laid out as in `scanner::checkpoints`.
#[cfg(windows)]
#[repr(C)]
struct ByHandleFileInformation {
    attributes: u32,
    creation_time: FileTime,
    last_access_time: FileTime,
    last_write_time: FileTime,
    volume_serial_number: u32,
    size_high: u32,
    size_low: u32,
    number_of_links: u32,
    index_high: u32,
    index_low: u32,
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    #[link_name = "GetFileInformationByHandle"]
    fn get_file_information_by_handle(
        file: *mut std::ffi::c_void,
        information: *mut ByHandleFileInformation,
    ) -> i32;
}

/// The identity and hard link count of `path`, links followed. Only
/// metadata is asked for: the file is opened without read access.
#[cfg(windows)]
fn file_identity(path: &Path) -> std::io::Result<(FileIdentity, u64)> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    // Lets a folder be opened as well.
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    let file = fs::OpenOptions::new()
        .access_mode(0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?;
    let mut information = std::mem::MaybeUninit::<ByHandleFileInformation>::uninit();
    let succeeded =
        unsafe { get_file_information_by_handle(file.as_raw_handle(), information.as_mut_ptr()) };
    if succeeded == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let information = unsafe { information.assume_init() };
    let identity = FileIdentity {
        volume: u64::from(information.volume_serial_number),
        index: (u64::from(information.index_high) << 32) | u64::from(information.index_low),
    };
    Ok((identity, u64::from(information.number_of_links)))
}

#[cfg(unix)]
fn file_identity(path: &Path) -> std::io::Result<(FileIdentity, u64)> {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::metadata(path)?;
    let identity = FileIdentity {
        volume: metadata.dev(),
        index: metadata.ino(),
    };
    Ok((identity, metadata.nlink()))
}

/// Whether `file` (resolved, with `identity`) is in one of `app_data_dirs`
/// or in a folder named like the app data directory: by its resolved path,
/// or under another name for the same file or folder (`\\localhost\E$\…`,
/// a bind mount), found by identity.
fn lies_in_app_data_dir(file: &Path, identity: &FileIdentity, app_data_dirs: &[PathBuf]) -> bool {
    let folders = || file.ancestors().skip(1);
    if folders().any(|folder| {
        folder
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case(APP_DATA_DIR_NAME))
    }) {
        return true;
    }
    let same_as = |path: &Path, other: &FileIdentity| {
        file_identity(path).is_ok_and(|(found, _)| found == *other)
    };
    app_data_dirs
        .iter()
        .filter_map(|dir| dir.canonicalize().ok())
        .any(|dir| {
            file.starts_with(&dir)
                || same_as(&dir.join(PRICE_OVERRIDES_FILE), identity)
                || file_identity(&dir).is_ok_and(|(dir_identity, _)| {
                    folders().any(|folder| same_as(folder, &dir_identity))
                })
        })
}

/// Checks that `path` is an independent copy: the dry run must never read
/// the file in the app data directory, under any name (review P3-1). The
/// file itself is judged, not only its folder. Refused are a symbolic link
/// or other reparse point, a file in the app data directory (or reached
/// there through another name), and a file with more than one hard link,
/// which may be the one in the app data directory.
fn refuse_dry_run_path(path: &Path, app_data_dirs: &[PathBuf]) -> Result<(), String> {
    let read_error = |error: std::io::Error| format!("读取 {} 失败：{error}", path.display());
    let metadata = fs::symlink_metadata(path).map_err(read_error)?;
    #[cfg(windows)]
    let reparse_point = {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    };
    #[cfg(not(windows))]
    let reparse_point = false;
    if metadata.file_type().is_symlink() || reparse_point {
        return Err(format!(
            "{} 是符号链接或重解析点：请用普通复制生成独立副本，再对副本演练",
            path.display()
        ));
    }
    let file = path.canonicalize().map_err(read_error)?;
    let (identity, links) = file_identity(&file).map_err(read_error)?;
    if lies_in_app_data_dir(&file, &identity, app_data_dirs) {
        return Err(format!(
            "{} 在应用数据目录里：请先把 prices.json 复制到别处，再对副本演练",
            path.display()
        ));
    }
    if links > 1 {
        return Err(format!(
            "{} 有 {links} 个硬链接，可能连着应用数据目录里的原文件：请用普通复制生成独立副本，再对副本演练",
            path.display()
        ));
    }
    Ok(())
}

/// Reads `path` read-only and reports what the migration would do to it.
/// Only an independent copy outside the app data directory is read
/// (`refuse_dry_run_path`); the directory is found as the app finds it.
fn dry_run_price_override_file(path: &Path) -> Result<String, String> {
    dry_run_price_override_file_in(path, &[crate::app_paths::resolve_app_data_dir()])
}

/// `dry_run_price_override_file` with the app data directories to keep out
/// of given: tests pass fixtures and never resolve the real one.
fn dry_run_price_override_file_in(
    path: &Path,
    app_data_dirs: &[PathBuf],
) -> Result<String, String> {
    refuse_dry_run_path(path, app_data_dirs)?;
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|mut file| file.read_to_end(&mut bytes))
        .map_err(|error| format!("读取 {} 失败：{error}", path.display()))?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(dry_run_report(&default_prices(), &bytes, &name))
}

#[test]
#[ignore = "U-8: set TOKENLEDGER_PRICE_DRY_RUN_FILE to a COPY of a real prices.json"]
fn dry_run_a_copy_of_prices_json() {
    let Some(path) = std::env::var_os(DRY_RUN_FILE_ENV) else {
        panic!(
            "set {DRY_RUN_FILE_ENV} to the path of a COPY of prices.json, never the file in the app data directory"
        );
    };
    match dry_run_price_override_file(Path::new(&path)) {
        Ok(report) => println!("{report}"),
        Err(error) => panic!("{error}"),
    }
}

// ---- Tests of the dry run itself ----

use super::price_override_tests::{legacy_file_for_the_notice, override_file_from_old_version};

static DRY_RUN_COUNTER: AtomicU64 = AtomicU64::new(0);

fn dry_run_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "tokenledger_price_dry_run_{label}_{}_{}",
        std::process::id(),
        DRY_RUN_COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create dry run dir");
    dir
}

fn listing(dir: &Path) -> Vec<(String, u64)> {
    let mut entries: Vec<(String, u64)> = fs::read_dir(dir)
        .expect("list dir")
        .filter_map(Result::ok)
        .map(|entry| {
            let length = entry.metadata().map(|meta| meta.len()).unwrap_or_default();
            (entry.file_name().to_string_lossy().into_owned(), length)
        })
        .collect();
    entries.sort();
    entries
}

fn report_for(file: &Value) -> String {
    let bytes = serde_json::to_string_pretty(file)
        .expect("serialize")
        .into_bytes();
    dry_run_report(&default_prices(), &bytes, "prices.json")
}

#[test]
fn the_dry_run_reads_the_copy_and_writes_nothing() {
    let dir = dry_run_dir("read_only");
    let path = dir.join("prices.json");
    let bytes = serde_json::to_string_pretty(&override_file_from_old_version())
        .expect("serialize")
        .into_bytes();
    fs::write(&path, &bytes).expect("write the copy");
    let modified = fs::metadata(&path)
        .and_then(|meta| meta.modified())
        .expect("mtime");
    let before = listing(&dir);
    let app_data = dry_run_dir("read_only_app_data");

    let report =
        dry_run_price_override_file_in(&path, std::slice::from_ref(&app_data)).expect("dry run");
    let _ = fs::remove_dir_all(&app_data);

    assert_eq!(fs::read(&path).expect("read the copy"), bytes);
    assert_eq!(
        fs::metadata(&path)
            .and_then(|meta| meta.modified())
            .expect("mtime"),
        modified
    );
    // No backup, state record or notice next to it, nothing else either.
    assert_eq!(listing(&dir), before);
    assert!(report.contains(&price_overrides_digest(&bytes)));
    assert!(report.contains("判定：带旧版特征"));
    assert!(report.contains("核对：逐项解释与实际整理结果一致。"));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn the_dry_run_explains_every_price_the_way_the_migration_decides() {
    for file in [
        legacy_file_for_the_notice(),
        override_file_from_old_version(),
        json!({
            "claude-sonnet-4-5": { "input": 3, "output": 15 },
            "gpt-4.1": { "input": 1.9, "output": 8 },
            "my-local-model": { "input": 0.5, "output": 1.5 },
            "mimo-v2-flash": { "input": 0.12, "output": 0.3 },
            "claude-opus-5": {
                "input": 5, "output": 25, "cache_input": 0.3, "cache_write": 3.75,
                "_meta": {
                    "status": "models_dev_imported", "tools": ["claude"],
                    "estimated_fields": ["cache_input", "cache_write"]
                }
            },
            "future-codex-typed": {
                "input": 0.9, "output": 3.6, "cache_input": 0.12, "cache_write": 1.5,
                "_meta": {
                    "status": "models_dev_imported", "tools": ["codex"],
                    "estimated_fields": ["cache_input", "cache_write"]
                }
            },
            "future-model-x": {
                "input": 0.9, "output": 2, "cache_input": 0.15, "cache_write": 1.875,
                "_meta": { "status": "user_edited", "fallback_key": "codex-agent", "tools": ["codex"] }
            },
            "odd": 5
        }),
    ] {
        let report = report_for(&file);
        assert!(
            report.contains("核对：逐项解释与实际整理结果一致。"),
            "{report}"
        );
        assert!(!report.contains("与实际整理结果不一致"), "{report}");
    }

    let report = report_for(&legacy_file_for_the_notice());
    for line in [
        "  - 待核价行 1 个：future-model-z",
        "  - 已从内置表移除、只含历史内置价的型号 1 个：claude-sonnet-4-2",
        "汇总：删除 6 个型号的 12 项价格，其中 5 项删除后价格会变化，7 项与现价相同；保留 2 个型号的 3 项价格。",
        "设置页提示：会显示一次（6 个型号、12 项，其中 5 项价格有变化），用户关闭后同一文件不再提示。",
        "  claude-sonnet-5.input：3 → 2　⚠ 等于该型号某个已发布版本的内置价：若是有意填写的值，属于巧合误删（评审 P3-a）",
        "  claude-sonnet-4-2.input：3 → 改按工具兜底价估算（这个型号不再有自己的价格）　⚠ 等于该型号某个已发布版本的内置价：若是有意填写的值，属于巧合误删（评审 P3-a）",
        "  grok-4.3.cache_input：0 → 0.2　⚠ 等于该型号某个已发布版本的内置价：若是有意填写的值，属于巧合误删（评审 P3-a）",
        "[gpt-4.1] 内置型号 → 保留剩下的价格",
        "  保留 input = 1.9：用户值：不等于当前或任何已发布版本的内置价",
        "  删除 output = 8：等于当前内置价 → 现价 8（价格不变）",
        "[future-model-z] 待核价行（auto_discovered） → 整行删除；这个型号回到待核价或改用内置价",
        "  删除 cache_input = 0.15：待核价行：旧版本保存时把自动发现的估算价整行写入 → 现价 0.15（价格不变）",
        "[my-local-model] 非内置型号 → 整行保留",
    ] {
        assert!(report.contains(line), "missing {line:?} in\n{report}");
    }
}

#[test]
fn the_dry_run_flags_one_trait_that_migrates_the_whole_file() {
    // Review P3-a: the state record is lost and one value equals today's
    // bundled price, so the whole file migrates and a legitimate value that
    // equals an older bundled price goes with it.
    let report = report_for(&json!({
        "gpt-4.1": { "input": 2 },
        "claude-sonnet-5": { "input": 3 }
    }));

    for line in [
        "旧版特征（命中任一即整理整份文件；共 1 处）：",
        "  - 内置型号的价格等于当前内置价 1 处：gpt-4.1.input",
        "  claude-sonnet-5.input：3 → 2　⚠ 等于该型号某个已发布版本的内置价：若是有意填写的值，属于巧合误删（评审 P3-a）",
    ] {
        assert!(report.contains(line), "missing {line:?} in\n{report}");
    }
    assert!(report.contains("注意（评审 P3-a）"));
}

#[test]
fn the_dry_run_of_a_file_without_legacy_traits_keeps_everything() {
    let report = report_for(&json!({
        "claude-sonnet-5": { "input": 3, "output": 15 },
        "my-local-llm": { "input": 0.5, "output": 1.5 }
    }));

    assert!(report.contains("旧版特征：无。"));
    assert!(report.contains("判定：不带旧版特征 → 升级后原样使用"));
    assert!(report.contains("汇总：不删除任何价格；保留 2 个型号的 4 项价格。设置页提示：不显示。"));
    assert!(report.contains("删除后价格会变化：无。"));
    assert!(!report.contains("  删除 "));
}

#[test]
fn the_dry_run_reports_a_file_it_cannot_read_as_prices() {
    for content in ["{ not json", "[1, 2]"] {
        let report = dry_run_report(&default_prices(), content.as_bytes(), "prices.json");
        assert!(report.contains("判定：无法解析，或顶层不是 JSON 对象"));
    }
}

const IN_APP_DATA_DIR: &str = "在应用数据目录里";

#[test]
fn the_dry_run_refuses_the_file_in_the_app_data_directory() {
    // A folder named like the app data directory, wherever it is.
    let named = dry_run_dir("app_data").join(APP_DATA_DIR_NAME);
    fs::create_dir_all(&named).expect("create app data dir");
    fs::write(named.join("prices.json"), b"{}").expect("write prices");
    assert!(
        dry_run_price_override_file_in(&named.join("prices.json"), &[])
            .is_err_and(|error| error.contains(IN_APP_DATA_DIR))
    );

    // An app data directory of any name (`TOKENLEDGER_APPDATA`), spelled
    // any way (review P3-1 R1–R12).
    let root = dry_run_dir("custom_app_data");
    let app_data = root.join("MyLedgerData");
    fs::create_dir_all(app_data.join("sub")).expect("create app data dir");
    fs::write(app_data.join("prices.json"), b"{}").expect("write prices");
    fs::write(app_data.join("sub").join("prices.json"), b"{}").expect("write prices");
    #[cfg(windows)]
    let windows_spellings = {
        let plain = app_data.join("prices.json").to_string_lossy().into_owned();
        vec![
            PathBuf::from(plain.to_uppercase()),
            PathBuf::from(plain.replace('\\', "/")),
            PathBuf::from(format!(r"\\?\{plain}")),
        ]
    };
    #[cfg(not(windows))]
    let windows_spellings = Vec::new();
    let spellings = [
        app_data.join("prices.json"),
        app_data.join("sub").join("prices.json"),
        app_data.join("sub").join("..").join("prices.json"),
    ]
    .into_iter()
    .chain(windows_spellings);
    for path in spellings {
        let refused = dry_run_price_override_file_in(&path, std::slice::from_ref(&app_data));
        assert!(
            refused.is_err_and(|error| error.contains(IN_APP_DATA_DIR)),
            "{} was read",
            path.display()
        );
    }
    assert_eq!(fs::read(app_data.join("prices.json")).expect("read"), b"{}");

    // A copy next to it is read.
    fs::copy(app_data.join("prices.json"), root.join("prices.json")).expect("copy");
    assert!(dry_run_price_override_file_in(
        &root.join("prices.json"),
        std::slice::from_ref(&app_data)
    )
    .is_ok());
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(named.parent().expect("parent"));
}

#[test]
fn the_dry_run_refuses_a_hard_link() {
    // Review P3-1 A3: a hard link is the file in the app data directory
    // under another name; reading it reads the user's file.
    let app_data = dry_run_dir("hard_link_app_data");
    let elsewhere = dry_run_dir("hard_link_elsewhere");
    fs::write(app_data.join("prices.json"), b"{}").expect("write prices");
    fs::hard_link(app_data.join("prices.json"), elsewhere.join("linked.json")).expect("link");
    let refused = dry_run_price_override_file_in(
        &elsewhere.join("linked.json"),
        std::slice::from_ref(&app_data),
    )
    .expect_err("a hard link to the app data directory's file");
    assert!(refused.contains(IN_APP_DATA_DIR), "{refused}");

    // Linked to a file somewhere else: which one is the original cannot be
    // told, so neither name is read.
    fs::write(elsewhere.join("prices.json"), b"{}").expect("write copy");
    fs::hard_link(elsewhere.join("prices.json"), elsewhere.join("second.json")).expect("link");
    for name in ["prices.json", "second.json"] {
        let refused =
            dry_run_price_override_file_in(&elsewhere.join(name), std::slice::from_ref(&app_data))
                .expect_err("a file with two hard links");
        assert!(refused.contains("有 2 个硬链接"), "{refused}");
    }
    fs::remove_file(elsewhere.join("second.json")).expect("unlink");
    assert!(dry_run_price_override_file_in(
        &elsewhere.join("prices.json"),
        std::slice::from_ref(&app_data)
    )
    .is_ok());
    let _ = fs::remove_dir_all(&app_data);
    let _ = fs::remove_dir_all(&elsewhere);
}

#[test]
fn the_dry_run_refuses_a_symbolic_link() {
    let dir = dry_run_dir("symbolic_link");
    let target = dir.join("prices.json");
    fs::write(&target, b"{}").expect("write prices");
    let link = dir.join("link.json");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, &link).expect("symlink");
    #[cfg(windows)]
    if std::os::windows::fs::symlink_file(&target, &link).is_err() {
        // Creating one takes Developer Mode or elevation; the Unix run and
        // elevated Windows runs cover the rule.
        let _ = fs::remove_dir_all(&dir);
        return;
    }

    let refused = dry_run_price_override_file_in(&link, &[]).expect_err("a symbolic link");

    assert!(refused.contains("符号链接"), "{refused}");
    let _ = fs::remove_dir_all(&dir);
}
