import type { AppConfig } from "../config.js";
import type { TxRecord } from "../domain.js";
import { BroadcastError } from "../executor.js";
import { buildWithdraw, isHyperliquidMainnet, nextHyperliquidNonce, readExchangeResponse } from "../hyperliquid.js";
import type { TransactionSigner } from "../managed-signer.js";
import { redactError } from "../redact.js";
import { readVendorText, vendorResponse } from "../vendor-fetch.js";

export type WithdrawReservations = {
  reserve(key: string, scope: string, amount: number, day: string, cap: number): Promise<"reserved" | "exists" | "cap">;
  commit(key: string): Promise<void>;
  release(key: string): Promise<void>;
};

export const HYPERCORE_WITHDRAW_SCOPE = "hypercore:usdc";

export async function withdrawHypercore(input: {
  config: AppConfig;
  signer: TransactionSigner;
  to: string;
  amount: number;
  key: string;
  day: string;
  journal: WithdrawReservations;
  fetchImpl?: typeof fetch;
  now?: () => number;
  secrets?: readonly string[];
}): Promise<TxRecord> {
  const { config, signer, journal, key } = input;
  if (!signer.signHyperliquidWithdraw) throw new Error("hypercore: this signer cannot sign withdrawals");
  const action = buildWithdraw({
    destination: input.to,
    amountUsd: input.amount,
    time: nextHyperliquidNonce(input.now?.()),
    isMainnet: isHyperliquidMainnet(config.hyperliquidUrl),
  });
  const reserved = await journal.reserve(key, HYPERCORE_WITHDRAW_SCOPE, input.amount, input.day, config.maxWithdrawDailyAmount);
  if (reserved === "cap") throw new Error(`hypercore: daily withdraw cap ${config.maxWithdrawDailyAmount} USD`);
  if (reserved === "exists") throw new Error("hypercore: this withdrawal is already reserved");
  let signature;
  try {
    signature = await signer.signHyperliquidWithdraw(action);
  } catch (error) {
    await journal.release(key);
    throw error;
  }
  const record: TxRecord = { chainKey: "hypercore", txHash: `hl:${action.time}`, from: signer.evmAddress() ?? "", to: action.destination, value: action.amount, outcome: "pending" };
  let body: unknown;
  try {
    const response = await vendorResponse(
      input.fetchImpl ?? fetch,
      `${config.hyperliquidUrl.replace(/\/$/, "")}/exchange`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, nonce: action.time, signature }) },
      false,
    );
    if (!response.ok) throw new Error(`hyperliquid exchange returned ${response.status}`);
    body = JSON.parse(await readVendorText(response)) as unknown;
  } catch (error) {
    throw new BroadcastError(`hypercore: ${redactError(error, input.secrets ?? [])}`, true);
  }
  const parsed = readExchangeResponse(body);
  if (parsed.status === "err") {
    await journal.release(key);
    throw new Error(`hypercore: hyperliquid rejected the withdrawal: ${parsed.error}`);
  }
  await journal.commit(key);
  return { ...record, outcome: "landed" };
}
