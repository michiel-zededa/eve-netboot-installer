// The settings pages of the appliance, as field definitions. The same groups
// as the console menu (SECTIONS in eve-netboot); keys are those of
// /etc/eve-netboot/settings.env. Labels, help texts and option names are
// shared with the console: adm_f_<key>, adm_h_<key>, adm_o_<key>_<value>,
// adm_p_<key> (what an empty value means) in app/i18n/<lang>.json.
import type { SettingsInfo } from "./admin";
import type { Field, FieldType, Values } from "./forms";
import { has, type TFunc } from "./i18n";

export type SectionId = "network" | "server" | "mirror" | "bootmenu" | "defaults" | "share" | "access";

export interface Section {
  id: SectionId;
  fields: (info: SettingsInfo | null, t: TFunc) => Field[];
  warning?: string;   // key
  note?: string;      // key, after the section's text
}

const yes = (k: string) => (v: Values) => v[k] === "yes";
const isStatic = (v: Values) => v.NET_MODE === "static";

/** A field with its texts from the translations. */
function field(t: TFunc, key: string, type: FieldType, extra: Partial<Field> = {}): Field {
  const k = key.toLowerCase();
  const opt = (values: string[]): [string, string][] =>
    values.map((o) => [o, has(t, `adm_o_${k}_${o.toLowerCase()}`) ? t(`adm_o_${k}_${o.toLowerCase()}`) : o]);
  return {
    key,
    type,
    label: t(`adm_f_${k}`),
    help: has(t, `adm_h_${k}`) ? t(`adm_h_${k}`) : undefined,
    placeholder: has(t, `adm_p_${k}`) ? t(`adm_p_${k}`) : undefined,
    ...extra,
    options: extra.options ?? (extra.values ? opt(extra.values) : undefined),
  };
}

export const SECTIONS: Section[] = [
  {
    id: "network",
    note: "adm_sec_network_web",
    fields: (info, t) => [
      field(t, "NET_MODE", "select", { values: ["dhcp", "static"] }),
      field(t, "NET_ADDRESS", "text", { placeholder: "192.168.1.20/24", showIf: isStatic }),
      field(t, "NET_GATEWAY", "text", { placeholder: "192.168.1.1", showIf: isStatic }),
      field(t, "NET_DNS", "text", { placeholder: "192.168.1.1 1.1.1.1", showIf: isStatic }),
      field(t, "NET_INTERFACE", "select", {
        showIf: isStatic,
        options: [["", t("adm_o_net_interface_first")], ...(info?.network.interfaces ?? []).map((i): [string, string] =>
          [i.name, `${i.name} (${t("adm_now")} ${i.address})`])],
      }),
      field(t, "HOSTNAME", "text", { placeholder: "eve-netboot" }),
    ],
  },
  {
    id: "server",
    fields: (info, t) => [
      field(t, "SERVER_IP", "text", { placeholder: "auto",
        help: `${t("adm_h_server_ip")} (${t("adm_this_vm", { ip: info?.network.primary_ip || "?" })})` }),
      field(t, "HTTP_PORT", "number", { placeholder: "8080" }),
    ],
  },
  {
    id: "mirror",
    fields: (_info, t) => [
      field(t, "EVE_ARCHES", "checks", { values: ["amd64", "arm64"] }),
      field(t, "EVE_FLAVOURS", "checks", { values: ["kvm", "k"] }),
      field(t, "EVE_LTS_LINES", "number"),
      field(t, "ENI_SYNC_INTERVAL", "select", { values: ["86400", "43200", "604800", "0"] }),
      field(t, "EVE_GITHUB_REPO", "text", { placeholder: "lf-edge/eve" }),
      field(t, "ENI_GITHUB_TOKEN", "secret", { placeholder: t("adm_unchanged") }),
    ],
  },
  {
    id: "bootmenu",
    fields: (info, t) => [
      field(t, "ENI_LANGUAGE", "select", { options: info?.choices.languages ?? [["en", "English"]] }),
      field(t, "ENI_MENU_MODE", "select", { values: ["standalone", "chained"] }),
      field(t, "ENI_MENU_TIMEOUT", "number", { placeholder: "300" }),
      field(t, "ENI_IMPORT_LABEL", "text", { placeholder: "import share" }),
      field(t, "IPXE_ALIASES_X86_64", "text"),
      field(t, "IPXE_ALIASES_ARM64", "text"),
    ],
  },
  {
    id: "defaults",
    fields: (info, t) => [
      field(t, "EVE_DEFAULT_INSTALL_SERVER", "text"),
      field(t, "EVE_DEFAULT_SERIAL", "select", { values: info?.choices.serials ?? ["none"] }),
      field(t, "EVE_DEFAULT_INSTALL_DISK", "text"),
      field(t, "EVE_DEFAULT_PERSIST_DISK", "text"),
      field(t, "EVE_DEFAULT_REBOOT", "onezero"),
      field(t, "EVE_DEFAULT_SOFT_SERIAL", "onezero"),
      field(t, "EVE_DEFAULT_NUKE_ALL_DISKS", "onezero"),
      field(t, "EVE_DEFAULT_EXTRA_ARGS", "text", { wide: true }),
    ],
  },
  {
    id: "share",
    fields: (info, t) => [
      field(t, "SMB_IMPORT_SHARE", "yesno", {
        help: t("adm_h_smb_import_share", { ip: info?.network.primary_ip || location.hostname }),
      }),
      field(t, "SMB_PASSWORD", "secret", { showIf: yes("SMB_IMPORT_SHARE"),
        placeholder: info?.secrets.smb_password ? t("adm_unchanged") : t("adm_required") }),
    ],
  },
  {
    id: "access",
    warning: "adm_web_off_warning",
    fields: (_info, t) => [
      field(t, "WEB_ADMIN", "yesno", { help: undefined }),
      field(t, "WEB_ADMIN_PORT", "number", { placeholder: "8443" }),
      field(t, "SSH_PASSWORD_LOGIN", "yesno"),
      field(t, "ADMIN_SSH_KEYS", "textarea", { wide: true, placeholder: "ssh-ed25519 AAAA... you@laptop",
        help: t("adm_h_admin_ssh_keys_web") }),
      field(t, "TZ", "text", { placeholder: "UTC" }),
    ],
  },
];
