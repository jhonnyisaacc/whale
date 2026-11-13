use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct Ledger {
    day: String,
    spent: BTreeMap<String, u128>,
    _lock: fs::File,
}

pub fn utc_day(seconds: u64) -> String {
    let days = (seconds / 86_400) as i64 + 719_468;
    let era = days.div_euclid(146_097);
    let doe = days.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

pub fn today() -> String {
    utc_day(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or(0),
    )
}

impl Ledger {
    pub fn load(path: &Path, day: &str) -> Result<Ledger, String> {
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(path.with_extension("lock"))
            .map_err(|error| format!("cannot open the ledger lock: {error}"))?;
        lock.lock()
            .map_err(|error| format!("cannot lock the ledger: {error}"))?;
        let empty = |lock| Ledger {
            day: day.to_owned(),
            spent: BTreeMap::new(),
            _lock: lock,
        };
        if !path.exists() {
            return Ok(empty(lock));
        }
        let text =
            fs::read_to_string(path).map_err(|error| format!("cannot read the ledger: {error}"))?;
        let value: Value = serde_json::from_str(&text).map_err(|_| "the ledger is not JSON")?;
        if value.get("day").and_then(Value::as_str) != Some(day) {
            return Ok(empty(lock));
        }
        let mut spent = BTreeMap::new();
        for (key, amount) in value
            .get("spent")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
        {
            spent.insert(
                key,
                amount
                    .as_str()
                    .and_then(|text| text.parse().ok())
                    .ok_or("the ledger holds a bad amount")?,
            );
        }
        Ok(Ledger {
            day: day.to_owned(),
            spent,
            _lock: lock,
        })
    }

    pub fn over_limit(
        &self,
        spend: &[(String, u128)],
        limits: &BTreeMap<String, u128>,
    ) -> Vec<String> {
        let mut totals = self.spent.clone();
        for (key, value) in spend {
            *totals.entry(key.clone()).or_insert(0) += value;
        }
        spend
            .iter()
            .filter_map(|(key, _)| {
                let total = totals.get(key).copied().unwrap_or(0);
                let limit = limits.get(key).copied().unwrap_or(0);
                (total > limit).then(|| {
                    format!("today's total for {key} would be {total}, above the {limit} limit")
                })
            })
            .collect()
    }

    pub fn commit(&mut self, path: &Path, spend: &[(String, u128)]) -> Result<(), String> {
        for (key, value) in spend {
            *self.spent.entry(key.clone()).or_insert(0) += value;
        }
        let spent: Map<String, Value> = self
            .spent
            .iter()
            .map(|(key, value)| (key.clone(), Value::String(value.to_string())))
            .collect();
        let temporary = path.with_extension("tmp");
        fs::write(
            &temporary,
            json!({ "day": self.day, "spent": spent }).to_string(),
        )
        .map_err(|error| format!("cannot write the ledger: {error}"))?;
        fs::rename(&temporary, path).map_err(|error| format!("cannot replace the ledger: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::utc_day;

    #[test]
    fn utc_days_match_known_dates() {
        assert_eq!(utc_day(0), "1970-01-01");
        assert_eq!(utc_day(951_782_400), "2000-02-29");
        assert_eq!(utc_day(1_793_664_000), "2026-11-03");
        assert_eq!(utc_day(1_793_750_399), "2026-11-03");
    }
}
