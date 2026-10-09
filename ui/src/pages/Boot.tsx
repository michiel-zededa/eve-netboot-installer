import { ExternalLink } from "lucide-react";
import { serverHost, type Status } from "../api";
import { Card, CopyField, KeyValues, PageHeader } from "../components";
import { useT } from "../i18n";

const LANGUAGES: Record<string, string> = {
  en: "English", de: "Deutsch", fr: "Français", es: "Español", pt: "Português",
  nl: "Nederlands", da: "Dansk", no: "Norsk",
};

export default function Boot({ status }: { status: Status | null }) {
  const t = useT();
  const cfg = status?.config;
  const host = serverHost(cfg);
  const d = cfg?.defaults ?? {};
  const onOff = (v: unknown) => (v === true || v === "1" ? t("ui_yes") : t("ui_no"));
  const timeout = cfg?.menu_timeout;

  return (
    <div className="page">
      <PageHeader title={t("ui_nav_boot")} subtitle={t("ui_boot_text")} />
      <div className="grid-2">
        <Card title={t("ui_dhcp_title")}>
          <p className="muted small">{t("ui_dhcp_text")}</p>
          <CopyField label={t("ui_next_server")} value={host} />
          <CopyField label={t("ui_boot_file")} value="eve-x86_64.efi" hint={t("ui_boot_file_x86")} />
          <CopyField label={t("ui_boot_file")} value="eve-arm64.efi" hint={t("ui_boot_file_arm")} />
        </Card>

        <Card title={t("ui_ipxe_menu")}>
          <KeyValues rows={[
            [t("ui_menu_language"), cfg ? LANGUAGES[cfg.language] ?? cfg.language : ""],
            [t("ui_menu_mode"), cfg ? (cfg.menu_mode === "chained" ? t("ui_mode_chained") : t("ui_mode_standalone")) : ""],
            [t("ui_menu_timeout"), timeout === undefined ? "" : timeout > 0
              ? t("ui_seconds", { n: timeout, target: cfg?.menu_mode === "chained" ? t("timeout_back") : t("timeout_local") })
              : t("ui_wait_forever")],
          ]} />
          {cfg && <CopyField label={t("ui_chain_url")} value={`${cfg.base_url}/eve/eve.ipxe`} />}
          <a className="btn" href="eve/eve.ipxe" target="_blank" rel="noreferrer">
            <ExternalLink size={16} /> eve.ipxe
          </a>
        </Card>

        <Card title={t("ui_defaults_title")}>
          <p className="muted small">{t("ui_defaults_text")}</p>
          <KeyValues rows={[
            [t("opt_server"), (d.server as string) || t("val_from_iso")],
            [t("opt_disk"), (d.disk as string) || t("val_auto")],
            [t("opt_persist"), (d.persist as string) || t("val_same_disk")],
            [t("opt_serial"), d.serial && d.serial !== "none" ? String(d.serial) : t("val_none")],
            [t("opt_reboot"), onOff(d.reboot)],
            [t("opt_soft"), onOff(d.softserial)],
            [t("opt_nuke"), onOff(d.nuke)],
            [t("opt_extra"), (d.extra as string) || "—"],
          ]} />
        </Card>

        <Card title={t("ui_mirror_title")}>
          <KeyValues rows={[
            [t("page_lts_lines"), cfg?.lts_lines],
            [t("page_arches"), cfg?.arches.join(", ")],
            [t("page_flavours"), cfg?.flavours.join(", ")],
            [t("ui_last_check_label"), status?.github_checked ?? t("ui_never")],
          ]} />
        </Card>
      </div>
    </div>
  );
}
