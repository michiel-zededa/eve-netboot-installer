// Data the sync service writes into the web root (see app/eve_sync.py:
// write_menus and write_activity). Everything is read-only here.

export interface Entry {
  path: string;
  source: "github" | "local";
  tag?: string | null;
  file?: string | null;
  name?: string | null;
  arch?: string | null;
  variant?: string | null;
  flavour?: string | null;
  iso_size?: number | null;
  sha256?: string | null;
  sha256_verified?: boolean | null;
  netboot_ok?: boolean | null;
  error?: string | null;
  published?: string | null;
  mtime?: string | null;
  prepared?: string | null;
  ucode?: boolean | null;
  config_img?: boolean | null;
  args?: string | null;
  console?: string | null;
  label?: string | null;
  release?: string | null;   // local ISOs: the EVE-OS version from the ISO itself
}

export interface Config {
  arches: string[];
  flavours: string[];
  lts_lines: number;
  base_url: string;
  language: string;
  menu_mode: string;
  menu_timeout?: number;
  sync_interval?: number;
  import_label?: string;
  defaults?: Record<string, string | boolean>;
  version?: string;
  admin_url?: string;
  dhcp_mode?: "off" | "proxy" | "server";   // the VM's own DHCP service
}

export interface Status {
  updated?: string;
  github_checked?: string | null;
  config: Config;
  entries: Entry[];
}

export interface Activity {
  state: "idle" | "downloading" | "importing";
  item?: string;
  done_mb?: number;
  total_mb?: number;
  percent?: number;
  disk?: { total_gb: number; free_gb: number; used_gb: number };
  next_github_check?: string | null;
  updated?: string;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export const loadStatus = () => getJson<Status>("eve/status.json");
export const loadActivity = () => getJson<Activity>("eve/activity.json");
export const loadTexts = () => getJson<{ language: string; texts: Record<string, string> }>("eve/ui.json");

// ---- helpers shared by the pages

export type ImageState = "ready" | "not_netboot" | "error";

export function imageState(e: Entry): ImageState {
  if (e.error) return "error";
  return e.netboot_ok ? "ready" : "not_netboot";
}

export function imageName(e: Entry): string {
  return (e.source === "github" ? e.tag : e.release || e.file || e.name) || e.path;
}

/** The file name of a local ISO when its name shows the version instead. */
export function imageFile(e: Entry): string {
  return e.source === "local" && e.release ? e.file || e.name || "" : "";
}

export function imageDate(e: Entry): string {
  return (e.source === "github" ? e.published : e.mtime) || "";
}

export function formatSize(bytes?: number | null): string {
  if (!bytes) return "";
  const mb = bytes / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

export function serverHost(cfg?: Config): string {
  if (!cfg?.base_url) return location.hostname;
  try {
    return new URL(cfg.base_url).hostname;
  } catch {
    return location.hostname;
  }
}

/** The VM's own DHCP service (off on a plain Docker Compose server). */
export function dhcpMode(status: Status | null): "off" | "proxy" | "server" {
  return status?.config.dhcp_mode ?? "off";
}

export const DHCP_TEXT = { off: "ui_dhcp_text", proxy: "ui_dhcp_text_proxy", server: "ui_dhcp_text_server" } as const;
