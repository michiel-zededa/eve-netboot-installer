# shellcheck shell=sh
# EVE Netboot Installer appliance: open the menu when admin logs in
# (console, serial or SSH). "Command line" in the menu (exit code 10) opens a
# shell; leaving it with "exit" returns to the menu, "Log out" in the menu
# ends the session. Skipped for non-interactive shells.
if [ "$(id -un)" = admin ] && [ -t 0 ] && [ -z "${ENI_NO_MENU:-}" ] && [ -z "${ENI_IN_MENU:-}" ]; then
  export ENI_IN_MENU=1
  while sudo /usr/local/sbin/eve-netboot menu; [ $? -eq 10 ]; do
    ENI_NO_MENU=1 "${SHELL:-/bin/sh}" -i
  done
  logout 2>/dev/null || exit
fi
