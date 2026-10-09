# shellcheck shell=sh
# EVE Netboot Installer appliance: open the menu when admin logs in
# (console, serial or SSH). "Command line" in the menu leaves it; type
# "eve-netboot menu" to return. Skipped for non-interactive shells.
if [ "$(id -un)" = admin ] && [ -t 0 ] && [ -z "${ENI_NO_MENU:-}" ] && [ -z "${ENI_IN_MENU:-}" ]; then
  export ENI_IN_MENU=1
  sudo /usr/local/sbin/eve-netboot menu
  [ $? -eq 10 ] || logout 2>/dev/null || exit
fi
