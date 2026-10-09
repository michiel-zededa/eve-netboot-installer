import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy, X } from "lucide-react";
import type { ImageState } from "./api";
import { useT } from "./i18n";

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {children && <div className="page-head-actions">{children}</div>}
    </div>
  );
}

/** Big-number tile, like ONLINE / SUSPECT / NODES in the ZEDEDA dashboard. */
export function StatCard(props: {
  value: ReactNode; label: string; icon: ReactNode; tone?: "ok" | "warn" | "err" | "accent";
  badge?: string; href?: string;
}) {
  const body = (
    <>
      <div className="stat-top">
        <span className={`stat-icon ${props.tone ?? ""}`}>{props.icon}</span>
        {props.badge && <span className={`stat-badge ${props.tone ?? ""}`}>{props.badge}</span>}
      </div>
      <div className={`stat-value ${props.tone ?? ""}`}>{props.value}</div>
      <div className="stat-label">{props.label}</div>
      <span className="stat-ghost" aria-hidden>{props.icon}</span>
    </>
  );
  return props.href ? <a className="card stat" href={props.href}>{body}</a> : <div className="card stat">{body}</div>;
}

export function Card({ title, actions, children, className }: {
  title?: string; actions?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={`card ${className ?? ""}`}>
      {title && (
        <div className="card-head">
          <h3>{title}</h3>
          {actions}
        </div>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

const PILL_TONE: Record<ImageState, string> = { ready: "ok", not_netboot: "warn", error: "err" };
const PILL_KEY: Record<ImageState, string> = {
  ready: "ui_pill_ready", not_netboot: "ui_pill_not_netboot", error: "ui_pill_error",
};

export function StatePill({ state }: { state: ImageState }) {
  const t = useT();
  return <span className={`pill ${PILL_TONE[state]}`}>{t(PILL_KEY[state])}</span>;
}

export function Pill({ tone, children }: { tone: "ok" | "warn" | "err" | "info" | "neutral"; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

/** Ring chart with "ready/total" in the middle (FLEET HEALTH in the ZEDEDA UI). */
export function Donut({ parts, center, sub }: {
  parts: { value: number; tone: "ok" | "warn" | "err" }[]; center: string; sub: string;
}) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const r = 70;
  const c = 2 * Math.PI * r;
  const gap = total > 1 ? 4 : 0;
  let offset = 0;
  return (
    <div className="donut">
      <svg viewBox="0 0 180 180" role="img" aria-label={`${center} ${sub}`}>
        <circle cx="90" cy="90" r={r} className="donut-track" />
        {total > 0 &&
          parts.filter((p) => p.value > 0).map((p, i) => {
            const len = (p.value / total) * c;
            const el = (
              <circle key={i} cx="90" cy="90" r={r} className={`donut-seg ${p.tone}`}
                strokeDasharray={`${Math.max(len - gap, 0.5)} ${c}`} strokeDashoffset={-offset}
                transform="rotate(-90 90 90)" />
            );
            offset += len;
            return el;
          })}
      </svg>
      <div className="donut-center">
        <strong>{center}</strong>
        <span>{sub}</span>
      </div>
    </div>
  );
}

export function CopyField({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // http pages without clipboard access: select the text instead
      const range = document.createRange();
      const el = document.getElementById(`cf-${label}`);
      if (el) {
        range.selectNodeContents(el);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
      }
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="copy-field">
      <div className="kv-label">{label}</div>
      <div className="copy-row">
        <code id={`cf-${label}`}>{value}</code>
        {hint && <span className="muted small">{hint}</span>}
        <button className="icon-btn small" onClick={copy} title={t("ui_copy")} aria-label={t("ui_copy")}>
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
      </div>
    </div>
  );
}

export function KeyValues({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => (
        <div key={k} className="kv-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Drawer({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="scrim drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true">
        <div className="drawer-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t("ui_close")}>
            <X size={20} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </>
  );
}

export function Empty({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="empty">
      {icon}
      <p>{text}</p>
    </div>
  );
}
