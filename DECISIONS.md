# Design decisions

Decisions taken while building ObjectLens without asking. Each lists the choice, why, and what we
could do instead. Entries marked ⚠️ are the ones most worth reviewing together.

## Scope & architecture

### D1. A local tool without login ⚠️

- **Choice:** no authentication at all. ObjectLens listens on `127.0.0.1` by default and logs a
  warning when `LISTEN_HOST` is anything else. (OIDC was planned at first and dropped on your
  request: the tool is not meant to be exposed.)
- **What still protects it:** any web page open in your browser can send requests to
  `localhost`, so two guards stay (`src/server/guard.ts`):
  - a **Host allow-list** against DNS rebinding (`localhost`, `127.0.0.1`, `[::1]`, the listen
    address, `ALLOWED_HOSTS`);
  - a **CSRF guard** on every change: same-origin by Fetch Metadata or `Origin`, plus a custom
    `X-ObjectLens` header that HTML forms on other sites cannot send.
- **Alternatives:** a shared password or token (simple, but one more secret), or OIDC as in
  MailWatch if ObjectLens should ever run for a team; the auth code would slot in front of the
  API as a middleware.

### D2. The server talks to S3, the browser only to ObjectLens

- **Choice:** every S3 request, including uploads and downloads, goes through the Node server.
  Transfers are streamed, never buffered (multipart uploads via `@aws-sdk/lib-storage`, range
  requests for downloads, so video seeking works).
- **Why:** credentials never reach the browser; buckets need no CORS configuration; endpoints
  that only the machine running ObjectLens can reach work; the guards and capability tracking
  see every request.
- **Cost:** transfer throughput is limited by this process (fine on a local machine). Node's
  5-minute request timeout is switched off so that large transfers are not cut.
- **Alternative:** presigned URLs for direct browser ↔ S3 transfers of large files (needs CORS
  on each bucket). Easy to add as an option later.

### D3. Same stack as MailWatch, no database

- One npm package; Node 26 runs the TypeScript server directly (type stripping, erasable syntax
  only); `tsc` 7 for typechecking with TypeScript 6 aliased for typescript-eslint; Hono API;
  React 19 / Vite 8 UI; ESLint flat config and Prettier settings, the release workflow,
  Dockerfile on Docker Hardened Images, bundle script and Dependabot setup as in MailWatch.
- New dependencies: the AWS SDK v3 (`client-s3`, `lib-storage`, `s3-request-presigner`, and
  `@smithy/node-http-handler` for `TLS_REJECT_UNAUTHORIZED=false`). It works with every
  S3-compatible server I know of and handles SigV4, region redirects and multipart.
- **No database:** nothing needs to persist. Probe results and learned permissions (D4) live in
  memory and are rebuilt after a restart.
- **No UI component library:** the icons are hand-drawn SVGs (`components/icons.tsx`), the
  palette and dark mode follow MailWatch's.

### D4. Greying out what the credentials may not do ⚠️

S3 cannot be asked "what may I do?" (IAM policy simulation exists on AWS only and needs extra
IAM permissions), and permissions are often per prefix (`users/${aws:username}/*`). So each
capability of a connection is tracked **per bucket and folder** (`src/server/capabilities.ts`):

| Capability    | How it is known                                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| list          | `ListObjectsV2` with one key                                                                                                       |
| read          | `HeadObject` of an object in the folder (unknown in an empty folder)                                                               |
| versions      | `ListObjectVersions` with one key                                                                                                  |
| write         | `PutObject` of 1 byte with a **wrong `Content-MD5`**: `AccessDenied` = denied, `BadDigest` = allowed, nothing is stored either way |
| tags          | `PutObjectTagging` of a key that does not exist: `NoSuchKey` = allowed                                                             |
| delete        | `DeleteObject` of a key that does not exist, **only if versioning was never enabled** (it would leave a delete marker otherwise)   |
| bucket config | learned only (versioning, bucket tags, delete bucket)                                                                              |

- **Learning:** the outcome of every real request is recorded too (a denied delete greys Delete
  out; a successful one confirms it), and wins over the probe. Only the step that performs the
  action counts: a denied listing while expanding a folder delete is not "delete denied", and a
  denied copy is not recorded at all (S3 does not say whether reading the source or writing
  the destination was refused). Probes and learned outcomes are
  kept for `CAPABILITY_TTL_MINUTES` (10).
- **Unknown is enabled:** when nothing is known (e.g. delete in a versioned bucket), the action
  stays enabled; if S3 refuses, the denial is learned and the button greys out with the reason.
