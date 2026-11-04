import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, type Me } from "./api.js";
import { Connect } from "./pages/Connect.js";
import { Login } from "./pages/Login.js";
import { WalletDetail } from "./pages/WalletDetail.js";
import { Wallets } from "./pages/Wallets.js";
import { Link, navigate, useLocation } from "./router.js";
import "./styles.css";

type Meta = { hostedChains: string[] };

function App() {
  const { path, query } = useLocation();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [meta, setMeta] = useState<Meta>({ hostedChains: [] });

  useEffect(() => {
    api<Me>("/api/me").then(setMe, () => setMe(null));
    api<Meta>("/api/meta").then(setMeta, () => undefined);
  }, []);

  const logout = async () => {
    await api("/auth/logout", { method: "POST", body: {} }).catch(() => undefined);
    setMe(null);
    navigate("/login");
  };

  let page;
  if (path === "/connect") page = <Connect requestId={query.get("request") ?? ""} />;
  else if (me === undefined) page = <p className="muted">Loading…</p>;
  else if (me === null || path === "/login") page = <Login error={query.get("error")} returnTo={path === "/login" ? "/" : `${path}${window.location.search}`} />;
  else if (path.startsWith("/wallets/")) page = <WalletDetail walletId={path.slice("/wallets/".length)} chains={meta.hostedChains} />;
  else page = <Wallets />;

  return (
    <main>
      <header className="top">
        <Link to="/">Whale</Link>
        {me ? (
          <span className="row">
            <span className="muted">{me.email}</span>
            <button onClick={() => void logout()}>Sign out</button>
          </span>
        ) : null}
      </header>
      {page}
    </main>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
