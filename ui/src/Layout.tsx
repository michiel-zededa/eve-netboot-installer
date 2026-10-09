import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Archive, ChevronDown, CloudDownload, Disc3, Download, FolderInput, HardDrive, House, KeyRound, Languages, Layers,
  LogOut, Menu, Monitor, Moon, Network, RefreshCw, ScrollText, Search, Server, Settings2, Share2, ShieldCheck, Sun,
  Wrench, X,
} from "lucide-react";
import type { Session } from "./admin";
import type { Status } from "./api";
import { href, type Route } from "./App";
import { useT } from "./i18n";
import { getTheme, setTheme, type Theme } from "./theme";

interface Props {
  route: Route;
  status: Status | null;
  search: string;
  onSearch: (q: string) => void;
  onRefresh: () => void;
  session?: Session | null;
  onLogout?: () => void;
  children: ReactNode;
}

export default function Layout({ route, status, search, onSearch, onRefresh, session, onLogout, children }: Props) {
  const t = useT();
  const [navOpen, setNavOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Ctrl/Cmd+K focuses the search, like the ZEDEDA UI
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => setNavOpen(false), [route]);

  const counts = { all: 0, github: 0, local: 0 };
  for (const e of status?.entries ?? []) {
    counts.all++;
    counts[e.source]++;
  }
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <div className="shell">
      <header className="topbar">
        <button className="icon-btn nav-toggle" aria-label="Menu" onClick={() => setNavOpen(!navOpen)}>
          {navOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
        <a className="brand" href="#/" aria-label="ZEDEDA">
          <span className="logo" />
        </a>
        <div className="product">EVE-Netboot-Installer</div>
        <label className="search">
          <Search size={18} />
          <input
            ref={searchRef}
            value={search}
            placeholder={t("ui_search")}
            onChange={(e) => onSearch(e.target.value)}
          />
          <kbd>{isMac ? "⌘K" : "Ctrl K"}</kbd>
        </label>
        <div className="top-actions">
          {!session && status?.config.admin_url && (
            <a className="btn slim manage" href={status.config.admin_url}>
              <Settings2 size={16} /> <span>{t("ui_manage")}</span>
            </a>
          )}
          <button className="icon-btn" title={t("ui_refresh")} aria-label={t("ui_refresh")} onClick={onRefresh}>
            <RefreshCw size={19} />
          </button>
          <ThemeMenu />
          {session?.authenticated && <UserMenu hostname={session.hostname} version={session.version} onLogout={onLogout} />}
        </div>
      </header>

      <aside className={`sidebar${navOpen ? " open" : ""}`}>
        <div className="side-head">
          <h2>{t("ui_side_title")}</h2>
          <p>{t("ui_side_subtitle")}</p>
        </div>
        <nav>
          <NavItem to={{ page: "home" }} route={route} icon={<House size={20} />} label={t("ui_nav_home")} />
          <NavGroup label={t("ui_section_images")}>
            <NavItem to={{ page: "images", tab: "all" }} route={route} icon={<Layers size={20} />}
              label={t("ui_nav_all")} count={counts.all} />
            <NavItem to={{ page: "images", tab: "github" }} route={route} icon={<CloudDownload size={20} />}
              label={t("ui_nav_github")} count={counts.github} />
            <NavItem to={{ page: "images", tab: "local" }} route={route} icon={<FolderInput size={20} />}
              label={t("ui_nav_local")} count={counts.local} />
          </NavGroup>
          <NavGroup label={t("ui_section_network_boot")}>
            <NavItem to={{ page: "boot" }} route={route} icon={<Network size={20} />} label={t("ui_nav_boot")} />
            <a className="nav-item" href="eve/" target="_blank" rel="noreferrer">
              <Disc3 size={20} />
              <span>{t("ui_nav_files")}</span>
            </a>
          </NavGroup>
          {session?.authenticated && (
            <>
              <NavGroup label="Settings">
                <NavItem to={{ page: "settings", section: "network" }} route={route} icon={<Network size={20} />} label="Network" />
                <NavItem to={{ page: "settings", section: "server" }} route={route} icon={<Server size={20} />} label="Server address" />
                <NavItem to={{ page: "settings", section: "mirror" }} route={route} icon={<CloudDownload size={20} />} label="What to mirror" />
                <NavItem to={{ page: "settings", section: "bootmenu" }} route={route} icon={<Languages size={20} />} label="Boot menu" />
                <NavItem to={{ page: "settings", section: "defaults" }} route={route} icon={<HardDrive size={20} />} label="Installer defaults" />
                <NavItem to={{ page: "settings", section: "share" }} route={route} icon={<Share2 size={20} />} label="Import share" />
                <NavItem to={{ page: "settings", section: "access" }} route={route} icon={<ShieldCheck size={20} />} label="Access and system" />
              </NavGroup>
              <NavGroup label="Maintenance">
                <NavItem to={{ page: "logs" }} route={route} icon={<ScrollText size={20} />} label="Logs" />
                <NavItem to={{ page: "updates" }} route={route} icon={<Download size={20} />} label="Updates" />
                <NavItem to={{ page: "backup" }} route={route} icon={<Archive size={20} />} label="Backup and restore" />
                <NavItem to={{ page: "system" }} route={route} icon={<Wrench size={20} />} label="System" />
              </NavGroup>
            </>
          )}
        </nav>
        <div className="side-foot">
          {status?.config.version ? t("ui_version", { v: status.config.version }) : "EVE-Netboot-Installer"}
        </div>
      </aside>
      {navOpen && <div className="scrim" onClick={() => setNavOpen(false)} />}

      <main className="main">{children}</main>
    </div>
  );
}

