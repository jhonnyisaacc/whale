import { api } from "./api.js";
import { getAssertion, type RequestOptions } from "./webauthn.js";

// The gateway binds the challenge to this exact action, so the object here must be the one the next request carries.
export async function stepUp(action: Record<string, unknown>) {
  const options = await api<RequestOptions>("/api/passkeys/step-up", { method: "POST", body: { action } });
  return getAssertion(options);
}
