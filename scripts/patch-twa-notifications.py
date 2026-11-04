#!/usr/bin/env python3
import pathlib
import sys

if len(sys.argv) != 2:
    raise SystemExit("usage: patch-twa-notifications.py <bubblewrap-build-dir>")

root = pathlib.Path(sys.argv[1])
manifest = root / "app" / "src" / "main" / "AndroidManifest.xml"
if not manifest.exists():
    raise SystemExit(f"AndroidManifest.xml not found: {manifest}")

xml = manifest.read_text(encoding="utf-8")
permission = '<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>'
if permission not in xml:
    marker = "<application"
    if marker not in xml:
        raise SystemExit("Could not find <application in AndroidManifest.xml")
    xml = xml.replace(marker, permission + "\n\n" + marker, 1)
    manifest.write_text(xml, encoding="utf-8")

launchers = list((root / "app" / "src" / "main" / "java").rglob("LauncherActivity.java"))
if not launchers:
    raise SystemExit("LauncherActivity.java not found")
launcher = launchers[0]
java = launcher.read_text(encoding="utf-8")

if "ESHOP_NOTIFICATION_PERMISSION_REQUEST" not in java:
    import_marker = "import android.content.pm.ActivityInfo;\n"
    imports = (
        "import android.content.pm.ActivityInfo;\n"
        "import android.Manifest;\n"
        "import android.content.pm.PackageManager;\n"
    )
    if import_marker not in java:
        raise SystemExit("Could not patch LauncherActivity imports")
    java = java.replace(import_marker, imports, 1)

    create_marker = "super.onCreate(savedInstanceState);\n"
    native_prompt = """super.onCreate(savedInstanceState);

        // ESHOP_NOTIFICATION_PERMISSION_REQUEST
        // Android 13+ requires the app wrapper itself to grant POST_NOTIFICATIONS.
        // Relying only on Notification.requestPermission() inside the TWA is not
        // reliable across all TWA providers (notably alternative Chromium browsers).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(
                new String[]{Manifest.permission.POST_NOTIFICATIONS},
                7104
            );
        }
"""
    if create_marker not in java:
        raise SystemExit("Could not patch LauncherActivity.onCreate")
    java = java.replace(create_marker, native_prompt, 1)
    launcher.write_text(java, encoding="utf-8")

print(f"Patched notification permission: {manifest}")
print(f"Patched native notification prompt: {launcher}")
