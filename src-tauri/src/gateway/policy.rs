//! Which upstream addresses the gateway may connect to (U-88): public
//! addresses over HTTPS; loopback over HTTP or HTTPS; and a host whose every
//! address is a proxy fake-ip (198.18.0.0/15) only over HTTPS, where the
//! certificate still has to match the host name.

use std::net::{IpAddr, SocketAddr};

use reqwest::Url;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Upstream {
    pub addr: SocketAddr,
    pub fake_ip: bool,
}

fn is_fake_ip(address: IpAddr) -> bool {
    matches!(address, IpAddr::V4(v4) if { let [a, b, _, _] = v4.octets(); a == 198 && (b == 18 || b == 19) })
}

fn is_public(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let [a, b, c, _] = address.octets();
            !(a == 0
                || a == 10
                || a == 127
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 0 && (c == 0 || c == 2))
                || (a == 192 && b == 168)
                || (a == 198 && (b == 18 || b == 19))
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113)
                || a >= 224)
        }
        IpAddr::V6(address) => {
            let segments = address.segments();
            // Global unicast only (2000::/3), minus documentation 2001:db8::/32.
            (segments[0] & 0xe000) == 0x2000 && !(segments[0] == 0x2001 && segments[1] == 0x0db8)
        }
    }
}

pub fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

pub fn classify(url: &Url, addresses: &[SocketAddr]) -> Result<Upstream, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "接口地址缺少主机名。".to_string())?;
    let first = *addresses
        .first()
        .ok_or_else(|| "接口地址的域名没有解析到任何地址。".to_string())?;
    let https = url.scheme() == "https";
    if is_loopback_host(host) {
        if addresses.iter().all(|addr| addr.ip().is_loopback()) {
            return Ok(Upstream {
                addr: first,
                fake_ip: false,
            });
        }
        return Err("本机地址解析到了非本机网络，已拒绝。".to_string());
    }
    if !https {
        return Err("远程接口必须使用 HTTPS。".to_string());
    }
    if addresses.iter().all(|addr| is_public(addr.ip())) {
        return Ok(Upstream {
            addr: first,
            fake_ip: false,
        });
    }
    if addresses.iter().all(|addr| is_fake_ip(addr.ip())) {
        return Ok(Upstream {
            addr: first,
            fake_ip: true,
        });
    }
    Err("接口地址解析到了内网或保留网络，已拒绝。".to_string())
}

pub async fn resolve(url: &Url) -> Result<Upstream, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "接口地址缺少主机名。".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "接口地址缺少端口。".to_string())?;
    let lookup = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    let addresses: Vec<SocketAddr> = tokio::net::lookup_host((lookup.as_str(), port))
        .await
        .map_err(|error| format!("解析接口地址失败：{error}"))?
        .collect();
    classify(url, &addresses)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addrs(list: &[&str]) -> Vec<SocketAddr> {
        list.iter()
            .map(|ip| SocketAddr::new(ip.parse().unwrap(), 443))
            .collect()
    }

    #[test]
    fn public_https_is_allowed() {
        let url = Url::parse("https://api.openai.com/v1").unwrap();
        assert!(!classify(&url, &addrs(&["104.18.6.192"])).unwrap().fake_ip);
    }

    #[test]
    fn fake_ip_needs_https_and_every_address_in_range() {
        let url = Url::parse("https://gateway.example.com/v1").unwrap();
        assert!(classify(&url, &addrs(&["198.18.5.223"])).unwrap().fake_ip);
        assert!(classify(&url, &addrs(&["198.18.5.223", "10.0.0.1"])).is_err());
        let plain = Url::parse("http://gateway.example.com/v1").unwrap();
        assert!(classify(&plain, &addrs(&["198.18.5.223"])).is_err());
    }

    #[test]
    fn private_and_reserved_networks_are_rejected() {
        let url = Url::parse("https://relay.example.com/v1").unwrap();
        for ip in [
            "10.1.2.3",
            "192.168.1.5",
            "172.20.0.1",
            "169.254.1.1",
            "100.64.0.1",
            "127.0.0.1",
            "fd00::1",
            "::1",
        ] {
            assert!(
                classify(&url, &addrs(&[ip])).is_err(),
                "{ip} should be rejected"
            );
        }
    }

    #[test]
    fn loopback_allows_http_but_only_to_loopback() {
        let url = Url::parse("http://127.0.0.1:11434/v1").unwrap();
        assert!(classify(&url, &addrs(&["127.0.0.1"])).is_ok());
        let named = Url::parse("http://localhost:11434/v1").unwrap();
        assert!(classify(&named, &addrs(&["192.168.1.5"])).is_err());
    }

    #[test]
    fn remote_http_is_rejected() {
        let url = Url::parse("http://api.example.com/v1").unwrap();
        assert!(classify(&url, &addrs(&["104.18.6.192"])).is_err());
    }
}
