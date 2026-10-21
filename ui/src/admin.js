// Client of the VM appliance's management API (eve_netboot_web.py, HTTPS port
// 8443). On the PXE server's port 8080 there is no /api/: the UI is read-only.
export class ApiError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
// the language of the page: messages of the API come back in it
let language = "";
export function setApiLanguage(lang) {
    language = lang;
}
async function call(method, path, body) {
    const headers = {};
    if (method !== "GET")
        headers["X-ENI"] = "1";
    if (language)
        headers["X-ENI-Lang"] = language;
    if (body !== undefined)
        headers["Content-Type"] = "application/json";
    const r = await fetch(path, {
        method,
        headers,
        credentials: "same-origin",
        cache: "no-store",
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const ctype = r.headers.get("Content-Type") ?? "";
    const data = ctype.startsWith("application/json") ? await r.json() : await r.text();
    if (!r.ok)
        throw new ApiError(r.status, data?.error ?? `HTTP ${r.status}`);
    return data;
}
/** null when this is not the appliance's management port (plain PXE server). */
export async function getSession() {
    try {
        const r = await fetch("api/session", { credentials: "same-origin", cache: "no-store" });
        if (!r.ok || !(r.headers.get("Content-Type") ?? "").startsWith("application/json"))
            return null;
        const s = (await r.json());
        return s.appliance ? s : null;
    }
    catch {
        return null;
    }
}
export const api = {
    login: (password) => call("POST", "api/login", { password }),
    logout: () => call("POST", "api/logout", {}),
    settings: () => call("GET", "api/settings"),
    texts: (lang) => call("GET", `api/texts${lang ? `?lang=${lang}` : ""}`),
    save: (settings, secrets = {}) => call("POST", "api/settings", { settings, secrets }),
    setup: (settings, secrets) => call("POST", "api/setup", { settings, secrets }),
    job: (id) => call("GET", `api/jobs/${id}`),
    action: (name) => call("POST", `api/actions/${name}`, {}),
    logs: (source, lines) => call("GET", `api/logs?source=${source}&lines=${lines}`),
    importSettings: (from) => call("POST", "api/import", from),
    password: (current, next) => call("POST", "api/password", { current, new: next }),
    deleteImage: (file) => call("DELETE", `api/images?file=${encodeURIComponent(file)}`, {}),
    confirmNetwork: (token) => call("POST", "api/network/confirm", { token }),
    zededa: () => call("GET", "api/zededa"),
    zededaLogin: (login) => call("POST", "api/zededa/login", login),
    zededaLogout: () => call("POST", "api/zededa/logout", {}),
    zededaDelete: (macs) => call("POST", "api/zededa/delete", { macs }),
    zededaForget: (macs) => call("POST", "api/zededa/forget", { macs }),
    zededaImport: (text) => call("POST", "api/zededa/import", { text }),
    zededaStatus: (force = false) => call("GET", `api/zededa/status${force ? "?force=1" : ""}`),
    zededaMachines: (body) => call("POST", "api/zededa/machines", body),
};
/** Wait for a background task; onMessage gets every new progress line. */
export async function waitJob(id, onMessage) {
    for (;;) {
        let job;
        try {
            job = await api.job(id);
        }
        catch (e) {
            // the server may restart while applying (e.g. web port change): keep trying
            if (e instanceof ApiError)
                throw e;
            await new Promise((r) => setTimeout(r, 2000));
            continue;
        }
        onMessage?.(job.messages, job);
        if (job.state !== "running")
            return job;
        await new Promise((r) => setTimeout(r, 1000));
    }
}
/** Upload an ISO into the import folder, with progress (0..100). */
export function uploadIso(file, overwrite, onProgress, interrupted) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `api/upload?name=${encodeURIComponent(file.name)}${overwrite ? "&overwrite=1" : ""}`);
        xhr.setRequestHeader("X-ENI", "1");
        if (language)
            xhr.setRequestHeader("X-ENI-Lang", language);
        xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
        xhr.onload = () => {
            if (xhr.status === 200)
                return resolve();
            let msg = `HTTP ${xhr.status}`;
            try {
                msg = JSON.parse(xhr.responseText).error ?? msg;
            }
            catch {
                // not JSON
            }
            reject(new ApiError(xhr.status, msg));
        };
        xhr.onerror = () => reject(new ApiError(0, interrupted));
        xhr.send(file);
    });
}
