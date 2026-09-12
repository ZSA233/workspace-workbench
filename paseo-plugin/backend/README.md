# Bundled Workbench backend

Release builds place a platform-specific executable at:

```text
backend/<platform>-<arch>/workspace-workbench
```

The Paseo server selects the matching executable and starts it with the project
configuration. The directory is intentionally kept free of checked-in build
outputs; use `scripts/build_backend.py` on the target platform or let the
release workflow produce the artifact.
