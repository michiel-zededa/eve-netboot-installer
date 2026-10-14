// The ZEDEDA session of the onboarding: log in with an API (or session) token,
// or with the user's password (used once, never kept). The appliance keeps the token in
// memory only; after a restart or when it expires, log in again.
import { useEffect, useState } from "react";
import { Download, LogIn, LogOut, Trash2, TriangleAlert } from "lucide-react";
import { api, type ZededaInfo } from "../admin";
import { Card } from "../components";
import { Confirm, errorText, useToast } from "../forms";
import { useT } from "../i18n";

const time = (s: number | null) => (s ? new Date(s * 1000).toLocaleString() : "?");

export default function ZededaSession() {
  const t = useT();
  const [info, setInfo] = useState<ZededaInfo | null>(null);
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [remove, setRemove] = useState<ZededaInfo["onboarded"][number] | null>(null);
  const toast = useToast();

  const load = () => api.zededa().then(setInfo).catch((e) => setError(errorText(e)));
  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);   // the overview fills while machines boot
    return () => clearInterval(timer);
  }, []);

  const login = async (by: { password?: string; token?: string }) => {
    setBusy(true);
    setError("");
    setWarning("");
    try {
      const r = await api.zededaLogin(by);
      setInfo(r);
      setWarning(r.warning);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPassword("");
      setToken("");
      setBusy(false);
    }
  };
  const logout = async () => {
    setBusy(true);
    try {
      await api.zededaLogout();
      await load();
    } finally {
      setBusy(false);
    }
  };

  const deleteNode = async (mac: string, name: string) => {
    try {
      await api.zededaDelete(mac);
      toast(t("adm_zo_deleted", { name }));
    } catch (e) {
      toast(errorText(e), "err");
    }
    load();
  };

  if (!info) return error ? <div className="alert err">{error}</div> : null;
  if (!info.enabled) return null;
  const s = info.session;
  // a password needs the user and enterprise from the settings; an API token needs nothing else
  const withPassword = Boolean(info.user && info.enterprise);

  return (
    <>
      <Card title={t("adm_zo_session")}>
        {error && <div className="alert err"><TriangleAlert size={16} /> {error}</div>}
        {warning && <div className="alert warn"><TriangleAlert size={16} /> {warning}</div>}
        {s ? (
          <>
            <p>
              <span className="pill ok">{t("adm_zo_logged_in")}</span>{" "}
              {s.via === "token"
                ? t("adm_zo_session_token_text", { cluster: s.cluster })
                : t("adm_zo_session_text", { user: s.user, enterprise: s.enterprise, cluster: s.cluster,
                                             until: time(s.expires) })}
            </p>
            <p className="muted small">{t("adm_zo_memory_note")}</p>
            <div className="form-actions">
              <button className="btn" disabled={busy} onClick={logout}><LogOut size={16} /> {t("adm_zo_logout")}</button>
            </div>
          </>
        ) : (
          <>
            <p><span className="pill warn">{t("adm_zo_not_logged_in_ui")}</span></p>
            {withPassword ? (
              <p className="muted small">{t("adm_zo_login_text", { user: info.user, enterprise: info.enterprise,
                                                                    cluster: info.cluster })}</p>
            ) : (
              <p className="muted small">{t("adm_zo_login_token_text", { cluster: info.cluster })}</p>
            )}
            <div className="fields">
              <label className="field">
                <span className="field-label">{t("adm_zo_token")}</span>
                <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && token) login({ token }); }} />
                <span className="field-help">{t("adm_zo_token_help")}</span>
              </label>
              {withPassword && (
                <label className="field">
                  <span className="field-label">{t("adm_zo_password")}</span>
                  <input type="password" autoComplete="off" value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && password) login({ password }); }} />
                </label>
              )}
            </div>
            <div className="form-actions">
              <button className="btn primary" disabled={busy || (!password && !token)}
                onClick={() => login(token ? { token } : { password })}>
                <LogIn size={16} /> {t("adm_zo_login")}
              </button>
            </div>
            <p className="muted small">{t("adm_zo_user_hint")}</p>
          </>
        )}
      </Card>
      <Card title={t("adm_zo_onboarded")} actions={info.onboarded.length > 0 && (
        <a className="btn slim" href="api/zededa/export" download><Download size={16} /> {t("adm_zo_export_csv")}</a>
      )}>
        {info.onboarded.length === 0 ? (
          <p className="muted">{t("adm_zo_none_yet")}</p>
        ) : (
          <div className="table-card">
            <table className="table compact">
              <thead>
                <tr>
                  <th>{t("adm_zo_col_time")}</th>
                  <th>{t("adm_zo_col_name")}</th>
                  <th>{t("adm_zo_col_mac")}</th>
                  <th>{t("adm_zo_col_machine")}</th>
                  <th>{t("adm_zo_col_result")}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {info.onboarded.map((n) => (
                  <tr key={n.mac}>
                    <td>{time(n.time)}</td>
                    <td>{n.name}</td>
                    <td className="mono">{n.mac}</td>
                    <td>{[n.product, n.hardware_serial].filter(Boolean).join(", ") || "-"}</td>
                    <td>
                      <span className={`pill ${n.result === "failed" ? "err" : n.result === "deleted" ? "neutral" : "ok"}`}>
                        {t(`adm_zo_result_${n.result}`)}
                      </span>
                      {n.result === "failed" && <div className="small err-text">{n.message}</div>}
                    </td>
                    <td>
                      {(n.result === "created" || n.result === "exists") && n.node_id && (
                        <button className="icon-btn small" title={s ? t("adm_zo_delete") : t("adm_zo_delete_login")}
                          aria-label={t("adm_zo_delete")} disabled={!s} onClick={() => setRemove(n)}>
                          <Trash2 size={16} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {remove && (
        <Confirm title={t("adm_zo_delete")} text={t("adm_zo_delete_q", { name: remove.name })} confirm={t("adm_zo_delete")}
          danger onConfirm={() => deleteNode(remove.mac, remove.name)} onClose={() => setRemove(null)} />
      )}
    </>
  );
}
