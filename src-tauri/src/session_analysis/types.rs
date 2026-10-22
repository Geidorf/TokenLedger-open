use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    pub record_id: i64,
    pub session_id: String,
    pub tool: String,
    pub observed_at: String,
    pub turns: Vec<Turn>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unassigned_usage: Option<Usage>,
    pub coverage: Coverage,
}

impl Analysis {
    pub fn unavailable(record_id: i64, reason: &'static str) -> Self {
        Self {
            status: "unavailable",
            reason: Some(reason),
            record_id,
            session_id: String::new(),
            tool: String::new(),
            observed_at: chrono::Utc::now().to_rfc3339(),
            turns: Vec::new(),
            unassigned_usage: None,
            coverage: Coverage {
                complete: false,
                matched_record: false,
                tool_calls_known: false,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub complete: bool,
    pub matched_record: bool,
    pub tool_calls_known: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub request_count: u64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_tokens: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: String,
    pub ordinal: usize,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub status: &'static str,
    #[serde(flatten)]
    pub usage: Usage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<i64>,
    pub models: Vec<String>,
    pub tools: Vec<ToolCount>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolCount {
    pub name: String,
    pub count: u64,
}

#[derive(Debug, Clone)]
pub(super) struct Record {
    pub id: i64,
    pub tool: String,
    pub session_id: String,
    pub unique_key: String,
}

pub(super) type Failure = &'static str;
