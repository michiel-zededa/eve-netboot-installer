import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { CircleAlert, CircleCheck, Loader, X } from "lucide-react";
import { api, ApiError, waitJob, type SaveResult, type SettingsInfo } from "./admin";

// ---------------------------------------------------------------------------
// Field definitions: shared by the settings pages and the web setup
// ---------------------------------------------------------------------------
export type FieldType = "text" | "number" | "select" | "yesno" | "onezero" | "checks" | "secret" | "textarea";

export interface Field {
  key: string;
  label: string;
  type: FieldType;
  help?: string;
  placeholder?: string;
  options?: [string, string][];      // value, label
  showIf?: (v: Values) => boolean;
  wide?: boolean;
}

export type Values = Record<string, string>;

export function value(v: Values, info: SettingsInfo | null, key: string): string {
  return v[key] ?? info?.settings[key] ?? info?.defaults[key] ?? "";
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
export function FieldInput({ field, v, info, set }: {
  field: Field; v: Values; info: SettingsInfo | null; set: (key: string, value: string) => void;
}) {
  const val = value(v, info, field.key);
  const id = `f-${field.key}`;
  let control: ReactNode;
  switch (field.type) {
    case "select":
      control = (
        <select id={id} value={val} onChange={(e) => set(field.key, e.target.value)}>
          {(field.options ?? []).map(([o, l]) => <option key={o} value={o}>{l}</option>)}
        </select>
      );
      break;
    case "yesno":
    case "onezero": {
      const [on, off] = field.type === "yesno" ? ["yes", "no"] : ["1", "0"];
      control = (
        <label className="switch">
          <input id={id} type="checkbox" checked={val === on} onChange={(e) => set(field.key, e.target.checked ? on : off)} />
          <span className="switch-track" />
          <span>{val === on ? "On" : "Off"}</span>
        </label>
      );
      break;
    }
    case "checks": {
      const chosen = val.split(/\s+/).filter(Boolean);
      control = (
        <div className="checks">
          {(field.options ?? []).map(([o, l]) => (
            <label key={o} className="check">
              <input type="checkbox" checked={chosen.includes(o)} onChange={(e) =>
                set(field.key, (e.target.checked ? [...chosen, o] : chosen.filter((c) => c !== o))
                  .sort((a, b) => (field.options ?? []).findIndex(([x]) => x === a) - (field.options ?? []).findIndex(([x]) => x === b))
                  .join(" "))} />
              <span>{l}</span>
            </label>
          ))}
        </div>
      );
      break;
    }
    case "textarea":
      // stored as "a; b" (one line in settings.env), edited one per line
      control = <textarea id={id} rows={4} value={val.split(/;\s*/).join("\n")} placeholder={field.placeholder}
        onChange={(e) => set(field.key, e.target.value.split("\n").join("; "))} />;
      break;
    case "secret":
      control = <input id={id} type="password" autoComplete="new-password" value={v[field.key] ?? ""}
        placeholder={field.placeholder} onChange={(e) => set(field.key, e.target.value)} />;
      break;
    default:
      control = <input id={id} type={field.type === "number" ? "number" : "text"} value={val}
        placeholder={field.placeholder} onChange={(e) => set(field.key, e.target.value)} />;
  }
  return (
    <div className={`field${field.wide ? " wide" : ""}`}>
      <label htmlFor={id} className="field-label">{field.label}</label>
      {control}
      {field.help && <div className="field-help">{field.help}</div>}
    </div>
  );
}

export function Fields({ fields, v, info, set }: {
  fields: Field[]; v: Values; info: SettingsInfo | null; set: (k: string, val: string) => void;
}) {
  const all = { ...(info?.defaults ?? {}), ...(info?.settings ?? {}), ...v };
  return (
    <div className="fields">
      {fields.filter((f) => !f.showIf || f.showIf(all)).map((f) => (
        <FieldInput key={f.key} field={f} v={v} info={info} set={set} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Saving: background task, progress, network rollback
// ---------------------------------------------------------------------------
export const SECRET_FIELDS = new Set(["ADMIN_PASSWORD", "SMB_PASSWORD", "ENI_GITHUB_TOKEN"]);

export function splitChanges(changes: Values) {
  const settings: Record<string, string | null> = {};
  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(changes)) {
    if (SECRET_FIELDS.has(k)) {
      if (v) secrets[k] = v;
    } else {
      settings[k] = v === "" ? null : v;
    }
  }
  return { settings, secrets };
}

export type SaveState =
  | { phase: "idle" }
  | { phase: "saving"; messages: string[] }
  | { phase: "done"; message: string }
  | { phase: "error"; message: string }
  | { phase: "rollback"; result: SaveResult };

export function useSaver(onDone?: () => void) {
  const [state, setState] = useState<SaveState>({ phase: "idle" });
  const save = async (changes: Values) => {
    const { settings, secrets } = splitChanges(changes);
    setState({ phase: "saving", messages: [] });
    try {
      const result = await api.save(settings, secrets);
      if (result.rollback) {
        // the address may change: the job result may never reach this page
        setState({ phase: "rollback", result });
        return;
      }
      const job = await waitJob(result.job, (messages) => setState({ phase: "saving", messages }));
      if (job.state === "failed") throw new Error(job.messages.at(-1) ?? "Failed.");
      setState({ phase: "done", message: "Saved and applied." });
      onDone?.();
    } catch (e) {
      setState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };
  return { state, save, reset: () => setState({ phase: "idle" }) };
}

export function SaveStatus({ state }: { state: SaveState }) {
  if (state.phase === "saving") {
    return <span className="save-status"><Loader size={16} className="spin" /> {state.messages.at(-1) ?? "Saving ..."}</span>;
  }
  if (state.phase === "done") return <span className="save-status ok"><CircleCheck size={16} /> {state.message}</span>;
  if (state.phase === "error") return <span className="save-status err"><CircleAlert size={16} /> {state.message}</span>;
  return null;
}

export function RollbackDialog({ result, onClose }: { result: SaveResult; onClose: () => void }) {
  const rb = result.rollback!;
  const [left, setLeft] = useState(rb.seconds);
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, []);
  // same address (e.g. only the DNS changed): confirm from here
  const confirmHere = async () => {
    try {
      await api.confirmNetwork(rb.token);
      setConfirmed(true);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Modal title="Network change" onClose={onClose}>
      {confirmed ? (
        <p>The new network settings are kept.</p>
      ) : (
        <>
          <p>
            The network settings are being applied. If the VM cannot be reached at its new address and you do not
            confirm within <b>{left} seconds</b>, the previous settings come back automatically.
          </p>
          {rb.confirm_url ? (
            <p>
              Open the new address and confirm there (the browser warns once about the certificate):<br />
              <a className="btn primary" href={rb.confirm_url}>{rb.confirm_url.split("#")[0]}</a>
            </p>
          ) : (
            <p>With DHCP the new address is given by your DHCP server; it is shown on the VM's screen.</p>
          )}
          <p className="muted small">Still reachable at this address?</p>
          <button className="btn" onClick={confirmHere}>Keep the new settings</button>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Modal and toast
// ---------------------------------------------------------------------------
export function Modal({ title, onClose, children, actions }: {
  title: string; onClose: () => void; children: ReactNode; actions?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-wrap" role="dialog" aria-modal="true">
      <div className="scrim drawer-scrim" onClick={onClose} />
      <div className="modal">
        <div className="drawer-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={20} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>
  );
}

export function Confirm({ title, text, confirm, danger, onConfirm, onClose }: {
  title: string; text: ReactNode; confirm: string; danger?: boolean; onConfirm: () => void; onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose} actions={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className={`btn ${danger ? "danger" : "primary"}`} onClick={() => { onConfirm(); onClose(); }}>
          {confirm}
        </button>
      </>
    }>
      {text}
    </Modal>
  );
}

const ToastContext = createContext<(text: string, tone?: "ok" | "err") => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<{ id: number; text: string; tone: "ok" | "err" }[]>([]);
  const push = (text: string, tone: "ok" | "err" = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  };
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            {t.tone === "ok" ? <CircleCheck size={18} /> : <CircleAlert size={18} />} {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function errorText(e: unknown) {
  if (e instanceof ApiError || e instanceof Error) return e.message;
  return String(e);
}
