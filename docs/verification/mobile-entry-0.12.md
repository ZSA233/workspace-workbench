# Mobile plugin entry points in Paseo 0.12.0

The plugin already registers Workbench Explorer panels and a global sidebar
entry. The compact host does not render the desktop plugin header-button area,
and its right Explorer builds a fixed Files/Changes/PR tab list without reading
plugin panel registrations. Removing the plugin's Android background workspace
subscription guard would not add a visible mobile button or right-hand tab.

The supported mobile entry is the left global menu → Workspace Workbench. It
opens on user request and retains the existing lazy workspace loading behavior.
A fixed Workbench tab beside Files requires a Paseo host extension. Adding a
workspace location to the plugin alone cannot supply that right-hand tab.

Actual-host evidence on 2026-10-23 used an isolated Paseo home, registry and
temporary repositories with Chromium at 390×844:

- The left menu opened the actual plugin surface; repositories, commits and
  clean Diff data loaded.
- The workspace header and compact menu had no Workbench entry.
- The right Explorer displayed Files and its real directory contents, with no
  Workbench tab.
- No page errors or console warnings/errors. The isolated host exited 0 and
  removed its temporary fixture, workers and sockets.

Browser runtime reported “No browser is available” with an empty browser list;
the repository's isolated Playwright fallback supplied this evidence. This is
mobile-width web evidence, not Android native or physical-device acceptance.
No plugin registration change was made solely to hide the host limitation.

Verified upstream sources:

- [Fixed compact Explorer tabs](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/app/src/components/compact-explorer-sidebar.tsx#L350-L403).
- [Compact header menu](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/app/src/screens/workspace/workspace-header-menu.tsx#L207-L309).
- [Mobile tab switcher](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/app/src/screens/workspace/compact-workspace-header/tab-switcher.tsx#L347-L369).
- [Desktop plugin panel launcher](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/app/src/workspace-tabs/launcher/index.tsx#L201-L226).
