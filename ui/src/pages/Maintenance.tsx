import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FileUp, KeyRound, Power, RefreshCw, RotateCcw, Upload } from "lucide-react";
import { api, waitJob, type Job, type SettingsInfo } from "../admin";
import { Card, PageHeader } from "../components";
import {
  Confirm, errorText, RollbackDialog, SaveStatus, SECRET_FIELDS, useSaver, useToast, type Values,
} from "../forms";
import { PRODUCT, useT } from "../i18n";

// ---------------------------------------------------------------------------
export function Logs() {
  const t = useT();
  const [source, setSource] = useState("sync");
  const [lines, setLines] = useState(300);
  const [text, setText] = useState("");
  const [auto, setAuto] = useState(true);
  const load = useCallback(() => {
    api.logs(source, lines).then(setText).catch((e) => setText(errorText(e)));
  }, [source, lines]);
  useEffect(() => {
    load();
    if (!auto) return;
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load, auto]);
  const sources = ["sync", "tftp", "web", "appliance", "system"].map((v): [string, string] => [v, t(`adm_o_log_${v}`)]);
  return (
    <div className="page">
      <PageHeader title={t("adm_nav_logs")} subtitle={t("adm_logs_subtitle")} />
      <div className="tabs">
        {sources.map(([v, l]) => (
          <button key={v} className={`tab${source === v ? " active" : ""}`} onClick={() => setSource(v)}>{l}</button>
        ))}
      </div>
      <div className="toolbar">
        <select value={lines} onChange={(e) => setLines(Number(e.target.value))} aria-label={t("adm_lines_label")}>
          {[100, 300, 1000, 5000].map((n) => <option key={n} value={n}>{t("adm_lines", { n })}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> {t("adm_auto_refresh")}</label>
        <div className="toolbar-right">
          <button className="btn slim" onClick={load}><RefreshCw size={16} /> {t("ui_refresh")}</button>
        </div>
      </div>
      <pre className="card log">{text || " "}</pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
function JobView({ job }: { job: Job | null }) {
  if (!job) return null;
  return (
    <div className={`job ${job.state}`}>
      {job.messages.map((m, i) => <div key={i}>{m}</div>)}
      {job.state === "running" && <div className="muted">...</div>}
    </div>
  );
}

export function Updates({ info }: { info: SettingsInfo | null }) {
  const t = useT();
  const toast = useToast();
  const [job, setJob] = useState<Job | null>(null);
  const [ask, setAsk] = useState<"" | "update-system" | "update-app" | "reboot">("");
  const run = async (name: "update-system" | "update-app") => {
    try {
      const { job: id } = await api.action(name);
      const done = await waitJob(id!, (messages) => setJob((j) => ({ ...(j ?? { id: id!, kind: name, state: "running", result: null }), messages })));
      setJob(done);
      const result = done.result as { ok?: boolean; message?: string; reboot?: boolean } | null;
      if (result?.message) setJob({ ...done, messages: [...done.messages, result.message] });
      // a job can finish without updating (already current, a development build)
      const ok = done.state === "done" && result?.ok !== false;
      toast(ok ? t("adm_update_finished") : result?.message ?? t("adm_update_failed"), ok ? "ok" : "err");
      if (result?.reboot) setAsk("reboot");
    } catch (e) {
      toast(errorText(e), "err");
    }
  };
  return (
    <div className="page">
      <PageHeader title={t("adm_nav_updates")} subtitle={t("adm_updates_subtitle")} />
      <div className="grid-2">
        <Card title={t("adm_updates_system_title")}>
          <p>{t("adm_updates_system_text")}</p>
          <p className="muted small">{t("adm_snapshot_tip")}</p>
          <button className="btn primary" disabled={job?.state === "running"} onClick={() => setAsk("update-system")}>
            <Download size={16} /> {t("adm_update_system")}
          </button>
        </Card>
        <Card title={PRODUCT}>
          <p>{t("adm_updates_app_text")}</p>
          <p className="muted small">{t("adm_now_running")} <code>{info?.image ?? "..."}</code></p>
          <button className="btn primary" disabled={job?.state === "running"} onClick={() => setAsk("update-app")}>
            <Download size={16} /> {t("adm_update_app")}
          </button>
        </Card>
      </div>
      {job && <Card title={t("adm_progress")}><JobView job={job} /></Card>}
      {(ask === "update-system" || ask === "update-app") && (
        <Confirm title={t("adm_btn_update")} text={ask === "update-system" ? t("adm_update_system_confirm")
          : t("adm_update_app_confirm")}
          confirm={t("adm_btn_update")} onConfirm={() => run(ask)} onClose={() => setAsk("")} />
      )}
      {ask === "reboot" && (
        <Confirm title={t("adm_reboot_needed")} text={t("adm_reboot_needed_text")} confirm={t("adm_btn_reboot")}
          onConfirm={() => api.action("reboot").then(() => toast(t("adm_rebooting")))} onClose={() => setAsk("")} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
export function Backup({ onSaved }: { onSaved?: () => void }) {
  const t = useT();
  const toast = useToast();
  const [exported, setExported] = useState("");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<{ changes: Values; current: Record<string, string> } | null>(null);
  const { state, save, reset } = useSaver(() => {
    toast(t("adm_imported_applied"));
    onSaved?.();
  });

  useEffect(() => {
    fetch("api/export", { credentials: "same-origin" }).then((r) => r.text()).then(setExported).catch(() => {});
  }, []);

  // an exported settings file of another VM (eve-netboot-settings.txt)
  const pickFile = async (f: File) => {
    if (fileRef.current) fileRef.current.value = "";
    if (f.size > 256 * 1024) return toast(t("adm_imp_not_a_settings_file"), "err");
    setUrl("");
    setFile(f.name);
    const content = await f.text();
    setText(content);
    load({ text: content });
  };

  const load = async (from: { url?: string; text?: string } = url ? { url } : { text }) => {
    try {
      const [{ settings }, current] = await Promise.all([api.importSettings(from), api.settings()]);
      const changes: Values = {};
      for (const [k, v] of Object.entries(settings)) {
        if (!SECRET_FIELDS.has(k) && current.settings[k] !== v) changes[k] = v;
      }
      setPreview({ changes, current: current.settings });
    } catch (e) {
      toast(errorText(e), "err");
    }
  };

  return (
    <div className="page">
      <PageHeader title={t("adm_nav_backup")} subtitle={t("adm_backup_subtitle")} />
      <div className="grid-2">
        <Card title={t("adm_export")}>
          <p>{t("adm_export_text")}</p>
          <a className="btn primary" href="api/export" download><Download size={16} /> {t("adm_download")}</a>
          <pre className="log small-log">{exported}</pre>
        </Card>
        <Card title={t("adm_import")}>
          <label className="field-label">{t("adm_imp_file_label")}</label>
          <div className="file-pick">
            <input ref={fileRef} type="file" accept=".txt,.env,text/plain" hidden
              onChange={(e) => e.target.files?.[0] && pickFile(e.target.files[0])} />
            <button className="btn" onClick={() => fileRef.current?.click()}><FileUp size={16} /> {t("adm_imp_upload_file")}</button>
            {file && <span className="muted small">{file}</span>}
          </div>
          <label className="field-label" htmlFor="imp-url">{t("adm_imp_or_url")}</label>
          <input id="imp-url" value={url} onChange={(e) => { setUrl(e.target.value); setFile(""); }}
            placeholder="http://192.168.1.20:8080/export-3fa9c1.txt" />
          <label className="field-label" htmlFor="imp-text">{t("adm_imp_or_paste")}</label>
          <textarea id="imp-text" rows={6} value={text} onChange={(e) => { setText(e.target.value); setFile(""); }}
            placeholder="ENI_LANGUAGE=en" />
          <button className="btn" disabled={!url && !text} onClick={() => load()}><Upload size={16} /> {t("adm_imp_check")}</button>
          {preview && (
            <div className="preview">
              {Object.keys(preview.changes).length === 0 ? <p>{t("adm_imp_nothing")}</p> : (
                <>
                  <table className="table compact">
                    <thead><tr><th>{t("adm_col_setting")}</th><th>{t("adm_col_now")}</th><th>{t("adm_col_imported")}</th></tr></thead>
                    <tbody>
                      {Object.entries(preview.changes).map(([k, v]) => (
                        <tr key={k}><td><code>{k}</code></td><td>{preview.current[k] ?? "—"}</td><td>{v}</td></tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="form-actions">
                    <button className="btn primary" disabled={state.phase === "saving"} onClick={() => save(preview.changes)}>
                      {t("adm_imp_apply")}
                    </button>
                    <SaveStatus state={state} />
                  </div>
                </>
              )}
            </div>
          )}
        </Card>
      </div>
      {state.phase === "rollback" && <RollbackDialog result={state.result} onClose={reset} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
export function System() {
  const t = useT();
  const toast = useToast();
  const [ask, setAsk] = useState<"" | "reboot" | "poweroff">("");
  const [pw, setPw] = useState({ current: "", next: "", again: "" });
  const changePassword = async () => {
    if (pw.next !== pw.again) return toast(t("adm_pw_mismatch"), "err");
    try {
      await api.password(pw.current, pw.next);
      setPw({ current: "", next: "", again: "" });
      toast(t("adm_password_changed"));
    } catch (e) {
      toast(errorText(e), "err");
    }
  };
  return (
    <div className="page">
      <PageHeader title={t("adm_nav_system")} subtitle={t("adm_system_subtitle")} />
      <div className="grid-2">
        <Card title={t("adm_admin_password")}>
          <p className="muted small">{t("adm_setup_password_text")}</p>
          <div className="fields">
            <div className="field"><label className="field-label" htmlFor="pw-c">{t("adm_pw_current")}</label>
              <input id="pw-c" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></div>
            <div className="field"><label className="field-label" htmlFor="pw-n">{t("adm_pw_label", { n: 8 })}</label>
              <input id="pw-n" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></div>
            <div className="field"><label className="field-label" htmlFor="pw-a">{t("adm_pw_again_label")}</label>
              <input id="pw-a" type="password" autoComplete="new-password" value={pw.again} onChange={(e) => setPw({ ...pw, again: e.target.value })} /></div>
          </div>
          <button className="btn primary" disabled={!pw.current || pw.next.length < 8} onClick={changePassword}>
            <KeyRound size={16} /> {t("adm_change_password")}
          </button>
        </Card>
        <Card title={t("adm_mirror_card")}>
          <p>{t("adm_sync_text")}</p>
          <button className="btn" onClick={() => api.action("sync").then(() => toast(t("adm_sync_started")))
            .catch((e) => toast(errorText(e), "err"))}>
            <RefreshCw size={16} /> {t("adm_sync_now")}
          </button>
        </Card>
        <Card title={t("adm_diagnostics")}>
          <p>{t("adm_diagnostics_text")}</p>
          <a className="btn" href="api/diagnostics" download><Download size={16} /> {t("adm_diagnostics_download")}</a>
        </Card>
        <Card title={t("adm_power")}>
          <p>{t("adm_power_text")}</p>
          <div className="form-actions">
            <button className="btn" onClick={() => setAsk("reboot")}><RotateCcw size={16} /> {t("adm_reboot")}</button>
            <button className="btn danger" onClick={() => setAsk("poweroff")}><Power size={16} /> {t("adm_poweroff")}</button>
          </div>
        </Card>
      </div>
      {ask && (
        <Confirm title={ask === "reboot" ? t("adm_reboot") : t("adm_poweroff")} danger={ask === "poweroff"}
          text={ask === "reboot" ? t("adm_reboot_web_q") : t("adm_poweroff_q")}
          confirm={ask === "reboot" ? t("adm_reboot") : t("adm_poweroff")}
          onConfirm={() => api.action(ask).then(() => toast(ask === "reboot" ? t("adm_rebooting") : t("adm_powering_off")))
            .catch((e) => toast(errorText(e), "err"))}
          onClose={() => setAsk("")} />
      )}
    </div>
  );
}
