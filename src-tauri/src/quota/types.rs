use serde::{Deserialize, Serialize};

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QuotaScope {
    ConsumerSubscription,
    ApiOrganization,
    ManualBudget,
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QuotaSource {
    OfficialApi,
    LocalAuthorized,
    Manual,
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QuotaMode {
    Automatic,
    Manual,
    Unsupported,
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QuotaCapability {
    Stable,
    PlanDependent,
    Experimental,
    Manual,
    Unsupported,
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QuotaStatus {
    Ok,
    Stale,
    Unsupported,
    AuthRequired,
    Error,
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QuotaWindowStatus {
    Ok,
    Stale,
    AuthRequired,
    Error,
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QuotaUnit {
    Percent,
    Requests,
    Tokens,
    Usd,
    Credits,
    Currency,
}

pub const QUOTA_KNOWN_UNITS: [&str; 6] = [
    "percent", "requests", "tokens", "usd", "credits", "currency",
];

/// Contract §4 reason codes that vendor balance sources emit, including on
/// LKG `stale` envelopes, beyond the base sync registry. Every code here must
/// also be in the server `quota_snapshot_reason_valid_v1`, or the cloud
/// rejects the whole upload.
pub const BALANCE_REASON_CODES: [&str; 2] = ["api_key_required", "balance_unavailable"];

/// ISO 4217 code shape required by contract §2.2 (`^[A-Z]{3}$`).
pub fn valid_currency_code(value: &str) -> bool {
    value.len() == 3 && value.bytes().all(|byte| byte.is_ascii_uppercase())
}

/// Contract §2.2 window invariants that sit on top of the generic value
/// checks: the code accompanies exactly the `currency` unit, balance windows
/// carry no reset timeline and never use `credits_unlimited`.
pub fn currency_fields_valid(
    unit: QuotaUnit,
    currency: Option<&str>,
    window_minutes: Option<u64>,
    resets_at: Option<&str>,
    reason_code: Option<&str>,
) -> bool {
    match unit {
        QuotaUnit::Currency => {
            currency.is_some_and(valid_currency_code)
                && window_minutes.is_none()
                && resets_at.is_none()
                && reason_code != Some("credits_unlimited")
        }
        _ => currency.is_none(),
    }
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QuotaActionKind {
    OpenUrl,
    OpenSettings,
    ShowCommand,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuotaAction {
    pub kind: QuotaActionKind,
    pub label_key: String,
    pub value: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuotaWindowSnapshot {
    pub provider_id: String,
    pub window_id: String,
    pub window_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
    pub scope: QuotaScope,
    pub source: QuotaSource,
    pub status: QuotaWindowStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining: Option<f64>,
    pub unit: QuotaUnit,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_minutes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
    pub observed_at: String,
    pub fetched_at: String,
    pub stale_after_seconds: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuotaProviderEnvelope {
    pub schema_version: u8,
    pub provider_id: String,
    pub display_name: String,
    pub scope: QuotaScope,
    pub mode: QuotaMode,
    pub capability: QuotaCapability,
    pub status: QuotaStatus,
    pub windows: Vec<QuotaWindowSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<QuotaAction>,
}
