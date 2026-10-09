import { useCallback, useEffect, useState } from "react";
import { Download, KeyRound, Power, RefreshCw, RotateCcw, Upload } from "lucide-react";
import { api, waitJob, type Job, type SettingsInfo } from "../admin";
import { Card, PageHeader } from "../components";
import {
  Confirm, errorText, RollbackDialog, SaveStatus, SECRET_FIELDS, useSaver, useToast, type Values,
} from "../forms";

// ---------------------------------------------------------------------------
export function Logs() {
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
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load, auto]);
  const sources: [string, string][] = [
    ["sync", "Mirror (sync)"], ["tftp", "TFTP"], ["web", "Web server"], ["appliance", "Appliance"], ["system", "System"],
  ];
  return (
    <div className="page">
      <PageHeader title="Logs" subtitle="The newest lines; refreshed every 5 seconds." />
      <div className="tabs">
        {sources.map(([v, l]) => (
          <button key={v} className={`tab${source === v ? " active" : ""}`} onClick={() => setSource(v)}>{l}</button>
        ))}
      </div>
      <div className="toolbar">
        <select value={lines} onChange={(e) => setLines(Number(e.target.value))} aria-label="Lines">
          {[100, 300, 1000, 5000].map((n) => <option key={n} value={n}>{n} lines</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto refresh</label>
        <div className="toolbar-right">
          <button className="btn slim" onClick={load}><RefreshCw size={16} /> Refresh</button>
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
  const toast = useToast();
  const [job, setJob] = useState<Job | null>(null);
  const [ask, setAsk] = useState<"" | "update-system" | "update-app" | "reboot">("");
  const run = async (name: "update-system" | "update-app") => {
    try {
      const { job: id } = await api.action(name);
      const done = await waitJob(id!, (messages) => setJob((j) => ({ ...(j ?? { id: id!, kind: name, state: "running", result: null }), messages })));
      setJob(done);
      const result = done.result as { message?: string; reboot?: boolean } | null;
      if (result?.message) setJob({ ...done, messages: [...done.messages, result.message] });
      toast(done.state === "done" ? "Update finished." : "Update failed.", done.state === "done" ? "ok" : "err");
      if (result?.reboot) setAsk("reboot");
    } catch (e) {
      toast(errorText(e), "err");
    }
  };
  return (
    <div className="page">
      <PageHeader title="Updates" subtitle="Debian security updates are installed automatically every day." />
      <div className="grid-2">
        <Card title="System (Debian packages)">
          <p>Install all available Debian updates now. The appliance's own packages are protected, and its services
            are checked afterwards. A reboot is offered when a new kernel was installed.</p>
          <p className="muted small">Tip: take a snapshot of the VM first if your hypervisor supports it.</p>
          <button className="btn primary" disabled={job?.state === "running"} onClick={() => setAsk("update-system")}>
            <Download size={16} /> Update the system
          </button>
        </Card>
        <Card title="EVE-Netboot-Installer">
          <p>Install the newest release. If it does not start correctly, the current version is restored automatically.</p>
          <p className="muted small">Now running: <code>{info?.image ?? "..."}</code></p>
          <button className="btn primary" disabled={job?.state === "running"} onClick={() => setAsk("update-app")}>
            <Download size={16} /> Update EVE-Netboot-Installer
          </button>
        </Card>
      </div>
      {job && <Card title="Progress"><JobView job={job} /></Card>}
      {(ask === "update-system" || ask === "update-app") && (
        <Confirm title="Update" text={ask === "update-system" ? "Install the newest Debian updates now?"
          : "Look for a newer EVE-Netboot-Installer release and install it?"}
          confirm="Update" onConfirm={() => run(ask)} onClose={() => setAsk("")} />
      )}
      {ask === "reboot" && (
        <Confirm title="Reboot needed" text="The updates need a reboot to take effect. Reboot now?" confirm="Reboot"
          onConfirm={() => api.action("reboot").then(() => toast("Rebooting ..."))} onClose={() => setAsk("")} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
export function Backup() {
  const toast = useToast();
  const [exported, setExported] = useState("");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<{ changes: Values; current: Record<string, string> } | null>(null);
  const { state, save, reset } = useSaver(() => toast("Imported settings applied."));

  useEffect(() => {
    fetch("api/export", { credentials: "same-origin" }).then((r) => r.text()).then(setExported).catch(() => {});
  }, []);

  const load = async () => {
    try {
      const [{ settings }, current] = await Promise.all([
        api.importSettings(url ? { url } : { text }), api.settings(),
      ]);
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
      <PageHeader title="Backup and restore"
        subtitle="Export the settings to recreate this VM from a newer image, or import the settings of another VM." />
      <div className="grid-2">
        <Card title="Export">
          <p>The settings as KEY=VALUE text. Use it as the cloud-init user-data of a new VM, or import it there.
            Passwords and tokens are not included.</p>
          <a className="btn primary" href="api/export" download><Download size={16} /> Download</a>
          <pre className="log small-log">{exported}</pre>
        </Card>
        <Card title="Import">
          <label className="field-label" htmlFor="imp-url">Address shown by "Export settings" on another VM</label>
          <input id="imp-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.168.1.20:8080/export-3fa9c1.txt" />
          <label className="field-label" htmlFor="imp-text">or paste the text</label>
          <textarea id="imp-text" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="ENI_LANGUAGE=en" />
          <button className="btn" disabled={!url && !text} onClick={load}><Upload size={16} /> Check</button>
          {preview && (
            <div className="preview">
              {Object.keys(preview.changes).length === 0 ? <p>Nothing would change.</p> : (
                <>
                  <table className="table compact">
                    <thead><tr><th>Setting</th><th>Now</th><th>Imported</th></tr></thead>
                    <tbody>
                      {Object.entries(preview.changes).map(([k, v]) => (
                        <tr key={k}><td><code>{k}</code></td><td>{preview.current[k] ?? "—"}</td><td>{v}</td></tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="form-actions">
                    <button className="btn primary" disabled={state.phase === "saving"} onClick={() => save(preview.changes)}>
                      Apply these settings
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
  const toast = useToast();
  const [ask, setAsk] = useState<"" | "reboot" | "poweroff">("");
  const [pw, setPw] = useState({ current: "", next: "", again: "" });
  const changePassword = async () => {
    if (pw.next !== pw.again) return toast("The new passwords do not match.", "err");
    try {
      await api.password(pw.current, pw.next);
      setPw({ current: "", next: "", again: "" });
      toast("The admin password has been changed.");
    } catch (e) {
      toast(errorText(e), "err");
    }
  };
  return (
    <div className="page">
      <PageHeader title="System" subtitle="Admin password, diagnostics and power." />
      <div className="grid-2">
        <Card title="Admin password">
          <p className="muted small">For this page, the VM's screen menu and SSH.</p>
          <div className="fields">
            <div className="field"><label className="field-label" htmlFor="pw-c">Current password</label>
              <input id="pw-c" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></div>
            <div className="field"><label className="field-label" htmlFor="pw-n">New password (at least 8 characters)</label>
              <input id="pw-n" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></div>
            <div className="field"><label className="field-label" htmlFor="pw-a">New password again</label>
              <input id="pw-a" type="password" autoComplete="new-password" value={pw.again} onChange={(e) => setPw({ ...pw, again: e.target.value })} /></div>
          </div>
          <button className="btn primary" disabled={!pw.current || pw.next.length < 8} onClick={changePassword}>
            <KeyRound size={16} /> Change password
          </button>
        </Card>
        <Card title="Mirror">
          <p>Check GitHub for new EVE-OS releases now (normally this happens once a day).</p>
          <button className="btn" onClick={() => api.action("sync").then(() => toast("The check runs in the background."))
            .catch((e) => toast(errorText(e), "err"))}>
            <RefreshCw size={16} /> Check GitHub now
          </button>
        </Card>
        <Card title="Diagnostics">
          <p>One file with logs, status, network and disk information and the settings (without passwords or tokens),
            for troubleshooting.</p>
          <a className="btn" href="api/diagnostics" download><Download size={16} /> Download diagnostics</a>
        </Card>
        <Card title="Power">
          <p>Restart or shut down this VM.</p>
          <div className="form-actions">
            <button className="btn" onClick={() => setAsk("reboot")}><RotateCcw size={16} /> Reboot</button>
            <button className="btn danger" onClick={() => setAsk("poweroff")}><Power size={16} /> Power off</button>
          </div>
        </Card>
      </div>
      {ask && (
        <Confirm title={ask === "reboot" ? "Reboot" : "Power off"} danger={ask === "poweroff"}
          text={ask === "reboot" ? "Reboot this VM now? The page comes back after about a minute."
            : "Power off this VM now? Machines can no longer network boot from it until it is started again."}
          confirm={ask === "reboot" ? "Reboot" : "Power off"}
          onConfirm={() => api.action(ask).then(() => toast(ask === "reboot" ? "Rebooting ..." : "Powering off ..."))
            .catch((e) => toast(errorText(e), "err"))}
          onClose={() => setAsk("")} />
      )}
    </div>
  );
}
