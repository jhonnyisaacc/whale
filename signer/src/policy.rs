use crate::abi;
use crate::evm::{self, Call};
use crate::solana::{self, Message};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

pub struct Policy {
    evm_chains: HashSet<u64>,
    routers: BTreeMap<u64, HashSet<[u8; 20]>>,
    settlers: BTreeMap<u64, HashSet<[u8; 20]>>,
    kyber_executors: BTreeMap<u64, HashSet<[u8; 20]>>,
    evm_destinations: HashSet<[u8; 20]>,
    max_value_wei: u128,
    max_fee_wei: u128,
    allow_undecoded_router_calls: bool,
    solana_programs: HashSet<[u8; 32]>,
    solana_destinations: HashSet<[u8; 32]>,
    token_account_destinations: HashSet<[u8; 32]>,
    max_priority_lamports: u128,
    pub daily_limits: BTreeMap<String, u128>,
}

pub struct Decision {
    pub reasons: Vec<String>,
    pub spend: Vec<(String, u128)>,
}

impl Decision {
    pub fn allowed(&self) -> bool {
        self.reasons.is_empty()
    }
}

const LAMPORTS_PER_SIGNATURE: u128 = 5_000;
const MAX_TOKEN_ACCOUNT_RENT_LAMPORTS: u128 = (128 + 512) * 6_960;
const SYSTEM: &str = "11111111111111111111111111111111";
const COMPUTE_BUDGET: &str = "ComputeBudget111111111111111111111111111111";
const TOKEN: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const JUPITER: &str = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const WSOL_MINT: &str = "So11111111111111111111111111111111111111112";

// Jupiter v6 exact-in routes, from the published IDL, as the app signing policy reads them. Exact-out and newer routes
// are refused.
struct JupiterRoute {
    discriminator: [u8; 8],
    authority: usize,
    destinations: &'static [usize],
    mint: usize,
    fee: usize,
}

const JUPITER_ROUTES: [JupiterRoute; 4] = [
    JupiterRoute {
        discriminator: [0xe5, 0x17, 0xcb, 0x97, 0x7a, 0xe3, 0xad, 0x2a],
        authority: 1,
        destinations: &[3, 4],
        mint: 5,
        fee: 6,
    },
    JupiterRoute {
        discriminator: [0x96, 0x56, 0x47, 0x74, 0xa7, 0x5d, 0x0e, 0x68],
        authority: 1,
        destinations: &[3, 4],
        mint: 5,
        fee: 6,
    },
    JupiterRoute {
        discriminator: [0xc1, 0x20, 0x9b, 0x33, 0x41, 0xd6, 0x9c, 0x81],
        authority: 2,
        destinations: &[6],
        mint: 8,
        fee: 9,
    },
    JupiterRoute {
        discriminator: [0xe6, 0x79, 0x8f, 0x50, 0x77, 0x9f, 0x6a, 0xaa],
        authority: 2,
        destinations: &[6],
        mint: 8,
        fee: 9,
    },
];

fn known(text: &str) -> [u8; 32] {
    solana::key(text).expect("a built-in program id is valid base58")
}

