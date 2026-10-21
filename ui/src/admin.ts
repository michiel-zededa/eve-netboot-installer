// Client of the VM appliance's management API (eve_netboot_web.py, HTTPS port
// 8443). On the PXE server's port 8080 there is no /api/: the UI is read-only.

export interface Session {
  appliance: true;
  version: string;
  hostname: string;
  configured: boolean;
  authenticated: boolean;
  web_admin: boolean;
  language: string;
  job: Job | null;
  rollback?: { seconds_left: number };
}

export interface Job {
  id: string;
  kind: string;
  state: "running" | "done" | "failed";
  messages: string[];
  result: unknown;
  // updates: how far the job is (percent of the whole) and what it is doing now
  progress?: { percent: number; detail: string } | null;
}

export interface SettingsInfo {
  settings: Record<string, string>;
  defaults: Record<string, string>;
  secrets: { admin_password: boolean; smb_password: boolean; github_token: boolean };
  network: { interfaces: { name: string; address: string }[]; primary_ip: string; primary_interface: string };
  choices: { languages: [string, string][]; serials: string[] };
  dhcp?: Record<string, string>;
  image: string;
}

export interface SaveResult {
  job: string;
  rollback?: { seconds: number; confirm_url: string | null; token: string };
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// the language of the page: messages of the API come back in it
let language = "";
export function setApiLanguage(lang: string) {
  language = lang;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["X-ENI"] = "1";
  if (language) headers["X-ENI-Lang"] = language;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    cache: "no-store",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ctype = r.headers.get("Content-Type") ?? "";
  const data = ctype.startsWith("application/json") ? await r.json() : await r.text();
  if (!r.ok) throw new ApiError(r.status, (data as { error?: string })?.error ?? `HTTP ${r.status}`);
  return data as T;
}

/** null when this is not the appliance's management port (plain PXE server). */
export async function getSession(): Promise<Session | null> {
  try {
    const r = await fetch("api/session", { credentials: "same-origin", cache: "no-store" });
    if (!r.ok || !(r.headers.get("Content-Type") ?? "").startsWith("application/json")) return null;
    const s = (await r.json()) as Session;
    return s.appliance ? s : null;
  } catch {
    return null;
  }
}

export const api = {
  login: (password: string) => call<{ ok: true }>("POST", "api/login", { password }),
  logout: () => call<{ ok: true }>("POST", "api/logout", {}),
  settings: () => call<SettingsInfo>("GET", "api/settings"),
  texts: (lang?: string) =>
    call<{ language: string; texts: Record<string, string> }>("GET", `api/texts${lang ? `?lang=${lang}` : ""}`),
  save: (settings: Record<string, string | null>, secrets: Record<string, string> = {}) =>
    call<SaveResult>("POST", "api/settings", { settings, secrets }),
  setup: (settings: Record<string, string | null>, secrets: Record<string, string>) =>
    call<{ job: string }>("POST", "api/setup", { settings, secrets }),
  job: (id: string) => call<Job>("GET", `api/jobs/${id}`),
  action: (name: string) => call<{ ok?: true; job?: string }>("POST", `api/actions/${name}`, {}),
  logs: (source: string, lines: number) => call<string>("GET", `api/logs?source=${source}&lines=${lines}`),
  importSettings: (from: { url?: string; text?: string }) =>
    call<{ settings: Record<string, string> }>("POST", "api/import", from),
  password: (current: string, next: string) => call<{ ok: true }>("POST", "api/password", { current, new: next }),
  deleteImage: (file: string) => call<{ ok: true }>("DELETE", `api/images?file=${encodeURIComponent(file)}`, {}),
  confirmNetwork: (token: string) => call<{ ok: true }>("POST", "api/network/confirm", { token }),
  zededa: () => call<ZededaInfo>("GET", "api/zededa"),
  zededaLogin: (login: { password?: string; token?: string }) =>
    call<ZededaInfo & { warning: string }>("POST", "api/zededa/login", login),
  zededaLogout: () => call<{ ok: true }>("POST", "api/zededa/logout", {}),
  zededaDelete: (macs: string[]) =>
    call<{ ok: boolean; deleted: string[]; failed: { mac: string; name: string; error: string }[] }>(
      "POST", "api/zededa/delete", { macs }),
  zededaForget: (macs: string[]) => call<{ ok: true; removed: number }>("POST", "api/zededa/forget", { macs }),
  zededaImport: (text: string) =>
    call<ZededaInfo & { imported: number; skipped: number }>("POST", "api/zededa/import", { text }),
  zededaStatus: (force = false) => call<ZededaInfo>("GET", `api/zededa/status${force ? "?force=1" : ""}`),
  zededaMachines: (body: { text: string } | { clear: true }) =>
    call<ZededaInfo & { count?: number }>("POST", "api/zededa/machines", body),
};

/** ZEDEDA onboarding: the session lives in the appliance's memory only. */
export interface ZededaInfo {
  enabled: boolean;
  cluster: string;
  enterprise: string;
  user: string;
  login: "token" | "password";
  project: string;
  node_name: string;      // the naming convention
  session: null | {
    user: string;
    enterprise: string;
    cluster: string;
    via: "password" | "token";
    since: number;
    expires: number | null;
    project_id: string;
  };
  // the machine list: name and project planned per machine (by MAC address or hardware serial)
  machines: {
    mac: string;
    hardware_serial: string;
    name: string;
    project: string;
    node: null | { name: string; mac: string; result: string; state: string };
  }[];
  onboarded: {
    mac: string;
    name: string;
    node_id: string;
    project: string;
    hardware_serial: string;
    product: string;
    result: "created" | "exists" | "failed" | "deleted";
    online_since?: number;
    status?: {
      state: "waiting" | "starting" | "online" | "offline" | "error" | "gone" | "noread" | "unknown";
      run_state?: string;
      last_seen?: string;
      eve?: string;
      error?: string;
    };
    message: string;
    time: number;
  }[];
}

/** Wait for a background task; onMessage gets every new progress line. */
export async function waitJob(id: string, onMessage?: (msgs: string[], job: Job) => void): Promise<Job> {
  for (;;) {
    let job: Job;
    try {
      job = await api.job(id);
    } catch (e) {
      // the server may restart while applying (e.g. web port change): keep trying
      if (e instanceof ApiError) throw e;
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    onMessage?.(job.messages, job);
    if (job.state !== "running") return job;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Upload an ISO into the import folder, with progress (0..100). */
export function uploadIso(file: File, overwrite: boolean, onProgress: (pct: number) => void,
  interrupted: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `api/upload?name=${encodeURIComponent(file.name)}${overwrite ? "&overwrite=1" : ""}`);
    xhr.setRequestHeader("X-ENI", "1");
    if (language) xhr.setRequestHeader("X-ENI-Lang", language);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      if (xhr.status === 200) return resolve();
      let msg = `HTTP ${xhr.status}`;
      try {
        msg = JSON.parse(xhr.responseText).error ?? msg;
      } catch {
        // not JSON
      }
      reject(new ApiError(xhr.status, msg));
    };
    xhr.onerror = () => reject(new ApiError(0, interrupted));
    xhr.send(file);
  });
}
