import { useEffect, useState } from "react";
import { CircleCheck, Loader, LogIn } from "lucide-react";
import { api } from "../admin";
import { errorText } from "../forms";
import { PRODUCT, useT } from "../i18n";

export function Login({ hostname, onLogin }: { hostname: string; onLogin: () => void }) {
  const t = useT();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.login(password);
      onLogin();
    } catch (err) {
      setError(errorText(err));
      setPassword("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="center-page">
      <form className="card login" onSubmit={submit}>
        <span className="logo big" />
        <h1>{PRODUCT}</h1>
        <p className="muted">{t("adm_login_web", { host: hostname })}</p>
        {error && <div className="alert err">{error}</div>}
        <label className="field-label" htmlFor="pw">{t("adm_admin_password")}</label>
        <input id="pw" type="password" autoComplete="current-password" autoFocus value={password}
          onChange={(e) => setPassword(e.target.value)} />
        <button className="btn primary block" disabled={!password || busy}>
          {busy ? <Loader size={16} className="spin" /> : <LogIn size={16} />} {t("adm_login")}
        </button>
      </form>
    </div>
  );
}

/** #/confirm/<token>: opened at the new address after a network change. */
export function ConfirmNetwork({ token }: { token: string }) {
  const t = useT();
  const [state, setState] = useState<"busy" | "ok" | "err">("busy");
  const [message, setMessage] = useState("");
  useEffect(() => {
    api.confirmNetwork(token)
      .then(() => setState("ok"))
      .catch((e) => { setState("err"); setMessage(errorText(e)); });
  }, [token]);
  return (
    <div className="center-page">
      <div className="card login">
        <span className="logo big" />
        {state === "busy" && <p><Loader size={18} className="spin" /> {t("adm_rb_confirming")}</p>}
        {state === "ok" && (
          <>
            <h1><CircleCheck size={22} className="ok-text" /> {t("adm_rb_confirmed")}</h1>
            <p className="muted">{t("adm_rb_confirmed_text")}</p>
            <a className="btn primary block" href="#/">{t("adm_btn_continue")}</a>
          </>
        )}
        {state === "err" && (
          <>
            <h1>{t("adm_rb_not_confirmed")}</h1>
            <div className="alert err">{message}</div>
            <p className="muted">{t("adm_rb_ran_out")}</p>
          </>
        )}
      </div>
    </div>
  );
}
