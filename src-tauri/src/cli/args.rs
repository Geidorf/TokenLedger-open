//! 手写的参数解析：命令少、选项少，不为此引入解析库。

use crate::commands::LedgerExportFormat;

pub(crate) const HELP: &str = "\
tokenledger-cli —— TokenLedger 命令行

用法：tokenledger-cli <命令> [选项] [--json]

命令：
  usage [范围]            用量合计（默认今日）
      --by agent|model|account   按 Agent / 模型 / 账号拆分
      --agent <名>               只看某个 Agent（可重复）
      --model <名>               只看某个模型（可重复）
  quota                   订阅额度剩余（只读设置里已授权的来源）
  budget                  预算状态
  gateway [--limit N]     本机网关状态与最近 N 条路由（默认 10）
  scan                    立即扫描本机日志入库
  export [范围]           导出账本（默认全部）
      --format csv|json          默认 csv
      --output <文件>            写到文件；默认写到标准输出
  status [--no-quota]     一行摘要，给状态栏插件用
  mcp                     以 stdio 运行只读 MCP 服务，给 Agent 用（见 docs/mcp.md）
  help                    显示本帮助
  version                 显示版本

范围：today | week | month | year | all，或 --from YYYY-MM-DD --to YYYY-MM-DD
全局选项：--json 输出 JSON（字段见 docs/cli.md）

