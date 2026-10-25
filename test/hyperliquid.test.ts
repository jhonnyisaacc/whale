import assert from "node:assert/strict";
import test from "node:test";
import { agentIsApproved, assertTradableAction, buildLeverage, buildOrder, cappedLimitPx, floatToWire } from "../src/hyperliquid.js";

test("order wire and leverage default to 1x, and withdraw is refused", () => {
  assert.equal(floatToWire(1), "1");
  assert.equal(floatToWire(1.5), "1.5");
  const order = buildOrder({ asset: 3, isBuy: true, limitPx: 1.25, size: 2 });
  assert.equal(order.type, "order");
  assert.equal(order.orders[0].t.limit.tif, "Ioc");
  assert.deepEqual(buildLeverage(3, 1), { type: "updateLeverage", asset: 3, isCross: false, leverage: 1 });
  assert.throws(() => assertTradableAction({ type: "withdraw3" }));
  assert.throws(() => assertTradableAction({ type: "agentSendAsset" }));
  assert.throws(() => assertTradableAction({ type: "usdSend" }));
  assert.equal(cappedLimitPx(100, true, 100), 101);
  assert.equal(cappedLimitPx(100, false, 100), 99);
  assert.equal(agentIsApproved([{ address: "0xAbC", validUntil: 5_000 }], "0xabc", 4_000), true);
  assert.equal(agentIsApproved([{ address: "0xAbC", validUntil: 5_000 }], "0xabc", 5_000), false);
  assert.equal(agentIsApproved([{ address: "0xdef" }], "0xabc"), false);
});
