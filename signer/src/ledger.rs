use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct Ledger {
    day: String,
    spent: BTreeMap<String, u128>,
    jobs: BTreeMap<String, String>,
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

fn add(
    spent: &BTreeMap<String, u128>,
    spend: &[(String, u128)],
) -> Result<BTreeMap<String, u128>, String> {
    let mut totals = spent.clone();
    for (key, value) in spend {
        let total = totals.entry(key.clone()).or_insert(0);
        *total = total
            .checked_add(*value)
            .ok_or_else(|| format!("today's total for {key} would pass 2^128"))?;
    }
    Ok(totals)
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    let directory = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    fs::File::open(directory)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("cannot flush the ledger directory: {error}"))
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), String> {
    Ok(())
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
            jobs: BTreeMap::new(),
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
        let mut jobs = BTreeMap::new();
        for (job, work) in value
            .get("jobs")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
        {
            jobs.insert(
                job,
                work.as_str()
                    .ok_or("the ledger holds a bad job entry")?
                    .to_owned(),
            );
        }
        Ok(Ledger {
            day: day.to_owned(),
            spent,
            jobs,
            _lock: lock,
        })
    }

    pub fn charged_work(&self, job: &str) -> Option<&str> {
        self.jobs.get(job).map(String::as_str)
    }

    pub fn over_limit(
        &self,
        spend: &[(String, u128)],
        limits: &BTreeMap<String, u128>,
    ) -> Vec<String> {
        let totals = match add(&self.spent, spend) {
            Ok(totals) => totals,
            Err(reason) => return vec![reason],
        };
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

    pub fn commit(
        &mut self,
        path: &Path,
        spend: &[(String, u128)],
        job: Option<(&str, &str)>,
    ) -> Result<(), String> {
        self.spent = add(&self.spent, spend)?;
        if let Some((job, work)) = job {
            self.jobs.insert(job.to_owned(), work.to_owned());
        }
        let spent: Map<String, Value> = self
            .spent
            .iter()
            .map(|(key, value)| (key.clone(), Value::String(value.to_string())))
            .collect();
        let charged: Map<String, Value> = self
            .jobs
            .iter()
            .map(|(job, work)| (job.clone(), Value::String(work.clone())))
            .collect();
        let temporary = path.with_extension("tmp");
        let mut file = fs::File::create(&temporary)
            .map_err(|error| format!("cannot write the ledger: {error}"))?;
        file.write_all(
            json!({ "day": self.day, "spent": spent, "jobs": charged })
                .to_string()
                .as_bytes(),
        )
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("cannot write the ledger: {error}"))?;
        fs::rename(&temporary, path)
            .map_err(|error| format!("cannot replace the ledger: {error}"))?;
        sync_directory(path)
    }
}

#[cfg(test)]
mod tests {
    use super::{Ledger, utc_day};
    use std::collections::BTreeMap;

    #[test]
    fn a_spend_that_would_wrap_the_day_is_refused_and_never_written() {
        let path = std::env::temp_dir().join(format!(
            "whale-signer-{}-ledger-wrap.json",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let key = "8453:0xtoken".to_string();
        let limits = BTreeMap::from([(key.clone(), 10_000_000u128)]);
        let mut ledger = Ledger::load(&path, "2026-11-03").expect("ledger");
        ledger
            .commit(&path, &[(key.clone(), 3_000_000)], None)
            .expect("commit");
        let wrap = [(key.clone(), u128::MAX - 2_999_999)];
        assert_eq!(
            ledger.over_limit(&wrap, &limits),
            ["today's total for 8453:0xtoken would pass 2^128"]
        );
        assert!(ledger.commit(&path, &wrap, None).is_err());
        drop(ledger);
        let ledger = Ledger::load(&path, "2026-11-03").expect("ledger");
        assert_eq!(
            ledger.over_limit(&[(key.clone(), 7_000_001)], &limits),
            ["today's total for 8453:0xtoken would be 10000001, above the 10000000 limit"]
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn utc_days_match_known_dates() {
        assert_eq!(utc_day(0), "1970-01-01");
        assert_eq!(utc_day(951_782_400), "2000-02-29");
        assert_eq!(utc_day(1_793_664_000), "2026-11-03");
        assert_eq!(utc_day(1_793_750_399), "2026-11-03");
    }
}
