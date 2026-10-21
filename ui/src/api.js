// Data the sync service writes into the web root (see app/eve_sync.py:
// write_menus and write_activity). Everything is read-only here.
async function getJson(url) {
    try {
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok)
            return null;
        return (await r.json());
    }
    catch {
        return null;
    }
}
export const loadStatus = () => getJson("eve/status.json");
export const loadActivity = () => getJson("eve/activity.json");
export const loadTexts = () => getJson("eve/ui.json");
export function imageState(e) {
    if (e.error)
        return "error";
    return e.netboot_ok ? "ready" : "not_netboot";
}
export function imageName(e) {
    return (e.source === "github" ? e.tag : e.release || e.file || e.name) || e.path;
}
/** The file name of a local ISO when its name shows the version instead. */
export function imageFile(e) {
    return e.source === "local" && e.release ? e.file || e.name || "" : "";
}
export function imageDate(e) {
    return (e.source === "github" ? e.published : e.mtime) || "";
}
export function formatSize(bytes) {
    if (!bytes)
        return "";
    const mb = bytes / 1048576;
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
export function serverHost(cfg) {
    if (!cfg?.base_url)
        return location.hostname;
    try {
        return new URL(cfg.base_url).hostname;
    }
    catch {
        return location.hostname;
    }
}
/** The VM's own DHCP service (off on a plain Docker Compose server). */
export function dhcpMode(status) {
    return status?.config.dhcp_mode ?? "off";
}
export const DHCP_TEXT = { off: "ui_dhcp_text", proxy: "ui_dhcp_text_proxy", server: "ui_dhcp_text_server" };