- `READ_ONLY=true` greys out every write without asking S3, and the server refuses writes too.
- **Assumption behind the write probe:** S3 authorises a request before it checks the body's
  MD5. Verified against RustFS (admin: `BadDigest`; read-only user: `AccessDenied`); this is the
  documented order on AWS as far as I know, but **not verified against AWS**. If a server ever
  ignores `Content-MD5` and stores the probe, ObjectLens deletes it at once and logs a warning;
  probe keys are named `.objectlens-probe-<uuid>`.
- **Side effects outside the bucket:** the probes are logged like any request (CloudTrail data
  events, server access logs): a read-only user produces a few `AccessDenied` entries per folder
  visited, which a security alert on denied requests might notice. A delete of a non-existent
  key may emit an `ObjectRemoved` event on some servers. `S3_n_PROBE=false` switches off the
  write, tags and delete probes; those capabilities are then only learned.

### D5. Connections as numbered blocks

- `S3_<n>_*`, as `DOMAIN_<n>_*` in MailWatch; any number of connections, several per endpoint
  with different credentials (each with its own permissions). `S3_n_ID` gives stable URLs.
- Without keys, the **AWS SDK default credential chain** is used (environment, `~/.aws`, SSO,
  web identity, instance role), or `S3_n_PROFILE`. Static keys are the norm for
  S3-compatible servers.
- Path-style addressing is the default with a custom endpoint (works everywhere), virtual-host
  style for AWS. Buckets in other regions are followed (`followRegionRedirects`).
- When `ListBuckets` is denied (common with scoped keys), `S3_n_BUCKETS` names the buckets to
  show; they are also added to the listed ones (e.g. buckets of another account).
- The SDK is told to compute checksums only where S3 requires them: several S3-compatible
  servers reject the CRC checksums the SDK sends by default since 2025.

## Behaviour

### D6. Folders are prefixes

- The tree is built with `Delimiter=/`. "New folder" creates an empty `name/` object, as the AWS
  console does; the folder's own marker is not listed inside it.
- Names typed by the user may not contain `/`, be `.`/`..` or contain control characters
  (they would create surprising keys); keys are limited to 1024 UTF-8 bytes. Existing keys with
  any of these are still shown and handled.

### D7. Bulk operations: requests of bounded size ⚠️

- Copying, moving and deleting folders expand to every object below them. One request handles
  at most `BULK_LIMIT` (10,000) objects, so no request runs for hours; **the UI keeps sending
  requests until the job is done**, with progress in the dialog:
  - a copy or move returns where it stopped (`resume`: item and last key) and the next request
    lists from there (`StartAfter`), since a copy leaves its sources in place;
  - a delete simply runs again: what it deleted is gone.
- 8 copies run in parallel; deletes use `DeleteObjects` (1000 per call) and fall back to single
  deletes on servers that lack it, refuse its checksum, or choke on keys XML cannot carry. A
  batch in which **every** key is denied is reported as a denial (so Delete greys out), unless
  the refusal comes from Object Lock; partial failures are listed.
- **Alternative:** background jobs with progress and cancel. Worth it if you move hundreds of
  thousands of objects; I kept the first version simple.

### D8. Rename, copy and move

- S3 has no rename: a rename or move is a server-side copy, then a delete of the source after
  its copy succeeded. Nothing passes through ObjectLens.
- Copies keep **metadata, tags, storage class and encryption** (CopyObject would otherwise
  apply the bucket's default encryption) and, best effort, a **non-default ACL** (CopyObject
  makes every copy private; buckets with "bucket owner enforced" ignore ACLs anyway). Objects
  over 5 GiB are copied with `UploadPartCopy` in 512 MiB parts, with the tags read beforehand.
- **Not kept:** Object Lock retention and legal holds (a copy is a new object; locking it
  again is a deliberate act), and the original's last-modified date.
- **Conflicts are checked up front**: if any destination exists, nothing is copied and the UI
  asks whether to overwrite all of them.
- Folders cannot be moved into themselves. Copies across buckets of one connection are
  supported; **across connections is not** (it would have to stream through ObjectLens).

### D9. Metadata, tags and text editing

- S3 cannot change metadata in place: "Save metadata" copies the object onto itself with
  `MetadataDirective=REPLACE`, which **creates a new version** in a versioned bucket (said in
  the UI). Storage class changes the same way. Metadata of older versions cannot be edited.
- User metadata values must be printable ASCII (S3 sends them as HTTP headers; non-ASCII values
  are mangled differently by different servers). Names are lowercased, as S3 does.
