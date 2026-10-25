import { PublicKey } from "@solana/web3.js";
import { DEFAULT_MAX_VALUE_WEI, JITO_TIP_ACCOUNTS, SOLANA_BASE_PROGRAMS, evmChainIds, wrappedSolAccount } from "../signing-policy.js";

export type TurnkeyPolicyInput = {
  userId: string;
  wallets: { evm: string; solana: string; hyperliquid: string | null };
  solanaAddress: string;
  routers: Readonly<Record<number, readonly string[]>>;
  selectors?: readonly string[];
  maxValueWei: bigint;
  solanaPrograms?: readonly string[];
};

const TURNKEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_ID = "00000000-0000-0000-0000-000000000000";

function turnkeyId(value: string, name: string): string {
  if (!TURNKEY_ID.test(value) || value === NIL_ID) throw new Error(`turnkey ${name} is empty or has a placeholder`);
  return value;
}

export function turnkeyPolicyDocument(input: TurnkeyPolicyInput): unknown[] {
  const userId = turnkeyId(input.userId, "user id");
  const wallets = {
    evm: turnkeyId(input.wallets.evm, "evm wallet id"),
    solana: turnkeyId(input.wallets.solana, "solana wallet id"),
    hyperliquid: input.wallets.hyperliquid === null ? null : turnkeyId(input.wallets.hyperliquid, "hyperliquid wallet id"),
  };
  const routers: Record<number, string[]> = {};
  for (const id of evmChainIds()) {
    const list = [...new Set((input.routers[id] ?? []).map((item) => item.toLowerCase()))];
    if (list.some((item) => !/^0x[0-9a-f]{40}$/.test(item))) throw new Error("router address is invalid");
    if (list.length > 0) routers[id] = list;
  }
  const selectors = (input.selectors ?? []).map((item) => item.toLowerCase());
  if (selectors.some((item) => !/^0x[0-9a-f]{8}$/.test(item))) throw new Error("router selector is invalid");
  if (input.maxValueWei < 0n) throw new Error("max native value is negative");
  const solanaPrograms = [...new Set([...SOLANA_BASE_PROGRAMS, ...(input.solanaPrograms ?? [])])];
  for (const program of solanaPrograms) new PublicKey(program);
  return renderTurnkeyPolicy({
    userId,
    wallets,
    solanaAddress: new PublicKey(input.solanaAddress).toBase58(),
    wrappedSol: wrappedSolAccount(input.solanaAddress),
    routers,
    selectors,
    maxValueWei: input.maxValueWei,
    solanaPrograms,
  });
}

export function turnkeyPolicyTemplate(): unknown[] {
  return renderTurnkeyPolicy({
    userId: "<TURNKEY_API_USER_ID>",
    wallets: { evm: "<TURNKEY_EVM_WALLET_ID>", solana: "<TURNKEY_SOLANA_WALLET_ID>", hyperliquid: "<TURNKEY_HYPERLIQUID_WALLET_ID>" },
    solanaAddress: "<TURNKEY_SOLANA_ADDRESS>",
    wrappedSol: "<TURNKEY_SOLANA_WSOL_ACCOUNT>",
    routers: {},
    selectors: [],
    maxValueWei: DEFAULT_MAX_VALUE_WEI,
  });
}

function renderTurnkeyPolicy(input: {
  userId: string;
  wallets: { evm: string; solana: string; hyperliquid: string | null };
  solanaAddress: string;
  wrappedSol: string;
  routers: Readonly<Record<number, readonly string[]>>;
  selectors: readonly string[];
  maxValueWei: bigint;
  solanaPrograms?: readonly string[];
}): unknown[] {
  const clauses = Object.entries(input.routers).map(([id, list]) => `(eth.tx.chain_id == ${id} && (${list.map((item) => `eth.tx.to == '${item}'`).join(" || ")}))`);
  const evmMatch = clauses.length === 0 ? "eth.tx.chain_id == 0" : clauses.join(" || ");
  const selector = input.selectors.length === 0 ? "" : ` && (${input.selectors.map((item) => `eth.tx.data[0..10] == '${item}'`).join(" || ")})`;
  const programs = [...new Set([...SOLANA_BASE_PROGRAMS, ...(input.solanaPrograms ?? [])])].map((id) => `p == '${id}'`).join(" || ");
  const recipients = [input.solanaAddress, input.wrappedSol, ...JITO_TIP_ACCOUNTS].map((item) => `t.to == '${item}'`).join(" || ");
  const consensus = `approvers.any(user, user.id == '${input.userId}')`;
  const policies = [
    {
      policyName: "EVM swaps on allowlisted chains and routers",
      notes: `Scoped to the EVM wallet. Routers, selectors, and the ${input.maxValueWei} wei native cap come from turnkeyPolicyDocument. An empty router map matches no chain. Withdrawals and token approvals are a root-quorum ceremony, not this policy.`,
      effect: "EFFECT_ALLOW",
      consensus,
      condition: `activity.action == 'SIGN' && wallet.id == '${input.wallets.evm}' && (${evmMatch}) && eth.tx.value <= ${input.maxValueWei}${selector}`,
    },
    {
      policyName: "Solana swaps through Jupiter and the base programs",
      notes: "Scoped to the Solana wallet. Native transfers may pay only the hot wallet, its wrapped SOL account, or a Jito tip account. A transfer to a lookup-table address reads as ADDRESS_TABLE_LOOKUP and is denied. Top-level SPL transfers are denied, so SPL recovery is a root-quorum ceremony. Add each DEX program id Jupiter puts in the transaction, or Turnkey denies the sign.",
      effect: "EFFECT_ALLOW",
      consensus,
      condition: `activity.action == 'SIGN' && wallet.id == '${input.wallets.solana}' && solana.tx.program_keys.all(p, ${programs}) && solana.tx.transfers.all(t, ${recipients}) && solana.tx.spl_transfers.count() == 0`,
    },
  ];
  if (input.wallets.hyperliquid === null) return policies;
  return [
    ...policies,
    {
      policyName: "Hyperliquid agent typed data",
      notes: "Scoped to the agent wallet. The L1 action is hashed into connectionId before EIP-712, so this policy can pin the Agent domain and cannot see withdraw3. The app rejects non-tradable actions before it submits.",
      effect: "EFFECT_ALLOW",
      consensus,
      condition: `activity.action == 'SIGN' && wallet.id == '${input.wallets.hyperliquid}' && eth.eip_712.primary_type == 'Agent' && eth.eip_712.domain.name == 'Exchange' && eth.eip_712.domain.version == '1' && eth.eip_712.domain.chain_id == 1337 && eth.eip_712.message['source'] == 'a'`,
    },
  ];
}
