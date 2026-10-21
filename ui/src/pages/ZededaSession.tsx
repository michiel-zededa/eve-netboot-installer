// The ZEDEDA session of the onboarding: log in with an API (or session) token,
// or with the user's password (used once, never kept). The appliance keeps the token in
// memory only; after a restart or when it expires, log in again.
import { useEffect, useRef, useState } from "react";
import { BrushCleaning, Download, FileDown, FileUp, ListX, LogIn, LogOut, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { api, type ZededaInfo } from "../admin";
import { Card } from "../components";
import { Confirm, errorText, useToast } from "../forms";
import { useT } from "../i18n";

const time = (s: number | null) => (s ? new Date(s * 1000).toLocaleString() : "?");
// today: only the time; otherwise date and time
const when = (s?: number) => {
  if (!s) return "-";
  const d = new Date(s * 1000);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
};

type Node = ZededaInfo["onboarded"][number];
// a node this VM created (or found) in ZEDEDA and still there: it can be deleted there
const inZededa = (n: Node) =>
  (n.result === "created" || n.result === "exists") && Boolean(n.node_id) && n.status?.state !== "gone";
// entries that only clutter the list: failed, deleted, or no longer in ZEDEDA
const stale = (n: Node) => n.result === "failed" || n.result === "deleted" || n.status?.state === "gone";

const STATE_TONE: Record<string, string> = {
  online: "ok", starting: "info", waiting: "warn", offline: "warn", error: "err", gone: "err",
  noread: "neutral", unknown: "neutral",
};

export default function ZededaSession() {
  const t = useT();
  const [info, setInfo] = useState<ZededaInfo | null>(null);
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  // what to confirm: delete in ZEDEDA, or remove from the list (this VM only)
  const [ask, setAsk] = useState<{ action: "delete" | "forget"; nodes: Node[] } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);
  const machinesRef = useRef<HTMLInputElement>(null);
  const [machinesError, setMachinesError] = useState("");
  const [askClear, setAskClear] = useState(false);
  const toast = useToast();

  // with a ZEDEDA session also the state of the nodes (did the machines come online?)
  const load = (force = false) =>
    api.zededa()
      .then((i) => (i.session ? api.zededaStatus(force) : i))
      .then(setInfo)
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    load();
    const timer = setInterval(() => load(), 30000);   // the list fills while machines install and boot
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
      load(true);                     // the nodes' state, now that ZEDEDA can be asked
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

  const run = async ({ action, nodes }: { action: "delete" | "forget"; nodes: Node[] }) => {
    const macs = nodes.map((n) => n.mac);
    try {
      if (action === "delete") {
        const r = await api.zededaDelete(macs);
        if (r.deleted.length) {
          toast(r.deleted.length === 1 ? t("adm_zo_deleted", { name: r.deleted[0] })
                                       : t("adm_zo_deleted_many", { n: r.deleted.length }));
        }
        if (r.failed.length) {
          toast(t("adm_zo_delete_some_failed", { list: r.failed.map((f) => `${f.name}: ${f.error}`).join("; ") }), "err");
        }
      } else {
        const r = await api.zededaForget(macs);
        toast(t("adm_zo_forgotten", { n: r.removed }));
      }
    } catch (e) {
      toast(errorText(e), "err");
    }
    setSelected(new Set());
    load();
  };

  const importList = async (file: File) => {
    if (fileRef.current) fileRef.current.value = "";
    if (file.size > 1024 * 1024) return toast(t("adm_zo_not_csv"), "err");
    try {
      const r = await api.zededaImport(await file.text());
      toast(t("adm_zo_imported", { n: r.imported, skipped: r.skipped }));
      load(true);
    } catch (e) {
      toast(errorText(e), "err");
    }
  };

  // the machine list: an upload replaces it (every row must be valid), or clear it
  const uploadMachines = async (file: File) => {
    if (machinesRef.current) machinesRef.current.value = "";
    setMachinesError("");
    if (file.size > 1024 * 1024) return setMachinesError(t("adm_ml_bad_header"));
    try {
      const r = await api.zededaMachines({ text: await file.text() });
      setInfo((i) => (i ? { ...i, machines: r.machines } : r));
      toast(t("adm_ml_uploaded", { n: r.count ?? r.machines.length }));
    } catch (e) {
      setMachinesError(errorText(e));
    }
  };
  const clearMachines = async () => {
    try {
      const r = await api.zededaMachines({ clear: true });
      setInfo((i) => (i ? { ...i, machines: r.machines } : r));
      toast(t("adm_ml_cleared"));
    } catch (e) {
      toast(errorText(e), "err");
    }
  };

  if (!info) return error ? <div className="alert err">{error}</div> : null;
  if (!info.enabled) return null;
  const s = info.session;
  // the machines that should be in ZEDEDA (not failed, not deleted there)
  const nodes = info.onboarded.filter((n) => (n.result === "created" || n.result === "exists") && n.status?.state !== "gone");
  const chosen = info.onboarded.filter((n) => selected.has(n.mac));
  const deletable = chosen.filter(inZededa);
  const clutter = info.onboarded.filter(stale);
  const toggle = (mac: string) => setSelected((s) => {
    const x = new Set(s);
    if (x.has(mac)) x.delete(mac); else x.add(mac);
    return x;
  });
  const all = info.onboarded.length > 0 && chosen.length === info.onboarded.length;
  const online = nodes.filter((n) => n.status?.state === "online").length;
  // the login method of the settings: an API token needs nothing else, a password the
  // user and enterprise from the settings
  const withPassword = info.login === "password";

  return (
    <>
      <Card title={t("adm_zo_session")}>
        {error && <div className="alert err"><TriangleAlert size={16} /> {error}</div>}
        {warning && <div className="alert warn"><TriangleAlert size={16} /> {warning}</div>}
        {s ? (
          <>
            <div className="session-row">
              <p>
                <span className="pill ok">{t("adm_zo_logged_in")}</span>{" "}
                {s.via === "token"
                  ? t(s.user && s.enterprise ? "adm_zo_session_token_text"
                      : s.user ? "adm_zo_session_token_user" : "adm_zo_session_token_anon",
                      { user: s.user, enterprise: s.enterprise, cluster: s.cluster })
                  : t("adm_zo_session_text", { user: s.user, enterprise: s.enterprise, cluster: s.cluster,
                                               until: time(s.expires) })}
              </p>
              <button className="btn slim" disabled={busy} onClick={logout}><LogOut size={16} /> {t("adm_zo_logout")}</button>
            </div>
            <p className="muted small">{t("adm_zo_memory_note")}</p>
          </>
        ) : (
          <>
            <p><span className="pill warn">{t("adm_zo_not_logged_in_ui")}</span></p>
            {withPassword ? (
              <p className="muted small">{t("adm_zo_login_text", { user: info.user || "-", enterprise: info.enterprise || "-",
                                                                    cluster: info.cluster })}</p>
            ) : (
              <p className="muted small">{t("adm_zo_login_token_text", { cluster: info.cluster })}</p>
            )}
            <div className="fields">
              {withPassword ? (
                <label className="field">
                  <span className="field-label">{t("adm_zo_password")}</span>
                  <input type="password" autoComplete="off" value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && password) login({ password }); }} />
                </label>
              ) : (
                <label className="field">
                  <span className="field-label">{t("adm_zo_token")}</span>
                  <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && token) login({ token }); }} />
                  <span className="field-help">{t("adm_zo_token_help")}</span>
                </label>
              )}
            </div>
            <div className="form-actions">
              <button className="btn primary" disabled={busy || (withPassword ? !password : !token)}
                onClick={() => login(withPassword ? { password } : { token })}>
                <LogIn size={16} /> {t("adm_zo_login")}
              </button>
            </div>
            <p className="muted small">{t("adm_zo_user_hint")}</p>
          </>
        )}
      </Card>
      <Card title={t("adm_ml_title")} actions={
        <div className="card-actions">
          <a className="btn slim" href="api/zededa/machines-template.csv" download>
            <FileDown size={16} /> {t("adm_ml_template")}
          </a>
          <button className="btn slim" onClick={() => machinesRef.current?.click()}>
            <FileUp size={16} /> {t("adm_ml_upload")}
          </button>
          <input ref={machinesRef} type="file" accept=".csv,text/csv" hidden
            onChange={(e) => e.target.files?.[0] && uploadMachines(e.target.files[0])} />
          {info.machines.length > 0 && (
            <>
              <a className="btn slim" href="api/zededa/machines.csv" download><Download size={16} /> {t("adm_ml_download")}</a>
              <button className="btn slim" onClick={() => setAskClear(true)}><ListX size={16} /> {t("adm_ml_clear")}</button>
            </>
          )}
        </div>
      }>
        <p className="muted small">{t("adm_ml_text")}</p>
        {machinesError && <div className="alert err multiline"><TriangleAlert size={16} /> <span>{machinesError}</span></div>}
        {info.machines.length === 0 ? (
          <p className="muted">{t("adm_ml_none")}</p>
        ) : (
          <div className="table-card">
            <table className="table compact">
              <thead>
                <tr>
                  <th>{t("adm_zo_col_name")}</th>
                  <th>{t("adm_zo_col_mac")}</th>
                  <th>{t("adm_ml_col_serial")}</th>
                  <th>{t("adm_ml_col_project")}</th>
                  <th>{t("adm_ml_col_installed")}</th>
                </tr>
              </thead>
              <tbody>
                {info.machines.map((m) => (
                  <tr key={m.mac || m.hardware_serial}>
                    <td className="nowrap">
                      {m.name ? <strong>{m.name}</strong> : <span className="muted mono">{info.node_name}</span>}
                    </td>
                    <td className="mono nowrap">{m.mac || "-"}</td>
                    <td className="mono">{m.hardware_serial || "-"}</td>
                    <td>{m.project || <span className="muted">{info.project}</span>}</td>
                    <td>
                      {m.node ? (
                        <span className={`pill ${m.node.result === "failed" ? "err" : STATE_TONE[m.node.state] ?? "ok"}`}>
                          {m.node.result === "failed" || !m.node.state ? t(`adm_zo_result_${m.node.result}`)
                                                                         : t(`adm_zo_state_${m.node.state}`)}
                        </span>
                      ) : (
                        <span className="muted">{t("adm_ml_not_yet")}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title={t("adm_zo_onboarded")} actions={
        <div className="card-actions">
          {s && info.onboarded.length > 0 && (
            <button className="btn slim" onClick={() => load(true)}><RefreshCw size={16} /> {t("adm_zo_check_now")}</button>
          )}
          <button className="btn slim" title={t("adm_zo_import_help")} onClick={() => fileRef.current?.click()}>
            <FileUp size={16} /> {t("adm_zo_import_csv")}
          </button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" hidden
            onChange={(e) => e.target.files?.[0] && importList(e.target.files[0])} />
          {info.onboarded.length > 0 && (
            <a className="btn slim" href="api/zededa/export" download><Download size={16} /> {t("adm_zo_export_csv")}</a>
          )}
        </div>
      }>
        {nodes.length > 0 && (
          <p>
            <span className={`pill ${online === nodes.length ? "ok" : "warn"}`}>
              {t("adm_zo_summary", { online, total: nodes.length })}
            </span>
          </p>
        )}
        {nodes.some((n) => n.status?.state === "waiting") && <p className="muted small">{t("adm_zo_waiting_hint")}</p>}
        {(chosen.length > 0 || clutter.length > 0) && (
          <div className="selection-bar">
            {chosen.length > 0 ? (
              <>
                <span className="muted small">{t("adm_zo_selected", { n: chosen.length })}</span>
                <button className="btn slim" onClick={() => setAsk({ action: "forget", nodes: chosen })}>
                  <ListX size={16} /> {t("adm_zo_forget")}
                </button>
                <button className="btn slim danger" disabled={!s || deletable.length === 0}
                  title={s ? undefined : t("adm_zo_delete_login")}
                  onClick={() => setAsk({ action: "delete", nodes: deletable })}>
                  <Trash2 size={16} /> {t("adm_zo_delete")}{deletable.length !== chosen.length ? ` (${deletable.length})` : ""}
                </button>
              </>
            ) : (
              <button className="btn slim" title={t("adm_zo_cleanup_help")}
                onClick={() => setAsk({ action: "forget", nodes: clutter })}>
                <BrushCleaning size={16} /> {t("adm_zo_cleanup", { n: clutter.length })}
              </button>
            )}
          </div>
        )}
        {info.onboarded.length === 0 ? (
          <p className="muted">{t("adm_zo_none_yet")}</p>
        ) : (
          <div className="table-card">
            <table className="table compact">
              <thead>
                <tr>
                  <th className="select">
                    <input type="checkbox" aria-label={t("adm_zo_select_all")} checked={all}
                      onChange={() => setSelected(all ? new Set() : new Set(info.onboarded.map((n) => n.mac)))} />
                  </th>
                  <th>{t("adm_zo_col_time")}</th>
                  <th>{t("adm_zo_col_name")}</th>
                  <th>{t("adm_zo_col_mac")}</th>
                  <th>{t("adm_zo_col_machine")}</th>
                  <th>{t("adm_zo_col_state")}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {info.onboarded.map((n) => (
                  <tr key={n.mac} className={selected.has(n.mac) ? "selected" : undefined}>
                    <td className="select">
                      <input type="checkbox" aria-label={n.name} checked={selected.has(n.mac)} onChange={() => toggle(n.mac)} />
                    </td>
                    <td className="nowrap">{when(n.time)}</td>
                    <td className="nowrap"><strong>{n.name}</strong></td>
                    <td className="mono nowrap">{n.mac}</td>
                    <td>
                      {n.product || "-"}
                      {n.hardware_serial && <div className="small muted mono">{n.hardware_serial}</div>}
                    </td>
                    <td>
                      {n.result === "failed" || n.result === "deleted" || !n.status ? (
                        <span className={`pill ${n.result === "failed" ? "err" : n.result === "deleted" ? "neutral" : "ok"}`}>
                          {t(`adm_zo_result_${n.result}`)}
                        </span>
                      ) : (
                        <span className={`pill ${STATE_TONE[n.status.state]}`} title={n.status.run_state ?? ""}>
                          {t(`adm_zo_state_${n.status.state}`)}
                        </span>
                      )}
                      {n.result === "failed" && <div className="small err-text">{n.message}</div>}
                      {n.result !== "failed" && n.result !== "deleted" && (
                        <>
                          {(n.online_since || n.status?.eve) && (
                            <div className="small muted">
                              {[n.online_since ? `${t("adm_zo_online_since")} ${when(n.online_since)}` : "",
                                n.status?.eve ? `${t("adm_zo_eve_version")} ${n.status.eve}` : ""].filter(Boolean).join(" · ")}
                            </div>
                          )}
                          {n.status?.error && <div className="small err-text">{n.status.error}</div>}
                        </>
                      )}
                    </td>
                    <td className="nowrap">
                      <button className="icon-btn small" title={t("adm_zo_forget")} aria-label={t("adm_zo_forget")}
                        onClick={() => setAsk({ action: "forget", nodes: [n] })}>
                        <ListX size={16} />
                      </button>
                      {inZededa(n) && (
                        <button className="icon-btn small" title={s ? t("adm_zo_delete") : t("adm_zo_delete_login")}
                          aria-label={t("adm_zo_delete")} disabled={!s} onClick={() => setAsk({ action: "delete", nodes: [n] })}>
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
      {askClear && (
        <Confirm title={t("adm_ml_clear")} text={t("adm_ml_clear_q", { n: info.machines.length })}
          confirm={t("adm_ml_clear")} onConfirm={clearMachines} onClose={() => setAskClear(false)} />
      )}
      {ask && (
        <Confirm danger={ask.action === "delete"}
          title={ask.action === "delete" ? t("adm_zo_delete") : t("adm_zo_forget")}
          text={ask.action === "delete"
            ? (ask.nodes.length === 1 ? t("adm_zo_delete_q", { name: ask.nodes[0].name })
                                      : t("adm_zo_delete_many_q", { n: ask.nodes.length,
                                                                     names: ask.nodes.map((n) => n.name).join(", ") }))
            : t("adm_zo_forget_q", { n: ask.nodes.length, names: ask.nodes.map((n) => n.name).join(", ") })}
          confirm={ask.action === "delete" ? t("adm_zo_delete") : t("adm_zo_forget")}
          onConfirm={() => run(ask)} onClose={() => setAsk(null)} />
      )}
    </>
  );
}
