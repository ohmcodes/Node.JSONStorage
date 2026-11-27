# Feature Index

This document summarizes the browser application and HTTP service features. See [README.md](README.md) for setup, workflow, API details, and deployment notes.

## JSON Editor

- Paste JSON or upload a `.json` file (up to 1 MiB).
- Switch between raw JSON input and an editable table that navigates one object or array level at a time, with clickable path breadcrumbs; edit primitive values as JSON and add or remove properties and items at any level.
- Validate JSON and display the failing line and column.
- Format, compact, repair, and download JSON.
- Repair common syntax errors including trailing or missing commas, single quotes, unquoted keys, comments, and some truncated JSON; review repaired content before saving.
- Keep an editor draft in the current tab and restore it after a refresh; show a browser leave-page warning for unsaved text.
- Choose a light or dark theme; dark is the default and the selected theme is remembered in the browser.
- Display the server-wide number of stored public and private bins without exposing their IDs or contents; refresh after local creation or deletion, on focus, and every minute.

## Save and Manage Bins

- Choose Public or Private visibility before saving.
- Validate and format editor content automatically before a Save request.
- Create a new bin or update the last selected bin.
- Automatically generate an owner key when saving a Private bin if no key exists; pause bin creation until the Copy button is used, then save on the next press.
- Keep saved bin IDs and visibility in browser `localStorage`; never store secret keys there.
- Browse saved bins, load one into the editor with Use, or request deletion with Delete.
- Load an existing bin by its ID; private bins also require their owner key. Loading a public bin does not grant write access.
- Mask the current bin ID by default with reveal and copy controls.
- Allow keyless Public creation and same-browser management through an HttpOnly owner cookie. Private reads and cross-client mutations require the owner key; a bin ID alone never authorizes deletion.

## Authentication

- Generate an account key and copy it to a password manager.
- Keep the key masked by default, with reveal and copy controls.
- Show Authentication controls inline for private reads and owner-key management of public or private bins.
- Do not persist the key in local or session storage. A lost key cannot be recovered.

## API CRUD Tester

- Send GET, POST, PUT, PATCH, and DELETE requests to local API paths.
- Paste either a bin ID or a complete API path.
- Use the editor as the body for POST, PUT, and PATCH.
- Attach the Authentication key as `X-Secret-Key` by default, with an optional tester-only header override; external clients must set the header themselves.
- View response status and formatted response content in the Results section within the tester panel.
- Send the optional `X-Secret-Key` header from the tester override or shared Authentication field; use the browser owner cookie for keyless Public bins.

## Live API Logs

- View a public Server-Sent Events stream from the Live API Logs panel.
- Start a session for up to 10 minutes; Stop closes it and resets the timer display for the next start.
- Clear the current viewer's log list without erasing the server's shared in-memory history; automatically scroll to the newest event.
- Stop automatically after 5 minutes without API activity, after 5 minutes without a server response, or at the 10-minute maximum.
- Keep the latest 200 events in memory; allow up to 20 concurrent viewers by default.
- Include method, endpoint, status, duration, and public bin IDs. Redact private bin IDs and paths.
- Exclude request bodies, keys, account identifiers, and IP addresses; never write logs to disk.

## Service Limits

- 100 KiB maximum per bin.
- 10 MiB maximum storage per account.
- 10,000 successful bin API requests per account per UTC month.
- 1 MiB maximum request body.
- Delete bins after 30 days without a successful GET, PUT, or PATCH; reads and updates reset the inactivity timer.
- File-backed storage requires one server process per data directory.
- Store account metadata in `accounts.json` and each cloud bin in its own `bins/<bin-id>.json` file.
- Migrate legacy `storage.json` data at startup and retain it as a `.migrated` archive.
