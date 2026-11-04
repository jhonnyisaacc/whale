const ERRORS: Record<string, string> = {
  expired: "The sign-in took too long. Try again.",
  denied: "Google sign-in was cancelled.",
  state: "The sign-in could not be verified. Try again from this page.",
  closed: "This account is closed.",
  signin_failed: "Google sign-in failed. Try again.",
};

export function googleStart(returnTo: string): string {
  return `/auth/google/start?return_to=${encodeURIComponent(returnTo)}`;
}

export function Login({ error, returnTo }: { error: string | null; returnTo: string }) {
  return (
    <div className="card stack">
      <h1>Sign in to Whale</h1>
      <p className="muted">Google opens your account. Your wallet is owned by a passkey on your device, and Whale never holds its keys.</p>
      {error ? <p className="error">{ERRORS[error] ?? "Sign-in failed."}</p> : null}
      <a className="button primary" href={googleStart(returnTo)}>
        Continue with Google
      </a>
    </div>
  );
}