数据目录与桌面端相同；设置环境变量 TOKENLEDGER_APPDATA 可指向别的目录。
退出码：0 成功，1 执行失败，2 参数错误。
";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RangeArg {
    Named(String),
    Custom { start: String, end: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UsageGroup {
    Agent,
    Model,
    Account,
}

impl UsageGroup {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Model => "model",
            Self::Account => "account",
        }
    }

    /// Stats v2 里对应的顶层分组键。
    pub(crate) fn stats_key(self) -> &'static str {
        match self {
            Self::Agent => "tools",
            Self::Model => "models",
            Self::Account => "providers",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UsageArgs {
    pub range: RangeArg,
    pub by: Option<UsageGroup>,
    pub tools: Vec<String>,
    pub models: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GatewayArgs {
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExportArgs {
    /// `None` 导出整本账本。
    pub range: Option<RangeArg>,
    pub format: LedgerExportFormat,
    pub output: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Command {
    Usage(UsageArgs),
    Quota,
    Budget,
    Gateway(GatewayArgs),
    Scan,
    Export(ExportArgs),
    Status { quota: bool },
    Help,
    Version,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Invocation {
    pub command: Command,
    pub json: bool,
}

const RANGES: [&str; 5] = ["today", "week", "month", "year", "all"];
const MAX_GATEWAY_LIMIT: usize = 500;

/// 逐个取参数；`--name value` 与 `--name=value` 两种写法都认。
struct Cursor<'a> {
    args: &'a [String],
    index: usize,
}

impl<'a> Cursor<'a> {
    fn next(&mut self) -> Option<&'a str> {
        let value = self.args.get(self.index)?;
        self.index += 1;
        Some(value.as_str())
    }

    fn value_for(&mut self, flag: &str, inline: Option<&'a str>) -> Result<&'a str, String> {
        if let Some(value) = inline {
            return Ok(value);
        }
        match self.next() {
            Some(value) if !value.starts_with("--") => Ok(value),
            _ => Err(format!("{flag} 需要一个值")),
        }
    }
}

fn split_flag(arg: &str) -> (&str, Option<&str>) {
    match arg.split_once('=') {
        Some((flag, value)) if flag.starts_with("--") => (flag, Some(value)),
        _ => (arg, None),
    }
}

fn valid_date(value: &str) -> Result<String, String> {
    chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map(|date| date.format("%Y-%m-%d").to_string())
        .map_err(|_| format!("日期 {value} 应为 YYYY-MM-DD"))
}

/// 收集范围：位置参数 `today` 等，或 `--from`/`--to`（必须成对）。
#[derive(Default)]
struct RangeBuilder {
    named: Option<String>,
    from: Option<String>,
    to: Option<String>,
}

impl RangeBuilder {
    fn take_positional(&mut self, value: &str) -> Result<bool, String> {
        let lower = value.to_ascii_lowercase();
        if !RANGES.contains(&lower.as_str()) {
            return Ok(false);
        }
        if self.named.is_some() {
            return Err("只能指定一个范围".to_string());
        }
        self.named = Some(lower);
        Ok(true)
    }

    fn build(self) -> Result<Option<RangeArg>, String> {
        match (self.named, self.from, self.to) {
            (Some(_), Some(_), _) | (Some(_), _, Some(_)) => {
                Err("范围名与 --from/--to 不能同时使用".to_string())
            }
            (Some(named), None, None) => Ok(Some(RangeArg::Named(named))),
            (None, Some(start), Some(end)) => {
                if start > end {
                    return Err("--from 不能晚于 --to".to_string());
                }
                Ok(Some(RangeArg::Custom { start, end }))
            }
            (None, None, None) => Ok(None),
            _ => Err("--from 与 --to 需要同时给出".to_string()),
        }
    }
}

pub(crate) fn parse(args: &[String]) -> Result<Invocation, String> {
    let mut json = false;
    let mut rest: Vec<String> = Vec::with_capacity(args.len());
    for arg in args {
        match arg.as_str() {
            "--json" => json = true,
            "-h" | "--help" => {
                return Ok(Invocation {
                    command: Command::Help,
                    json,
                })
            }
            "-V" | "--version" => {
                return Ok(Invocation {
                    command: Command::Version,
                    json,
                })
            }
            _ => rest.push(arg.clone()),
        }
    }
    let mut cursor = Cursor {
        args: &rest,
        index: 0,
    };
    let command = match cursor.next() {
        None | Some("help") => Command::Help,
        Some("version") => Command::Version,
        Some("usage") => parse_usage(&mut cursor)?,
        Some("quota") => no_options("quota", &mut cursor, Command::Quota)?,
        Some("budget") => no_options("budget", &mut cursor, Command::Budget)?,
        Some("scan") => no_options("scan", &mut cursor, Command::Scan)?,
        Some("gateway") => parse_gateway(&mut cursor)?,
        Some("export") => parse_export(&mut cursor)?,
        Some("status") => parse_status(&mut cursor)?,
        Some(other) => return Err(format!("未知命令 {other}")),
    };
    Ok(Invocation { command, json })
}

fn no_options(name: &str, cursor: &mut Cursor<'_>, command: Command) -> Result<Command, String> {
    match cursor.next() {
        None => Ok(command),
        Some(extra) => Err(format!("{name} 不认识参数 {extra}")),
    }
}

fn parse_usage(cursor: &mut Cursor<'_>) -> Result<Command, String> {
    let mut range = RangeBuilder::default();
    let mut by = None;
    let mut tools = Vec::new();
    let mut models = Vec::new();
    while let Some(arg) = cursor.next() {
        let (flag, inline) = split_flag(arg);
        match flag {
            "--by" => {
                by = Some(match cursor.value_for(flag, inline)? {
                    "agent" | "tool" => UsageGroup::Agent,
                    "model" => UsageGroup::Model,
                    "account" | "provider" => UsageGroup::Account,
                    other => {
                        return Err(format!("--by 只接受 agent、model、account，收到 {other}"))
                    }
                })
            }
            "--agent" | "--tool" => tools.push(cursor.value_for(flag, inline)?.to_string()),
            "--model" => models.push(cursor.value_for(flag, inline)?.to_string()),
            "--from" => range.from = Some(valid_date(cursor.value_for(flag, inline)?)?),
            "--to" => range.to = Some(valid_date(cursor.value_for(flag, inline)?)?),
            _ if range.take_positional(arg)? => {}
            _ => return Err(format!("usage 不认识参数 {arg}")),
        }
    }
    Ok(Command::Usage(UsageArgs {
        range: range
            .build()?
            .unwrap_or_else(|| RangeArg::Named("today".to_string())),
        by,
        tools,
        models,
    }))
}

fn parse_gateway(cursor: &mut Cursor<'_>) -> Result<Command, String> {
    let mut limit = 10;
    while let Some(arg) = cursor.next() {
        let (flag, inline) = split_flag(arg);
        match flag {
            "--limit" | "-n" => {
                let raw = cursor.value_for(flag, inline)?;
                limit = raw
                    .parse::<usize>()
                    .ok()
                    .filter(|value| (1..=MAX_GATEWAY_LIMIT).contains(value))
                    .ok_or_else(|| format!("--limit 应为 1 到 {MAX_GATEWAY_LIMIT} 的整数"))?;
            }
            _ => return Err(format!("gateway 不认识参数 {arg}")),
        }
    }
    Ok(Command::Gateway(GatewayArgs { limit }))
}

fn parse_export(cursor: &mut Cursor<'_>) -> Result<Command, String> {
    let mut range = RangeBuilder::default();
    let mut format = LedgerExportFormat::Csv;
    let mut output = None;
    while let Some(arg) = cursor.next() {
        let (flag, inline) = split_flag(arg);
        match flag {
            "--format" => {
                format = match cursor.value_for(flag, inline)? {
                    "csv" => LedgerExportFormat::Csv,
                    "json" => LedgerExportFormat::Json,
                    other => return Err(format!("--format 只接受 csv 或 json，收到 {other}")),
                }
            }
            "--output" | "-o" => output = Some(cursor.value_for(flag, inline)?.to_string()),
            "--from" => range.from = Some(valid_date(cursor.value_for(flag, inline)?)?),
            "--to" => range.to = Some(valid_date(cursor.value_for(flag, inline)?)?),
            _ if range.take_positional(arg)? => {}
            _ => return Err(format!("export 不认识参数 {arg}")),
        }
    }
    Ok(Command::Export(ExportArgs {
        range: range.build()?,
        format,
        output,
    }))
}

fn parse_status(cursor: &mut Cursor<'_>) -> Result<Command, String> {
    let mut quota = true;
    while let Some(arg) = cursor.next() {
        match arg {
            "--no-quota" => quota = false,
            _ => return Err(format!("status 不认识参数 {arg}")),
        }
    }
    Ok(Command::Status { quota })
}
