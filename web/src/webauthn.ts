export function toBase64url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export type CreationOptions = {
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: { type: "public-key"; alg: number }[];
  timeout: number;
  attestation: AttestationConveyancePreference;
  authenticatorSelection: AuthenticatorSelectionCriteria;
  excludeCredentials: { type: "public-key"; id: string }[];
};

export type RequestOptions = { challenge: string; rpId: string; timeout: number; userVerification: UserVerificationRequirement; allowCredentials: { type: "public-key"; id: string }[] };

export async function createPasskey(options: CreationOptions) {
  const credential = (await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: fromBase64url(options.challenge),
      user: { ...options.user, id: fromBase64url(options.user.id) },
      excludeCredentials: options.excludeCredentials.map((entry) => ({ type: "public-key", id: fromBase64url(entry.id) })),
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey was created.");
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: toBase64url(credential.rawId),
    type: "public-key" as const,
    response: { clientDataJSON: toBase64url(response.clientDataJSON), attestationObject: toBase64url(response.attestationObject), transports: response.getTransports?.() ?? [] },
  };
}

export async function getAssertion(options: RequestOptions) {
  const credential = (await navigator.credentials.get({
    publicKey: { ...options, challenge: fromBase64url(options.challenge), allowCredentials: options.allowCredentials.map((entry) => ({ type: "public-key", id: fromBase64url(entry.id) })) },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey answered.");
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: toBase64url(credential.rawId),
    type: "public-key" as const,
    response: { clientDataJSON: toBase64url(response.clientDataJSON), authenticatorData: toBase64url(response.authenticatorData), signature: toBase64url(response.signature) },
  };
}