// The swap's output must land in this wallet: its wrapped SOL account or its associated token account for the output
// mint, under Token or Token-2022. The optional second destination may be left as the Jupiter program id (unset).
fn jupiter_route(
    data: &[u8],
    account: &dyn Fn(usize) -> Option<[u8; 32]>,
    own: [u8; 32],
) -> Result<(), String> {
    let jupiter = known(JUPITER);
    let discriminator = data.get(..8).ok_or("jupiter instruction is too short")?;
    let route = JUPITER_ROUTES
        .iter()
        .find(|route| route.discriminator.as_slice() == discriminator)
        .ok_or("this Jupiter instruction is not an exact-in route")?;
    let read = |slot: usize| {
        account(slot).ok_or_else(|| {
            format!("jupiter account {slot} comes from a lookup table, so it cannot be checked")
        })
    };
    if read(route.authority)? != own {
        return Err("the Jupiter transfer authority is not this wallet".into());
    }
    if read(route.fee)? != jupiter {
        return Err("the Jupiter platform fee account is set".into());
    }
    let mint = read(route.mint)?;
    let ata = known(ASSOCIATED_TOKEN);
    let mut owned = vec![crate::pda::associated_token_address(
        &own,
        &known(WSOL_MINT),
        &known(TOKEN),
        &ata,
    )];
    for program in [TOKEN, TOKEN_2022] {
        owned.push(crate::pda::associated_token_address(
            &own,
            &mint,
            &known(program),
            &ata,
        ));
    }
    for (position, slot) in route.destinations.iter().enumerate() {
        let destination = read(*slot)?;
        if position > 0 && destination == jupiter {
            continue;
        }
        if !owned.contains(&Some(destination)) {
            return Err("the Jupiter swap pays a token account that is not this wallet's".into());
        }
    }
    Ok(())
}
const JITO_TIPS: [&str; 8] = [
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
    "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
    "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
    "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
    "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
    "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
    "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

fn text_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn amount(value: Option<&Value>, name: &str) -> Result<u128, String> {
    value
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{name} must be a decimal string"))?
        .parse()
        .map_err(|_| format!("{name} is not a whole number"))
}

fn addresses_by_chain(
    value: Option<&Value>,
    name: &str,
) -> Result<BTreeMap<u64, HashSet<[u8; 20]>>, String> {
    let mut out = BTreeMap::new();
    if let Some(map) = value.and_then(Value::as_object) {
        for (chain, list) in map {
            let id: u64 = chain
                .parse()
                .map_err(|_| format!("{name} chain {chain} is not a number"))?;
            let set = text_list(Some(list))
                .iter()
                .map(|item| evm::parse_address(item))
                .collect::<Result<HashSet<_>, _>>()?;
            out.insert(id, set);
        }
    }
    Ok(out)
}

impl Policy {
    pub fn parse(file: &Value) -> Result<Policy, String> {
        if file.get("version").and_then(Value::as_u64) != Some(1) {
            return Err("policy version must be 1".into());
        }
        let evm = file.get("evm").cloned().unwrap_or(Value::Null);
        let sol = file.get("solana").cloned().unwrap_or(Value::Null);
        let routers = addresses_by_chain(evm.get("routers"), "router")?;
        let settlers = addresses_by_chain(evm.get("settlers"), "settler")?;
        let kyber_executors = addresses_by_chain(evm.get("kyberExecutors"), "kyber executor")?;
        let mut daily_limits = BTreeMap::new();
        for section in [&evm, &sol] {
            if let Some(map) = section.get("dailyLimits").and_then(Value::as_object) {
                for (key, limit) in map {
                    let normalized = if key.contains(":0x") {
                        key.to_lowercase()
                    } else {
                        key.clone()
                    };
                    daily_limits.insert(
                        normalized,
                        amount(Some(limit), &format!("dailyLimits.{key}"))?,
                    );
                }
            }
        }
        let base = [SYSTEM, COMPUTE_BUDGET, TOKEN, TOKEN_2022, ASSOCIATED_TOKEN];
        Ok(Policy {
            evm_chains: evm
                .get("chains")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(Value::as_u64).collect())
                .unwrap_or_default(),
            routers,
            settlers,
            kyber_executors,
            evm_destinations: text_list(evm.get("destinations"))
                .iter()
                .map(|item| evm::parse_address(item))
                .collect::<Result<_, _>>()?,
            max_value_wei: if evm.get("maxValueWei").is_some() {
                amount(evm.get("maxValueWei"), "evm.maxValueWei")?
            } else {
                0
            },
            max_fee_wei: if evm.get("maxFeeWei").is_some() {
                amount(evm.get("maxFeeWei"), "evm.maxFeeWei")?
            } else {
                0
            },
            allow_undecoded_router_calls: evm
                .get("allowUndecodedRouterCalls")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            solana_programs: base
                .iter()
                .map(|item| item.to_string())
                .chain(text_list(sol.get("programs")))
                .map(|item| solana::key(&item))
                .collect::<Result<_, _>>()?,
            solana_destinations: text_list(sol.get("destinations"))
                .iter()
                .map(|item| solana::key(item))
                .collect::<Result<_, _>>()?,
            token_account_destinations: text_list(sol.get("tokenAccountDestinations"))
                .iter()
                .map(|item| solana::key(item))
                .collect::<Result<_, _>>()?,
            max_priority_lamports: if sol.get("maxPriorityLamports").is_some() {
                amount(sol.get("maxPriorityLamports"), "solana.maxPriorityLamports")?
            } else {
                0
            },
            daily_limits,
        })
    }

    fn spend(&self, decision: &mut Decision, key: String, value: u128) {
        if value == 0 {
            return;
        }
        match self.daily_limits.get(&key) {
            None => decision
                .reasons
                .push(format!("no daily limit is set for {key}")),
            Some(limit) if value > *limit => decision.reasons.push(format!(
                "{value} of {key} is above its whole {limit} daily limit"
            )),
            Some(_) => {}
        }
        decision.spend.push((key, value));
    }

    pub fn check_evm(&self, tx: &evm::Tx, own: [u8; 20]) -> Decision {
        let mut decision = Decision {
            reasons: vec![],
            spend: vec![],
        };
        let chain = tx.chain_id;
        if !self.evm_chains.contains(&chain) {
            decision
                .reasons
                .push(format!("chain {chain} is not in the policy"));
            return decision;
        }
        let routers = self.routers.get(&chain).cloned().unwrap_or_default();
        let key = |token: [u8; 20]| format!("{chain}:0x{}", hex::encode(token));
        let native = format!("{chain}:native");
        if tx.max_priority_fee > tx.max_fee {
            decision
                .reasons
                .push("maxPriorityFeePerGas is above maxFeePerGas".into());
        }
        match u128::from(tx.gas).checked_mul(tx.max_fee) {
            Some(fee) if fee <= self.max_fee_wei => self.spend(&mut decision, native.clone(), fee),
            fee => decision.reasons.push(format!(
                "gas times maxFeePerGas, {}, is above the {} wei fee cap",
                fee.map_or("more than 2^128".to_string(), |fee| fee.to_string()),
                self.max_fee_wei
            )),
        }
        let contract_value = |decision: &mut Decision| {
            if tx.value > self.max_value_wei {
                decision.reasons.push(format!(
                    "native value {} is above the {} wei cap",
                    tx.value, self.max_value_wei
                ));
            }
        };
        match evm::classify(tx) {
            Call::Native => {
                if !self.evm_destinations.contains(&tx.to) {
                    decision
                        .reasons
                        .push("a native transfer may only pay a listed destination".into());
                }
                self.spend(&mut decision, native, tx.value);
            }
            Call::Erc20Transfer { token, to, amount } => {
                if tx.value != 0 {
                    decision
                        .reasons
                        .push("a token transfer must send no native value".into());
                }
                if !self.evm_destinations.contains(&to) {
                    decision
                        .reasons
                        .push("a token transfer may only pay a listed destination".into());
                }
                self.spend(&mut decision, key(token), amount);
            }
            Call::Erc20Approve {
                token,
                spender,
                amount,
            } => {
                if tx.value != 0 || !routers.contains(&spender) {
                    decision
                        .reasons
                        .push("an approval may only name a listed router and send no value".into());
                }
                if self.settlers.values().any(|set| set.contains(&spender)) {
                    decision.reasons.push(format!(
                        "an approval may not name 0x{}, a pinned Settler, whose actions can spend it",
                        hex::encode(spender)
                    ));
                }
                self.spend(&mut decision, key(token), amount);
            }
            Call::Swap { router, terms } => {
                if !routers.contains(&router) {
                    decision
                        .reasons
                        .push("the swap router is not listed for this chain".into());
                }
                let listed = |table: &BTreeMap<u64, HashSet<[u8; 20]>>, address: &[u8; 20]| {
                    table.get(&chain).is_some_and(|set| set.contains(address))
                };
                match &terms.route {
                    abi::Route::ZeroEx { exec } => {
                        let target = exec.as_ref().map_or(router, |exec| exec.target);
                        if exec
                            .as_ref()
                            .is_some_and(|exec| exec.operator != exec.target)
                        {
                            decision
                                .reasons
                                .push("the 0x exec operator is not its target".into());
                        }
                        if !listed(&self.settlers, &target) {
                            decision.reasons.push(format!(
                                "the 0x target 0x{} is not a pinned Settler",
                                hex::encode(target)
                            ));
                        }
                    }
                    abi::Route::Kyber { parties } => {
                        for party in parties {
                            if !listed(&self.kyber_executors, party) {
                                decision.reasons.push(format!(
                                    "the kyberswap swap hands the sold tokens or the call to 0x{}, which is not a listed Kyber executor",
                                    hex::encode(party)
                                ));
                            }
                        }
                    }
                }
                if terms.recipient != own {
                    decision.reasons.push(format!(
                        "the {} swap pays 0x{}, not this wallet",
                        terms.route.provider(),
                        hex::encode(terms.recipient)
                    ));
                }
                contract_value(&mut decision);
                match terms.sell {
                    Some((token, amount)) if token != [0u8; 20] && token != [0xee; 20] => {
                        self.spend(&mut decision, key(token), amount)
                    }
                    Some(_) => {}
                    None if tx.value == 0 => decision
                        .reasons
                        .push("the sold amount is not readable from this call".into()),
                    None => {}
                }
                self.spend(&mut decision, native, tx.value);
            }
            Call::Unknown { to, selector } => {
                if !(self.allow_undecoded_router_calls && routers.contains(&to)) {
                    decision.reasons.push(format!(
                        "call 0x{} to 0x{} is not one the signer can read",
                        hex::encode(selector),
                        hex::encode(to)
                    ));
                }
                contract_value(&mut decision);
                self.spend(&mut decision, native, tx.value);
            }
        }
        decision
    }

    pub fn check_solana(&self, message: &Message, own: [u8; 32]) -> Decision {
        let mut decision = Decision {
            reasons: vec![],
            spend: vec![],
        };
        if message.required_signatures != 1 || message.keys.first() != Some(&own) {
            decision
                .reasons
                .push("this wallet must be the only signer and the fee payer".into());
            return decision;
        }
        let tips: HashSet<[u8; 32]> = JITO_TIPS
            .iter()
            .filter_map(|item| solana::key(item).ok())
            .collect();
        let known = |text: &str| solana::key(text).expect("a built-in key is valid base58");
        let wrapped_sol = crate::pda::associated_token_address(
            &own,
            &known(WSOL_MINT),
            &known(TOKEN),
            &known(ASSOCIATED_TOKEN),
        );
        let static_key = |index: usize| message.keys.get(index).copied();
        let (mut unit_limit, mut unit_price, mut tipped) = (1_400_000u128, 0u128, 0u128);
        for (position, instruction) in message.instructions.iter().enumerate() {
            let Some(program) = static_key(instruction.program) else {
                decision.reasons.push(format!(
                    "instruction {position} names its program through a lookup table"
                ));
                continue;
            };
            if !self.solana_programs.contains(&program) {
                decision.reasons.push(format!(
                    "instruction {position} calls {}, which the policy does not list",
                    bs58::encode(program).into_string()
                ));
                continue;
            }
            let account = |slot: usize| {
                instruction
                    .accounts
                    .get(slot)
                    .and_then(|index| static_key(*index))
            };
            let data = &instruction.data;
            let refuse = |decision: &mut Decision, what: &str| {
                decision
                    .reasons
                    .push(format!("instruction {position}: {what}"))
            };
            let program_name = bs58::encode(program).into_string();
            if program_name == SYSTEM {
                let lamports = data.get(4..12).map(|bytes| {
                    u128::from(u64::from_le_bytes(bytes.try_into().expect("8 bytes")))
                });
                match (data.get(..4), account(0), account(1), lamports) {
                    (Some([2, 0, 0, 0]), Some(from), Some(to), Some(value))
                        if from == own && data.len() == 12 =>
                    {
                        if tips.contains(&to) {
                            tipped = tipped.saturating_add(value);
                        } else if to == own || Some(to) == wrapped_sol {
                        } else if self.solana_destinations.contains(&to) {
                            self.spend(&mut decision, "solana:native".into(), value);
                        } else {
                            refuse(
                                &mut decision,
                                "a SOL transfer may only pay a listed destination or a Jito tip account",
                            );
                        }
                    }
                    (Some([2, 0, 0, 0]), Some(_), None, _) => refuse(
                        &mut decision,
                        "the transfer destination comes from a lookup table, so it cannot be checked",
                    ),
                    _ => refuse(
                        &mut decision,
                        "only a SOL transfer from this wallet is allowed on the System program",
                    ),
                }
            } else if program_name == COMPUTE_BUDGET {
                match data.first() {
                    Some(2) if data.len() == 5 => {
                        unit_limit =
                            u128::from(u32::from_le_bytes(data[1..5].try_into().expect("4 bytes")))
                    }
                    Some(3) if data.len() == 9 => {
                        unit_price =
                            u128::from(u64::from_le_bytes(data[1..9].try_into().expect("8 bytes")))
                    }
                    Some(1) | Some(4) => {}
                    _ => refuse(&mut decision, "unknown compute budget instruction"),
                }
            } else if program_name == TOKEN || program_name == TOKEN_2022 {
                match (data.first(), data.len()) {
                    (Some(17), 1) => {}
                    (Some(9), 1) if account(1) == Some(own) => {}
                    (Some(18), 33) if data[1..33] == own => {}
                    (Some(12), 10) => match (account(1), account(2)) {
                        (Some(mint), Some(destination))
                            if self.token_account_destinations.contains(&destination) =>
                        {
                            let value = u128::from(u64::from_le_bytes(
                                data[1..9].try_into().expect("8 bytes"),
                            ));
                            self.spend(
                                &mut decision,
                                format!("solana:{}", bs58::encode(mint).into_string()),
                                value,
                            );
                        }
                        _ => refuse(
                            &mut decision,
                            "a token transfer may only pay a listed token account",
                        ),
                    },
                    _ => refuse(&mut decision, "this token instruction is not allowed"),
                }
            } else if program_name == ASSOCIATED_TOKEN {
                let owner_ok = account(2)
                    .is_some_and(|owner| owner == own || self.solana_destinations.contains(&owner));
                if !(matches!(data.as_slice(), [] | [0] | [1])
                    && account(0) == Some(own)
                    && owner_ok)
                {
                    refuse(
                        &mut decision,
                        "an associated token account must be funded by this wallet for itself or a listed destination",
                    );
                } else {
                    self.spend(
                        &mut decision,
                        "solana:native".into(),
                        MAX_TOKEN_ACCOUNT_RENT_LAMPORTS,
                    );
                }
            } else if program_name == JUPITER {
                if let Err(reason) = jupiter_route(data, &account, own) {
                    refuse(&mut decision, &reason);
                }
            } else {
                refuse(
                    &mut decision,
                    &format!(
                        "the signer has no instruction rule for {program_name}, so it cannot check it"
                    ),
                );
            }
        }
        let priority = unit_price
            .saturating_mul(unit_limit)
            .div_ceil(1_000_000)
            .saturating_add(tipped);
        if priority > self.max_priority_lamports {
            decision.reasons.push(format!(
                "priority fees and tips of {priority} lamports are above the {} cap",
                self.max_priority_lamports
            ));
        }
        self.spend(
            &mut decision,
            "solana:native".into(),
            LAMPORTS_PER_SIGNATURE.saturating_add(priority),
        );
        decision
    }
}