- Tags are changed in place (no new version), at most 10 per object.
- Text files up to `TEXT_EDIT_MAX_BYTES` (2 MiB) can be edited in the browser. Saving uploads
  the file again **with its metadata, tags, storage class and encryption kept** (a plain upload
  would drop them).

### D10. Uploads

- One request per file, streamed to S3 as a multipart upload; the part size grows for files
  over ~70 GiB so that 10,000 parts suffice. Three files at a time; a panel shows progress, and
  each upload can be cancelled (the multipart upload is aborted) or retried.
- Folders upload with their relative paths (folder picker or drag and drop of folders).
- **Overwrites need confirmation:** the server checks with `HeadObject` first and answers 409;
  "Replace" uploads anyway. Not atomic (a concurrent writer could slip in between); conditional
  writes (`If-None-Match: *`) are not supported by every S3-compatible server. Credentials that
  may write but not read (a drop box) skip the check.

### D11. Versions and deletes

- In a versioned bucket a delete adds delete markers; the data stays as older versions. The
  delete dialog offers **"Delete every version too, permanently"**, which removes all versions
  and markers under the selection.
- The Versions tab lists versions and delete markers, and can show, download, restore (copy the
  old version over the key: a new current version, history kept) or permanently delete one.
- "Empty bucket" (bucket properties) removes every object, version and marker; S3 only deletes
  empty buckets.

### D12. Previews must not run content

- Downloads are served by ObjectLens' own origin, so an uploaded HTML or SVG file could
  otherwise run script with access to the API. Every download therefore has
  `X-Content-Type-Options: nosniff` and is an attachment, except previews of known image,
  audio, video, PDF and text types. Text, HTML included, is served as `text/plain`.
- Every response but PDFs carries `Content-Security-Policy: sandbox`, so even an SVG opened
  directly cannot run script. **PDFs are the exception**: Chrome's PDF viewer refuses to run in a
  sandboxed document. They are rendered by the browser's PDF viewer, whose scripting has no
  access to the page.

### D13. Share links are on by default ⚠️

- "Share" creates a presigned GET URL (1 hour to 7 days; SigV4 allows no more). Anyone with the
  link can download the object without ObjectLens, and **it cannot be revoked** short of
  changing the credentials. The dialog says so.
- `S3_n_PUBLIC_ENDPOINT` changes the host in the link when browsers reach S3 under another name
  than ObjectLens does. Links made with temporary credentials end when they do.
- `S3_n_SHARE_LINKS=false` removes the button.

### D14. Bucket settings: mostly read-only ⚠️

- Shown: region, versioning, encryption, policy and policy status, public access block,
  ownership controls, ACL, object lock, lifecycle, replication, CORS, website, logging,
  notifications and tags. Each is read with its own request, so one denied or unsupported
  setting shows as such without hiding the others.
- Editable: versioning (enable/suspend), bucket tags, create (with object lock), empty and
  delete. **Not editable:** policy, CORS, lifecycle, encryption, replication etc. A wrong policy
  can lock everyone out, and these are better managed as code (Terraform, `mc`, the provider's
  console). Adding a JSON editor per setting is straightforward if wanted.

### D15. Search and filter

- The filter box narrows the entries already loaded. **Enter searches the whole subtree** on the
  server: a case-insensitive substring match on key names, scanning up to `SEARCH_SCAN_LIMIT`
  (100,000) keys, at most 1000 results. S3 has no server-side search; this lists keys.
- "Size" of a folder or bucket counts the current versions the same way.

### D16. URLs

- The location is in the query string (`?c=1&b=bucket&p=folder/&o=key&v=version`), not in the
  path: keys may contain anything (`//`, `..`, `%`, `?`), which path segments mangle. Back,
  forward, reload and links work.

## Development & deployment

### D17. RustFS for development and CI ⚠️

- MinIO no longer publishes community images (`minio/minio` and `minio/mc` cannot be pulled
  from Docker Hub any more, and quay.io wants a login). I chose **RustFS** (Apache 2.0, MinIO-compatible, versioning, IAM users and policies)
  over Garage (needs a config file and layout step, no versioning) and SeaweedFS.
- `compose.yaml` runs RustFS 1.0.1 and a one-shot `rustfs/rc` container that creates the demo
  buckets and two restricted users (`dev/s3-init.sh`), so the greying-out can be seen and
  tested: `reader` (read-only) and `dropbox` (writes only in `demo/inbox/`).
- Port **9400** (9000 is often taken), published on `${CONTAINER_HOST_ADDRESS:-127.0.0.1}` for
  your rootless Docker setup; the code itself always defaults to `127.0.0.1`.
