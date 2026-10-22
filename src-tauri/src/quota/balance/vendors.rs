//! Fixed official balance endpoints and their documented response fields.
//!
//! Only endpoints with public vendor documentation are listed; the request
//! URL is always one of these constants, never derived from user input or an
//! upstream response.

use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::quota::valid_currency_code;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BalanceVendor {
    Moonshot,
    Deepseek,
    Openrouter,
    Siliconflow,
    Relay,
}

impl BalanceVendor {
    pub(crate) fn slug(self) -> &'static str {
        match self {
            Self::Moonshot => "moonshot",
            Self::Deepseek => "deepseek",
            Self::Openrouter => "openrouter",
            Self::Siliconflow => "siliconflow",
            Self::Relay => "relay",
        }
    }

    pub(crate) fn display_name(self) -> &'static str {
        match self {
            Self::Moonshot => "Moonshot 余额",
            Self::Deepseek => "DeepSeek 余额",
            Self::Openrouter => "OpenRouter 余额",
            Self::Siliconflow => "SiliconFlow 余额",
            Self::Relay => "中转余额",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct VendorEndpoint {
    pub vendor: BalanceVendor,
    pub host: &'static str,
    pub url: &'static str,
    /// Currency fixed by the vendor documentation for this host; `None` means
    /// the response itself declares the currency per entry.
    pub currency: Option<&'static str>,
}

// platform.kimi.com/docs/api/balance: data.available_balance, unit CNY.
// platform.moonshot.ai/docs/api/balance: same fields, unit USD.
// api-docs.deepseek.com/api/get-user-balance: balance_infos[].currency/total_balance.
// openrouter.ai/docs/api-reference/get-credits: data.total_credits/total_usage (USD credits).
// docs.siliconflow.com/en/api-reference/userinfo/get-user-info: data.totalBalance.
pub(crate) const VENDOR_ENDPOINTS: [VendorEndpoint; 6] = [
    VendorEndpoint {
        vendor: BalanceVendor::Moonshot,
        host: "api.moonshot.cn",
        url: "https://api.moonshot.cn/v1/users/me/balance",
        currency: Some("CNY"),
    },
    VendorEndpoint {
        vendor: BalanceVendor::Moonshot,
        host: "api.moonshot.ai",
        url: "https://api.moonshot.ai/v1/users/me/balance",
        currency: Some("USD"),
    },
    VendorEndpoint {
        vendor: BalanceVendor::Deepseek,
        host: "api.deepseek.com",
        url: "https://api.deepseek.com/user/balance",
        currency: None,
    },
    VendorEndpoint {
        vendor: BalanceVendor::Openrouter,
        host: "openrouter.ai",
        url: "https://openrouter.ai/api/v1/credits",
        currency: Some("USD"),
    },
    VendorEndpoint {
        vendor: BalanceVendor::Siliconflow,
        host: "api.siliconflow.cn",
        url: "https://api.siliconflow.cn/v1/user/info",
        currency: Some("CNY"),
    },
    VendorEndpoint {
        vendor: BalanceVendor::Siliconflow,
        host: "api.siliconflow.com",
        url: "https://api.siliconflow.com/v1/user/info",
        currency: Some("USD"),
    },
];

/// Matches a gateway provider's HTTPS base URL to a documented vendor host.
pub(crate) fn vendor_endpoint_for_base_url(base_url: &str) -> Option<VendorEndpoint> {
    let url = Url::parse(base_url).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    if url.port().is_some_and(|port| port != 443) {
        return None;
    }
    VENDOR_ENDPOINTS
        .iter()
        .copied()
        .find(|endpoint| endpoint.host == host)
}

/// The vendor allowlist: exact HTTPS URL equality with a documented endpoint.
pub(crate) fn vendor_url_allowed(url: &Url) -> bool {
    VENDOR_ENDPOINTS
        .iter()
        .any(|endpoint| Url::parse(endpoint.url).is_ok_and(|allowed| &allowed == url))
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct BalanceAmount {
    pub currency: String,
    pub remaining: f64,
}

fn non_negative_amount(value: &Value) -> Option<f64> {
    let number = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }?;
    (number.is_finite() && number >= 0.0).then_some(number)
}

fn status_not_false(root: &Value) -> bool {
    root.get("status").and_then(Value::as_bool) != Some(false)
}

fn single(currency: &str, remaining: Option<f64>) -> Result<Vec<BalanceAmount>, ()> {
    let remaining = remaining.ok_or(())?;
    Ok(vec![BalanceAmount {
        currency: currency.to_string(),
        remaining,
    }])
}

pub(crate) fn parse_vendor_response(
    endpoint: &VendorEndpoint,
    root: &Value,
) -> Result<Vec<BalanceAmount>, ()> {
    if !root.is_object() {
        return Err(());
    }
    match endpoint.vendor {
        BalanceVendor::Moonshot => {
            if !status_not_false(root) {
                return Err(());
            }
            let amount = root
                .pointer("/data/available_balance")
                .and_then(non_negative_amount);
            single(endpoint.currency.ok_or(())?, amount)
        }
        BalanceVendor::Deepseek => parse_deepseek(root),
        BalanceVendor::Openrouter => {
            let credits = root
                .pointer("/data/total_credits")
                .and_then(non_negative_amount);
            let usage = root
                .pointer("/data/total_usage")
                .and_then(non_negative_amount);
            let remaining = match (credits, usage) {
                (Some(credits), Some(usage)) if credits >= usage => Some(credits - usage),
                _ => None,
            };
            single(endpoint.currency.ok_or(())?, remaining)
        }
        BalanceVendor::Siliconflow => {
            if !status_not_false(root) {
                return Err(());
            }
            let amount = root
                .pointer("/data/totalBalance")
                .and_then(non_negative_amount);
            single(endpoint.currency.ok_or(())?, amount)
        }
        BalanceVendor::Relay => Err(()),
    }
}

fn parse_deepseek(root: &Value) -> Result<Vec<BalanceAmount>, ()> {
    let infos = root
        .get("balance_infos")
        .and_then(Value::as_array)
        .ok_or(())?;
    if infos.is_empty() || infos.len() > 8 {
        return Err(());
    }
    let mut amounts: Vec<BalanceAmount> = Vec::with_capacity(infos.len());
    for info in infos {
        let currency = info.get("currency").and_then(Value::as_str).ok_or(())?;
        if !valid_currency_code(currency)
            || amounts.iter().any(|amount| amount.currency == currency)
        {
            return Err(());
        }
        let remaining = info
            .get("total_balance")
            .and_then(non_negative_amount)
            .ok_or(())?;
        amounts.push(BalanceAmount {
            currency: currency.to_string(),
            remaining,
        });
    }
    Ok(amounts)
}

/// Dotted value path such as `data.balance` or `data.items.0.amount`.
pub(crate) fn validate_value_path(path: &str) -> bool {
    let segments: Vec<&str> = path.split('.').collect();
    !path.is_empty()
        && segments.len() <= 8
        && segments.iter().all(|segment| {
            !segment.is_empty()
                && segment.len() <= 64
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        })
}

pub(crate) fn parse_relay_response(
    root: &Value,
    value_path: &str,
    currency: &str,
) -> Result<Vec<BalanceAmount>, ()> {
    if !validate_value_path(value_path) || !valid_currency_code(currency) {
        return Err(());
    }
    let mut value = root;
    for segment in value_path.split('.') {
        value = match value {
            Value::Object(map) => map.get(segment),
            Value::Array(items) => segment
                .parse::<usize>()
                .ok()
                .and_then(|index| items.get(index)),
            _ => None,
        }
        .ok_or(())?;
    }
    single(currency, non_negative_amount(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn endpoint(host: &str) -> VendorEndpoint {
        VENDOR_ENDPOINTS
            .iter()
            .copied()
            .find(|endpoint| endpoint.host == host)
            .expect("known host")
    }

    #[test]
    fn gateway_base_urls_map_only_to_documented_hosts() {
        let kimi = vendor_endpoint_for_base_url("https://api.moonshot.cn/v1").expect("moonshot");
        assert_eq!(kimi.vendor, BalanceVendor::Moonshot);
        assert_eq!(kimi.currency, Some("CNY"));
        assert_eq!(
            vendor_endpoint_for_base_url("https://API.Moonshot.ai/v1").map(|e| e.currency),
            Some(Some("USD"))
        );
        assert_eq!(
            vendor_endpoint_for_base_url("https://api.deepseek.com/v1").map(|e| e.vendor),
            Some(BalanceVendor::Deepseek)
        );
        assert_eq!(
            vendor_endpoint_for_base_url("https://openrouter.ai/api/v1").map(|e| e.vendor),
            Some(BalanceVendor::Openrouter)
        );
        assert_eq!(
            vendor_endpoint_for_base_url("https://api.siliconflow.cn/v1").map(|e| e.vendor),
            Some(BalanceVendor::Siliconflow)
        );
        assert!(vendor_endpoint_for_base_url("http://api.deepseek.com/v1").is_none());
        assert!(vendor_endpoint_for_base_url("https://api.deepseek.com:8443/v1").is_none());
        assert!(vendor_endpoint_for_base_url("https://evil.api.deepseek.com.example/v1").is_none());
        assert!(vendor_endpoint_for_base_url("https://relay.example.com/v1").is_none());
    }

    #[test]
    fn allowlist_is_exact_url_equality() {
        assert!(vendor_url_allowed(
            &Url::parse("https://api.deepseek.com/user/balance").unwrap()
        ));
        for denied in [
            "https://api.deepseek.com/user/balance?x=1",
            "https://api.deepseek.com/v1/models",
            "https://user:pw@api.deepseek.com/user/balance",
            "http://api.deepseek.com/user/balance",
            "https://openrouter.ai.evil.example/api/v1/credits",
        ] {
            assert!(
                !vendor_url_allowed(&Url::parse(denied).unwrap()),
                "{denied}"
            );
        }
    }

    #[test]
    fn moonshot_maps_available_balance_with_host_currency() {
        let body = json!({"code": 0, "data": {"available_balance": 49.58894, "voucher_balance": 46.58893, "cash_balance": 3.00001}, "scode": "0x0", "status": true});
        let cn = parse_vendor_response(&endpoint("api.moonshot.cn"), &body).unwrap();
        assert_eq!(
            cn,
            vec![BalanceAmount {
                currency: "CNY".into(),
                remaining: 49.58894
            }]
        );
        let ai = parse_vendor_response(&endpoint("api.moonshot.ai"), &body).unwrap();
        assert_eq!(ai[0].currency, "USD");
        assert!(parse_vendor_response(
            &endpoint("api.moonshot.cn"),
            &json!({"status": false, "data": {"available_balance": 1}})
        )
        .is_err());
        assert!(parse_vendor_response(
            &endpoint("api.moonshot.cn"),
            &json!({"data": {"available_balance": -1}})
        )
        .is_err());
    }

    #[test]
    fn deepseek_keeps_each_currency_separately_and_rejects_ambiguity() {
        let body = json!({"is_available": true, "balance_infos": [
            {"currency": "CNY", "total_balance": "110.00", "granted_balance": "10.00", "topped_up_balance": "100.00"},
            {"currency": "USD", "total_balance": "5.00", "granted_balance": "0.00", "topped_up_balance": "5.00"}
        ]});
        let amounts = parse_vendor_response(&endpoint("api.deepseek.com"), &body).unwrap();
        assert_eq!(amounts.len(), 2);
        assert_eq!(
            amounts[0],
            BalanceAmount {
                currency: "CNY".into(),
                remaining: 110.0
            }
        );
        assert_eq!(
            amounts[1],
            BalanceAmount {
                currency: "USD".into(),
                remaining: 5.0
            }
        );
        for bad in [
            json!({"balance_infos": []}),
            json!({"balance_infos": [{"currency": "cny", "total_balance": "1"}]}),
            json!({"balance_infos": [{"total_balance": "1"}]}),
            json!({"balance_infos": [{"currency": "CNY", "total_balance": "abc"}]}),
            json!({"balance_infos": [{"currency": "CNY", "total_balance": "1"}, {"currency": "CNY", "total_balance": "2"}]}),
        ] {
            assert!(
                parse_vendor_response(&endpoint("api.deepseek.com"), &bad).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn openrouter_balance_is_credits_minus_usage_in_usd() {
        let body = json!({"data": {"total_credits": 100.5, "total_usage": 25.75}});
        let amounts = parse_vendor_response(&endpoint("openrouter.ai"), &body).unwrap();
        assert_eq!(
            amounts,
            vec![BalanceAmount {
                currency: "USD".into(),
                remaining: 74.75
            }]
        );
        assert!(parse_vendor_response(
            &endpoint("openrouter.ai"),
            &json!({"data": {"total_credits": 1, "total_usage": 2}})
        )
        .is_err());
        assert!(parse_vendor_response(
            &endpoint("openrouter.ai"),
            &json!({"data": {"total_credits": 1}})
        )
        .is_err());
    }

    #[test]
    fn siliconflow_reads_total_balance_without_identity_fields() {
        let body = json!({"code": 20000, "message": "OK", "status": true, "data": {
            "id": "userid", "name": "username", "email": "user_email_address",
            "balance": "0.88", "chargeBalance": "88.00", "totalBalance": "88.88"
        }});
        let amounts = parse_vendor_response(&endpoint("api.siliconflow.cn"), &body).unwrap();
        assert_eq!(
            amounts,
            vec![BalanceAmount {
                currency: "CNY".into(),
                remaining: 88.88
            }]
        );
        assert_eq!(
            parse_vendor_response(&endpoint("api.siliconflow.com"), &body).unwrap()[0].currency,
            "USD"
        );
        assert!(
            parse_vendor_response(&endpoint("api.siliconflow.cn"), &json!({"data": {}})).is_err()
        );
    }

    #[test]
    fn relay_value_path_is_explicit_and_bounded() {
        let body = json!({"data": {"items": [{"amount": "12.34"}], "quota": 7}});
        assert_eq!(
            parse_relay_response(&body, "data.items.0.amount", "CNY").unwrap()[0].remaining,
            12.34
        );
        assert_eq!(
            parse_relay_response(&body, "data.quota", "USD").unwrap()[0].currency,
            "USD"
        );
        assert!(parse_relay_response(&body, "data.missing", "CNY").is_err());
        assert!(parse_relay_response(&body, "data", "CNY").is_err());
        assert!(parse_relay_response(&body, "data.quota", "usd").is_err());
        for bad in [
            "",
            "data..quota",
            "data/quota",
            "$.data",
            "a.b.c.d.e.f.g.h.i",
        ] {
            assert!(!validate_value_path(bad), "{bad}");
        }
    }
}
