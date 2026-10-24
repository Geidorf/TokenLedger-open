#!/usr/bin/env python3
"""Minimal org.kde.StatusNotifierWatcher for the Linux package smoke test.

CI runs under Xvfb with a private D-Bus session bus and no desktop shell, so
nothing would host a tray icon. This script plays the part of the panel: it
owns the watcher name, answers the properties libayatana-appindicator asks
for, and appends every RegisterStatusNotifierItem call to the file given as
the first argument. The smoke script then checks that the app registered.

Needs python3-gi (PyGObject) and a session bus (dbus-run-session).
"""

import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

WATCHER_NAME = "org.kde.StatusNotifierWatcher"
WATCHER_PATH = "/StatusNotifierWatcher"
INTROSPECTION = """
<node>
  <interface name="org.kde.StatusNotifierWatcher">
    <method name="RegisterStatusNotifierItem">
      <arg type="s" name="service" direction="in"/>
    </method>
    <method name="RegisterStatusNotifierHost">
      <arg type="s" name="service" direction="in"/>
    </method>
    <property name="RegisteredStatusNotifierItems" type="as" access="read"/>
    <property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
    <property name="ProtocolVersion" type="i" access="read"/>
    <signal name="StatusNotifierItemRegistered">
      <arg type="s" name="service"/>
    </signal>
    <signal name="StatusNotifierItemUnregistered">
      <arg type="s" name="service"/>
    </signal>
    <signal name="StatusNotifierHostRegistered"/>
  </interface>
</node>
"""

items = []


def main():
    if len(sys.argv) != 2:
        print("usage: linux-tray-watcher.py <registrations-file>", file=sys.stderr)
        return 2
    out_path = sys.argv[1]
    node = Gio.DBusNodeInfo.new_for_xml(INTROSPECTION)
    loop = GLib.MainLoop()

    def on_call(connection, sender, path, interface, method, params, invocation):
        if method == "RegisterStatusNotifierItem":
            service = params.unpack()[0]
            # A bare object path means "this path on the caller's unique name".
            item = f"{sender}{service}" if service.startswith("/") else service
            items.append(item)
            with open(out_path, "a", encoding="utf-8") as handle:
                handle.write(item + "\n")
            connection.emit_signal(
                None,
                WATCHER_PATH,
                WATCHER_NAME,
                "StatusNotifierItemRegistered",
                GLib.Variant("(s)", (item,)),
            )
        invocation.return_value(None)

    def on_get_property(connection, sender, path, interface, name):
        if name == "RegisteredStatusNotifierItems":
            return GLib.Variant("as", items)
        if name == "IsStatusNotifierHostRegistered":
            return GLib.Variant("b", True)
        if name == "ProtocolVersion":
            return GLib.Variant("i", 0)
        return None

    def on_bus_acquired(connection, name):
        connection.register_object(
            WATCHER_PATH, node.interfaces[0], on_call, on_get_property, None
        )

    def on_name_lost(connection, name):
        print(f"could not own {WATCHER_NAME}", file=sys.stderr)
        loop.quit()

    Gio.bus_own_name(
        Gio.BusType.SESSION,
        WATCHER_NAME,
        Gio.BusNameOwnerFlags.NONE,
        on_bus_acquired,
        None,
        on_name_lost,
    )
    loop.run()
    return 1


if __name__ == "__main__":
    sys.exit(main())
