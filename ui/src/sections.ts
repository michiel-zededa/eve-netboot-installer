// The settings pages of the appliance, as field definitions. The same groups
// as the console menu; keys are those of /etc/eve-netboot/settings.env.
import type { SettingsInfo } from "./admin";
import type { Field } from "./forms";

export type SectionId = "network" | "server" | "mirror" | "bootmenu" | "defaults" | "share" | "access";

export interface Section {
  id: SectionId;
  title: string;
  text: string;
  fields: (info: SettingsInfo | null) => Field[];
  warning?: string;
}

const yes = (k: string) => (v: Record<string, string>) => v[k] === "yes";

export const SECTIONS: Section[] = [
  {
    id: "network",
    title: "Network",
    text: "How this VM gets its IP address. A changed address is rolled back automatically unless you confirm it within 2 minutes.",
    fields: (info) => [
      { key: "NET_MODE", label: "IP address", type: "select",
        options: [["dhcp", "Automatically (DHCP), recommended with a DHCP reservation"], ["static", "Fixed address (static)"]] },
      { key: "NET_ADDRESS", label: "Address with prefix length", type: "text", placeholder: "192.168.1.20/24",
        showIf: (v) => v.NET_MODE === "static" },
      { key: "NET_GATEWAY", label: "Default gateway", type: "text", placeholder: "192.168.1.1",
        help: "Empty for none (an isolated PXE network).", showIf: (v) => v.NET_MODE === "static" },
      { key: "NET_DNS", label: "DNS servers", type: "text", placeholder: "192.168.1.1 1.1.1.1",
        help: "Separated by spaces.", showIf: (v) => v.NET_MODE === "static" },
      { key: "NET_INTERFACE", label: "Network adapter", type: "select", showIf: (v) => v.NET_MODE === "static",
        options: [["", "The first one"], ...(info?.network.interfaces ?? []).map((i): [string, string] =>
          [i.name, `${i.name} (now ${i.address})`])],
        help: "Other adapters keep using DHCP." },
      { key: "HOSTNAME", label: "Host name", type: "text", placeholder: "eve-netboot" },
    ],
  },
  {
    id: "server",
    title: "Server address",
    text: "The address PXE clients use to reach this VM. It goes into the DHCP settings and the boot menu.",
    fields: (info) => [
      { key: "SERVER_IP", label: "Server address", type: "text", placeholder: "auto",
        help: `"auto" = this VM's own address (now ${info?.network.primary_ip || "?"}). ` +
          "Another IPv4 address only for NAT, port forwarding or several networks." },
      { key: "HTTP_PORT", label: "HTTP port (boot menu, files, status page)", type: "number", placeholder: "8080" },
    ],
  },
  {
    id: "mirror",
    title: "What to mirror",
    text: "Which EVE-OS releases this server downloads from GitHub and offers in the boot menu.",
    fields: () => [
      { key: "EVE_ARCHES", label: "Architectures", type: "checks", options: [["amd64", "x86_64 (Intel/AMD)"], ["arm64", "ARM 64-bit"]] },
      { key: "EVE_FLAVOURS", label: "Variants", type: "checks",
        options: [["kvm", "kvm, the standard variant"], ["k", "k, with Kubernetes (needs at least 8 GB RAM on the target)"]] },
      { key: "EVE_LTS_LINES", label: "LTS release lines", type: "number",
        help: "The newest patch of each of the newest lines; about 0.5 GB per line, architecture and variant." },
      { key: "ENI_SYNC_INTERVAL", label: "Check GitHub", type: "select",
        options: [["86400", "Every day"], ["43200", "Every 12 hours"], ["604800", "Every week"], ["0", "Only when the VM starts"]] },
      { key: "EVE_GITHUB_REPO", label: "Repository", type: "text", placeholder: "lf-edge/eve" },
      { key: "ENI_GITHUB_TOKEN", label: "GitHub token", type: "secret", placeholder: "unchanged",
        help: "Only when the anonymous GitHub API limit is hit (shared public IP). A fine-grained token without permissions." },
    ],
  },
  {
    id: "bootmenu",
    title: "Boot menu",
    text: "Language and behaviour of the iPXE menu the machines see.",
    fields: (info) => [
      { key: "ENI_LANGUAGE", label: "Language (boot menu and status page)", type: "select",
        options: info?.choices.languages ?? [["en", "English"]] },
      { key: "ENI_MENU_MODE", label: "Mode", type: "select",
        options: [["standalone", "Standalone: exit boots the local disk"], ["chained", "Chained: exit returns to the calling iPXE menu"]] },
      { key: "ENI_MENU_TIMEOUT", label: "Timeout in seconds", type: "number", placeholder: "300",
        help: "0 = wait for a choice. Empty = 300 standalone, 0 chained." },
      { key: "ENI_IMPORT_LABEL", label: "Name of the import folder in the menu", type: "text", placeholder: "import share" },
      { key: "IPXE_ALIASES_X86_64", label: "Extra boot file names (x86_64)", type: "text",
        help: "For a boot file name your DHCP server already hands out, e.g. ipxe.efi." },
      { key: "IPXE_ALIASES_ARM64", label: "Extra boot file names (arm64)", type: "text" },
    ],
  },
  {
    id: "defaults",
    title: "Installer defaults",
    text: "Pre-filled installation options in the boot menu; each can still be changed there before installing.",
    fields: (info) => [
      { key: "EVE_DEFAULT_INSTALL_SERVER", label: "Controller", type: "text", placeholder: "from the ISO",
        help: "e.g. zedcloud.zededa.net; empty = what is in the ISO / config.img." },
      { key: "EVE_DEFAULT_SERIAL", label: "Serial console", type: "select",
        options: (info?.choices.serials ?? ["none"]).map((s): [string, string] => [s, s === "none" ? "none (screen only)" : s]) },
      { key: "EVE_DEFAULT_INSTALL_DISK", label: "Installation disk", type: "text", placeholder: "automatic",
        help: "Kernel name without /dev/, e.g. sda or nvme0n1." },
      { key: "EVE_DEFAULT_PERSIST_DISK", label: "Persist disk(s)", type: "text", placeholder: "same as the installation disk",
        help: "Comma separated, e.g. sdb or sdb,sdc (several = ZFS)." },
      { key: "EVE_DEFAULT_REBOOT", label: "Reboot after installation", type: "onezero" },
      { key: "EVE_DEFAULT_SOFT_SERIAL", label: "Soft serial = MAC address", type: "onezero" },
      { key: "EVE_DEFAULT_NUKE_ALL_DISKS", label: "Wipe all disks", type: "onezero" },
      { key: "EVE_DEFAULT_EXTRA_ARGS", label: "Extra kernel parameters", type: "text", wide: true },
    ],
  },
  {
    id: "share",
    title: "Import share",
    text: "Share the folder for your own installer ISOs on the network (SMB), to copy ISOs from Windows or macOS. You can also upload them on the Images page.",
    fields: (info) => [
      { key: "SMB_IMPORT_SHARE", label: "Share the import folder as \\\\VM\\eve-import", type: "yesno" },
      { key: "SMB_PASSWORD", label: "Share password (user admin)", type: "secret", showIf: yes("SMB_IMPORT_SHARE"),
        placeholder: info?.secrets.smb_password ? "unchanged" : "required" },
    ],
  },
  {
    id: "access",
    title: "Access and system",
    text: "SSH, web management and time zone.",
    warning: "Switching web management off ends this session; it can be switched on again in the console menu (Advanced settings).",
    fields: () => [
      { key: "WEB_ADMIN", label: "Web management (this page)", type: "yesno" },
      { key: "WEB_ADMIN_PORT", label: "Web management port", type: "number", placeholder: "8443" },
      { key: "SSH_PASSWORD_LOGIN", label: "SSH login with the admin password", type: "yesno",
        help: "Login with an SSH key always works." },
      { key: "ADMIN_SSH_KEYS", label: "SSH public keys of admin", type: "textarea", wide: true,
        placeholder: "ssh-ed25519 AAAA... you@laptop", help: "One per line." },
      { key: "TZ", label: "Time zone", type: "text", placeholder: "UTC", help: "e.g. Europe/Amsterdam." },
    ],
  },
];
