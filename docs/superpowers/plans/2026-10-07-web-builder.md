# Local construction console

Expose the existing strict physical builder through a loopback-only web page.
The page accepts an origin, a dropped `.litematic` or `.schem` file, and 1–30
workers. It targets Minecraft 1.21.11 at 127.0.0.1:25566. Schematic inspection
precedes construction; the existing global layer barriers remain authoritative.

## Components

- `web/`: dependency-free Chinese UI with upload, origin translation, worker
  controls, live status, bounded logs and graceful cancellation.
- `lib/webBuildManager.js`: private uploads, isolated inspection, one active
  builder child, automatic server attachment and verified terminal results.
- `scripts/web-server.js`: local static assets and bounded JSON/raw upload APIs,
  same-origin mutation protection, fixed target and graceful shutdown.

The server never freezes or restarts the Minecraft world automatically. Existing
mechanism preconditions remain enforced and errors appear in the page. Temporary
uploads, profiles and reports remain under ignored `.runtime/`.

## Acceptance

1. Upload and inspect both supported file types; reject malformed input.
2. Validate worker counts, coordinate bounds, source-origin translation and
   cannon alignment. Start only one job; stop waits for workers to exit.
3. Reloading the page recovers the running job. Progress is based on real builder
   reports; an unsuccessful process cannot appear as a completed build.
4. Exercise HTTP and process lifecycle tests, then use the browser to upload a
   small schematic and construct it on the live target server. Audit the actual
   placement events for bottom-up layer order.
5. Open the page for the user, retain its local server, and synchronize source
   and documentation to the existing public repository without runtime data.