function sameRoute(a: Route, b: Route) {
  if (a.page !== b.page) return false;
  if (a.page === "images" && b.page === "images") return a.tab === b.tab;
  if (a.page === "settings" && b.page === "settings") return a.section === b.section;
  return true;
}

function UserMenu({ hostname, version, onLogout }: { hostname: string; version: string; onLogout?: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="avatar" aria-label="Account" aria-expanded={open} onClick={() => setOpen(!open)}>AD</button>
      {open && (
        <div className="menu account" role="menu">
          <div className="account-head">
            <span className="avatar big">AD</span>
            <div>
              <strong>admin</strong>
              <div className="muted small">{hostname}</div>
            </div>
          </div>
          <a className="menu-item" href="#/system" onClick={() => setOpen(false)}><KeyRound size={17} /> <span>Change password</span></a>
          <button className="menu-item danger" onClick={() => { setOpen(false); onLogout?.(); }}>
            <LogOut size={17} /> <span>Sign out</span>
          </button>
          <div className="menu-foot">Appliance version ( {version} )</div>
        </div>
      )}
    </div>
  );
}

function NavItem(props: { to: Route; route: Route; icon: ReactNode; label: string; count?: number }) {
  const active = sameRoute(props.to, props.route);
  return (
    <a className={`nav-item${active ? " active" : ""}`} href={href(props.to)} aria-current={active ? "page" : undefined}>
      {props.icon}
      <span>{props.label}</span>
      {props.count !== undefined && <span className="nav-count">{props.count}</span>}
    </a>
  );
}

function NavGroup({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="nav-group">
      <button className="nav-group-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>{label}</span>
        <ChevronDown size={16} className={open ? "" : "rot"} />
      </button>
      {open && children}
    </div>
  );
}

function ThemeMenu() {
  const t = useT();
  const [theme, setThemeState] = useState<Theme>(getTheme);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const choose = (v: Theme) => {
    setTheme(v);
    setThemeState(v);
    setOpen(false);
  };
  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  const options: [Theme, typeof Sun, string][] = [
    ["light", Sun, t("ui_theme_light")],
    ["dark", Moon, t("ui_theme_dark")],
    ["system", Monitor, t("ui_theme_system")],
  ];

  return (
    <div className="menu-wrap" ref={ref}>
      <button className="icon-btn" title={t("ui_theme")} aria-label={t("ui_theme")} aria-expanded={open}
        onClick={() => setOpen(!open)}>
        <Icon size={19} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-title">{t("ui_theme")}</div>
          {options.map(([v, I, label]) => (
            <button key={v} role="menuitemradio" aria-checked={theme === v}
              className={`menu-item${theme === v ? " checked" : ""}`} onClick={() => choose(v)}>
              <I size={17} />
              <span>{label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
