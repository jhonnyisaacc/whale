export function jupiterImpactPercent(raw: string, unit: "fraction" | "percent"): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error("jupiter price impact missing");
  return unit === "fraction" ? value * 100 : value;
}

export function impactPctFromUsd(spentUsd: number, boughtHuman: number, priceUsd: number): number | null {
  if (!(spentUsd > 0) || !(priceUsd > 0) || !(boughtHuman >= 0)) return null;
  const receivedUsd = boughtHuman * priceUsd;
  const raw = Math.max(0, ((spentUsd - receivedUsd) / spentUsd) * 100);
  return Math.round(raw * 1e8) / 1e8;
}

export type ZeroExPrice = {
  liquidityAvailable?: boolean;
  buyAmount?: string;
  sellAmount?: string;
  totalNetworkFee?: string | null;
  transaction?: { to?: string; data?: string; value?: string; gas?: string };
};

export function readZeroEx(body: ZeroExPrice, reference: { spentUsd: number; priceUsd: number; decimals: number } | null): {
  priceImpactPct: number | null;
  buyAmount: string;
  to: string | null;
  data: string | null;
  value: string;
} {
  if (body.liquidityAvailable === false || !body.buyAmount) {
    return { priceImpactPct: null, buyAmount: "0", to: null, data: null, value: "0" };
  }
  let impact: number | null = null;
  if (reference) {
    const human = Number(body.buyAmount) / 10 ** reference.decimals;
    impact = impactPctFromUsd(reference.spentUsd, human, reference.priceUsd);
  }
  return {
    priceImpactPct: impact,
    buyAmount: body.buyAmount,
    to: body.transaction?.to ?? null,
    data: body.transaction?.data ?? null,
    value: body.transaction?.value ?? "0",
  };
}

export type JupiterQuote = {
  outAmount?: string;
  priceImpactPct?: string;
  otherAmountThreshold?: string;
};

export function readJupiter(body: JupiterQuote, unit: "fraction" | "percent"): { priceImpactPct: number | null; buyAmount: string } {
  if (!body.outAmount || body.priceImpactPct === undefined) {
    return { priceImpactPct: null, buyAmount: body.outAmount ?? "0" };
  }
  return { priceImpactPct: jupiterImpactPercent(body.priceImpactPct, unit), buyAmount: body.outAmount };
}

export type LifiQuote = {
  estimate?: { toAmount?: string; feeCosts?: Array<{ amountUSD?: string }>; gasCosts?: Array<{ amountUSD?: string }> };
  transactionRequest?: { to?: string; data?: string; value?: string; chainId?: number };
};

export function readLifi(
  body: LifiQuote,
  reference: { spentUsd: number; priceUsd: number; decimals: number } | null,
  expectedChainId: number,
): {
  priceImpactPct: number | null;
  feeUsd: number;
  buyAmount: string;
  sameChain: boolean;
} {
  const toAmount = body.estimate?.toAmount;
  const requestChain = body.transactionRequest?.chainId;
  const sameChain = requestChain === undefined || requestChain === expectedChainId;
  if (!toAmount || !sameChain) return { priceImpactPct: null, feeUsd: 0, buyAmount: "0", sameChain };
  const fees = [...(body.estimate?.feeCosts ?? []), ...(body.estimate?.gasCosts ?? [])];
  const feeUsd = fees.reduce((sum, fee) => sum + (fee.amountUSD ? Number(fee.amountUSD) : 0), 0);
  let impact: number | null = null;
  if (reference) {
    const human = Number(toAmount) / 10 ** reference.decimals;
    impact = impactPctFromUsd(reference.spentUsd, human, reference.priceUsd);
  }
  return {
    priceImpactPct: impact,
    feeUsd: Number.isFinite(feeUsd) ? feeUsd : 0,
    buyAmount: toAmount,
    sameChain,
  };
}
