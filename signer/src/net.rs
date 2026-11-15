use serde_json::{Value, json};
use std::time::Duration;

pub struct Gateway {
    agent: ureq::Agent,
    base: String,
}

pub fn registration_message(wallet: &str, code: &str) -> String {
    format!("Whale signer registration\nwallet:{wallet}\ncode:{code}")
}

impl Gateway {
    pub fn new(base: &str) -> Result<Gateway, String> {
        let trimmed = base.trim_end_matches('/');
        let uri = trimmed
            .parse::<ureq::http::Uri>()
            .map_err(|_| "the gateway URL is not a valid URI")?;
        if uri
            .authority()
            .is_some_and(|authority| authority.as_str().contains('@'))
        {
            return Err("the gateway URL must not contain userinfo".into());
        }
        let scheme = uri.scheme_str().unwrap_or_default();
        let host = uri.host().unwrap_or_default();
        if host.is_empty() {
            return Err("the gateway URL must include a host".into());
        }
        let local = scheme == "http"
            && matches!(host, "localhost" | "127.0.0.1")
            && uri.port_u16().is_some();
        if scheme != "https" && !local {
            return Err("the gateway URL must be https (http only for localhost)".into());
        }
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(40)))
            .http_status_as_error(false)
            .build()
            .into();
        Ok(Gateway {
            agent,
            base: trimmed.to_owned(),
        })
    }

    fn post(&self, path: &str, token: Option<&str>, body: &Value) -> Result<(u16, String), String> {
        let mut request = self
            .agent
            .post(format!("{}{path}", self.base))
            .header("content-type", "application/json");
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let mut response = request
            .send(body.to_string())
            .map_err(|error| format!("cannot reach the gateway: {error}"))?;
        let status = response.status().as_u16();
        let text = response.body_mut().read_to_string().unwrap_or_default();
        Ok((status, text))
    }

    pub fn register(&self, body: &Value) -> Result<Value, String> {
        let (status, text) = self.post("/signer/v1/register", None, body)?;
        if status != 201 {
            return Err(format!(
                "the gateway refused the registration ({status}): {text}"
            ));
        }
        serde_json::from_str(&text)
            .map_err(|_| "the gateway answered with something that is not JSON".into())
    }

    pub fn next_job(&self, token: &str, wait_seconds: u64) -> Result<Option<Value>, String> {
        let mut response = self
            .agent
            .get(format!("{}/signer/v1/jobs?wait={wait_seconds}", self.base))
            .header("authorization", format!("Bearer {token}"))
            .call()
            .map_err(|error| format!("cannot reach the gateway: {error}"))?;
        match response.status().as_u16() {
            204 => Ok(None),
            200 => serde_json::from_str(
                &response
                    .body_mut()
                    .read_to_string()
                    .map_err(|error| error.to_string())?,
            )
            .map(Some)
            .map_err(|_| "a job is not JSON".into()),
            401 => Err("the gateway refused this signer's token".into()),
            status => Err(format!("the gateway answered {status}")),
        }
    }

    pub fn answer(&self, token: &str, job_id: &str, outcome: &Value) -> Result<(), String> {
        let body = if outcome["decision"] == "signed" {
            json!({ "decision": "signed", "result": outcome["result"] })
        } else {
            json!({ "decision": "refused", "reasons": outcome["reasons"] })
        };
        let (status, text) = self.post(
            &format!("/signer/v1/jobs/{job_id}/result"),
            Some(token),
            &body,
        )?;
        if status == 204 {
            Ok(())
        } else {
            Err(format!(
                "the gateway did not take the answer ({status}): {text}"
            ))
        }
    }
}

pub fn job_for_signer(job: &Value) -> Value {
    let mut merged = job
        .get("payload")
        .cloned()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    merged["id"] = job["id"].clone();
    merged["kind"] = job["kind"].clone();
    merged
}

#[cfg(test)]
mod tests {
    use super::Gateway;

    #[test]
    fn gateway_urls_require_a_real_https_or_loopback_authority() {
        for accepted in [
            "https://gateway.example",
            "http://localhost:8080",
            "http://127.0.0.1:8080",
        ] {
            assert!(Gateway::new(accepted).is_ok(), "accepted {accepted}");
        }
        for refused in [
            "http://example.invalid",
            "http://localhost:@example.invalid",
            "http://localhost:80@example.invalid",
            "http://127.0.0.1:@example.invalid",
            "http://127.0.0.1:80@example.invalid",
            "https://owner@example.invalid",
            "https://",
            "https:///path",
            "http://localhost",
        ] {
            assert!(Gateway::new(refused).is_err(), "refused {refused}");
        }
    }
}
