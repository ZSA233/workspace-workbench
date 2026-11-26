# Cross-client attachment history

Paseo 0.17.1 and 0.17.3 send original images and uploaded-file references to the
provider, but `AgentManager.recordSubmittedPrompt` records only the text in the
shared user-message timeline. A sender can keep image previews in its local
attachment store while other clients, or a cold reload, have no image metadata.

The ordinary Workbench plugin repairs DingTalk/TAPD media placement and provides
one image/video/file viewer. `native-chat-media.mjs` is a separate, optional
native-host compatibility adapter for messages sent through any Paseo client,
including Pocket and Access Pocket. It runs on the receiving Paseo host; there
is no app-specific DOM injection, business-page bridge, Access gateway change,
or replacement image picker.

## Native boundary

The Node load hook accepts only the reviewed official `@getpaseo/server`
`agent-manager.js` bytes listed below. It adds an in-memory wrapper around
`recordSubmittedPrompt`; no installed Paseo file is rewritten. The original
method receives the original arguments and its result is returned unchanged.
The supervisor keeps the preload for replacement workers. The native daemon
worker removes only this adapter from its inherited `NODE_OPTIONS` before
loading application code; providers, terminals and project Node processes keep
the other original options and do not inherit this host compatibility hook.
After an accepted prompt, the adapter stores its images and attachment metadata
and appends one display-only plugin timeline item **after** the user message.
It never sends a message, starts a model, changes permissions, or retries a task.
Unrecognized host versions or source hashes retain the original implementation.

| Host | SHA-256 of agent-manager.js |
| --- | --- |
| 0.17.1 | `4a0b476db57826e52082731673cd11410fd3fee483eff6978b7ff6d03537c319` |
| 0.17.3 | `2a701fe04a6ff1861fbdac0532f6e0cd40267fe391a8a5bcee14c92da8e4a256` |

The adapter requires Node 22.18+ or Node 24. Workbench's base Node and Paseo
requirements are unchanged when this optional adapter is not activated.

## Storage and reads

`PASEO_HOME/workspace-workbench/chat-media` holds private immutable receipts,
content-addressed image originals, display receipts, topic-owner reservations,
and per-process startup evidence. Directories are private and files use mode
0600. Receipts are bound to both Agent ID and client message ID. Image reads
check selection membership, byte count and checksum; they cannot accept a path.
The model's original prompt and text are not copied into this store.

The per-message bounds are 20 media items, 8 MiB per image and 24 MiB of image
bytes. At most eight native captures run concurrently. A recording failure
cannot reject, replay or alter the already accepted model input.

Uploaded files retain their native upload identity, filename, size and modification
version. Only the fixed `PASEO_HOME/uploads/upload_UUID/filename` owner is eligible
for download; arbitrary prompt paths and symlinks are not read. Saving keeps the
legacy Pocket native writer and the browser file picker, both selected directly
from the click. Access Pocket uses the existing same-origin Access HTTP handoff.
Other browsers can download up to 24 MiB via a Blob. Direct writers and Blob
downloads use authenticated RPC reads in 128 KiB chunks, bound to the selected
file's version and checked by checksum. A failed Access handoff never starts a
second download. The server never returns a filesystem path to the UI.

Workbench reserves its frozen topic-material owner before dispatch, so the
native recorder does not duplicate its images. A display retry reads the same
receipt and cannot expand the selected material or repeat the task. Historical
topic rows placed before their messages receive an after-message replacement;
the original timeline identity and unknown data remain recorded.

## Activation

First stage and typecheck the immutable Workbench release, verify the target
Paseo server ID, Node version and reviewed native source hash, and exercise the
adapter in an isolated Paseo home. Add this release's **absolute file URL** to
the existing native Paseo service's `NODE_OPTIONS`, preserving other options:

```
--import=file:///absolute/workbench-release/server/native-chat-media.mjs
```

The adapter cannot enter an already running Node process. Activating it needs
the existing native Paseo service to restart using the same home, identity,
ports and configuration; plan this around active sessions. A plugin reload alone
activates the topic viewer changes but does not activate native capture.
Verify the new daemon worker PID against its fresh private `runtime` evidence,
then check plugin/RPC health. No new Paseo instance or project registry is needed.

Rollback removes only this option from the owned service definition and restarts
that service. Keep all receipt/image files and native session history. The
plugin continues to display previously recorded receipts without the adapter.
