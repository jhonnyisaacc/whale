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
        let local =
            trimmed.starts_with("http://localhost:") || trimmed.starts_with("http://127.0.0.1:");
        if !trimmed.starts_with("https://") && !local {
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