- The RustFS and `rc` images are pinned by digest; Dependabot's `docker-compose` ecosystem
  keeps them current.

### D18. CI and releases as in MailWatch

- `release.yaml`: the check job (typecheck, lint, format, tests including the S3 integration
  tests against RustFS started with `npm run dev:s3`, build), then a signed release archive
  (cosign keyless, SHA-256), then a multi-arch image on GHCR with SBOM and provenance, signed.
  Dependabot with grouped action updates and auto-merge of minor/patch updates.
- **Branch:** the default branch is `master`, as in MailWatch; the release runs on pushes to it.
  (The first version triggered on `main` by mistake, so the initial push built no release.)

### D19. GitHub repository rules

Copied from MailWatch:

- **Ruleset "master"** (on the default branch):
  - no deletion and no force push;
  - changes go through a pull request, with **0 required approvals** (GitHub does not let you
    approve your own PRs), stale approvals dismissed on push;
  - the **"Check (tsc + eslint + prettier + tests) & build"** job must pass; only the GitHub
    Actions app may report it;
  - squash merge only.
- **Admins bypass the ruleset**, so you can still push to `master` directly. Remove the bypass
  to force every change through a PR.
- **"Require branches to be up to date" is off**, so a merge does not force every open
  Dependabot PR to rebase and rerun CI.
- **Dependabot:** `dependabot-auto-merge.yml` approves minor and patch updates and enables
  auto-merge; majors wait for you. This needs "Allow auto-merge" and "Allow GitHub Actions to
  approve pull requests" (both on; the second was off at first, which failed the first
  Dependabot PR). `DHI_USERNAME`/`DHI_TOKEN` are a repository variable and secrets for Actions
  and Dependabot.
- **Other settings:** merged branches are deleted automatically, the "Update branch" button is
  shown, the squash commit takes the PR title and body, merge commits and rebase merges are
  disabled. The default `GITHUB_TOKEN` permission stays **read-only**; both workflows declare
  the permissions they need.

### D20. What I verified, and what not ⚠️

- **Verified:** `npm run check` (typecheck, ESLint, Prettier, 32 tests, 15 of them against
  RustFS, including copies and deletes over a tiny `BULK_LIMIT`: uploads, ranges, conflicts, preview headers, metadata/tags, versions and restore,
  folder copy/rename/move across buckets, deletes with and without versions, share links,
  bucket details, probes leaving nothing behind, the read-only user, `READ_ONLY`); a browser
  walk-through in Chromium (new folder, upload, rename with F2, text editing, metadata, tags,
  share link, move to another bucket, delete, search, the `dropbox` user's greyed-out actions),
  light and dark, desktop and phone width; the Docker image on the hardened `dhi.io` base
  (healthy, uid 1000, read-only root filesystem, UI served); the GitHub check job and
  Dependabot auto-merge (PR #1).
- **An independent review** (a second Claude agent, read-only) then found 12 problems, all
  fixed, the first three with new tests:
  - a folder copy over `BULK_LIMIT` could never finish (each run started over): now resumable,
    and the UI continues automatically;
  - a metadata edit of an object over 5 GiB lost its tags (read after the copy had replaced
    the source);
  - copies dropped non-default ACLs;
  - an inline PDF stored as `application/octet-stream` was downloaded instead of shown, and an
    empty stored type was passed through unchecked: inline types are now always chosen by
    ObjectLens;
  - permissions learned from the wrong step (see D4); a write probe on a server ignoring
    `Content-MD5` could leave a version behind in a versioned bucket;
  - UI: the object drawer did not refresh after a version was deleted from its dialog, "Load
    more" could append a page of the previous folder, a selection came back after navigating
    away and back, an older search could overwrite a newer one, "Empty bucket" always needed
    version listing;
  - deleting all versions of one key scanned every key starting with its name.
- **Not verified:** AWS S3 itself (no credentials here; in particular the write probe's
  assumption, D4), other S3-compatible servers (Ceph, Garage, R2, MinIO), the release and image
  jobs (not run yet, see D18), files over 5 GiB (the multipart
  copy path), and the ACL carry-over (RustFS accepts `PutObjectAcl` but keeps no grants).

## Ideas not implemented

- Direct browser ↔ S3 transfers with presigned URLs for very large files (D2).
- Background jobs with progress for very large folder operations (D7).
- Copy and move across connections (D8).
- Editing bucket policy, CORS and lifecycle (D14).
- Downloading a folder or a selection as one zip (today: one download per file).
- Object Lock retention and legal hold editing (shown, not editable), restoring archived
  (Glacier) objects, SSE-C objects (they need the customer key on every request).
