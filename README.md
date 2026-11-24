# Node.JSONStorage

A self-hosted JSON editor and HTTP service for saving public or private JSON bins. It includes a browser editor, a saved-bin list, a manual CRUD tester, and a public-safe live request feed.

## Requirements

- Node.js 18 or newer
- npm

## Install and Run

From the repository directory:

```sh
npm install
npm start
```

Open http://127.0.0.1:3000. The default listener is `127.0.0.1:3000`, and data is stored in `./data`.

PowerShell environment overrides:

```powershell
$env:PORT = '3001'
$env:HOST = '127.0.0.1'
$env:DATA_DIR = 'C:\json-storage-data'
npm start
```

`PORT`, `HOST`, and `DATA_DIR` can also be set in the process environment before running `npm start`. Use one server process per data directory. For deployment, use persistent storage and HTTPS; never send secret keys over unencrypted connections.

For local configuration, copy `.env.sample` to `.env` and edit its values. The server loads `.env` at startup; variables already present in the process environment take precedence.

## Browser Workflow

1. Paste JSON into the editor or use **Upload JSON**. The editor keeps a draft in this tab's `sessionStorage` and restores it after a refresh. Closing the tab clears that draft. A browser warning also appears when there is unsaved content.
2. Open **Save and Manage Bins**, choose Public or Private, and select **Save bin**. Saving validates the JSON and writes it in formatted form before the request is sent. Invalid JSON is rejected with a line and column diagnostic.
3. Choose visibility. Public bins can be saved without entering a key; the browser receives an HttpOnly owner cookie for same-browser updates and deletes. Private bins need an owner key. If a Private save has no key, Save generates one and stops before creating the bin. Copy it, then select Save bin again.
4. On a successful save, the bin ID is added to the saved list in this browser's `localStorage`. The list stores only the bin ID and visibility, never the secret key. It is local to this browser and does not sync between devices.
5. Select **Use** beside a saved bin to load its JSON into the editor. Public bins can be loaded by ID alone. Private bins require the owner key.
6. Select **Delete** beside a saved bin to delete it from the server and remove it from this browser's list. The server verifies ownership using the owner key or, for a keyless Public bin, the creating browser's HttpOnly cookie; an ID alone is not authorization. If deletion fails, the local list entry is retained.
7. **New bin** clears the current selection so the next Save creates a separate bin. Otherwise, Save updates the last selected bin.

The secret key is shown only when generated, is not recoverable, and is never persisted by the browser. Copy it to a password manager before leaving the page. A new key creates a different account and does not restore access to previous bins.

## JSON Editor

- **Validate JSON** checks syntax and reports the failing line and column.
- **Format / prettify** writes indented JSON; **Compact** removes formatting whitespace.
- **Repair** attempts to repair malformed JSON using `jsonrepair`.
- **Upload JSON** accepts JSON files up to 1 MiB; **Download JSON** exports the current value.
- The editor follows the operating system's light/dark preference until the theme button is used. The chosen theme is remembered when browser storage is available.

## API CRUD Tester

Open **API CRUD Tester** to choose a method and enter either a 32-character bin ID or an API path. `POST`, `PUT`, and `PATCH` send the editor contents as the request body. Responses appear in the Results section within the same panel.

### Sending the Owner Key

In the browser tester, open **Headers** and enter a key in **X-Secret-Key** to override the shared key for tester requests. If that field is blank, the tester uses the key entered under **Save and Manage Bins > Authentication**; same-browser requests for keyless Public bins also send the HttpOnly owner cookie automatically. The Authentication key field is hidden while Public is selected; select Private to show it. Both key fields are kept in page memory only.

For `curl`, add the header explicitly:

```sh
curl -H 'X-Secret-Key: YOUR_KEY' http://127.0.0.1:3000/api/bins/BIN_ID
```

For JavaScript `fetch`, include it in `headers`:

```js
fetch('/api/bins/BIN_ID', {
  headers: { 'X-Secret-Key': 'YOUR_KEY' }
});
```

Method-specific `curl` examples:

```sh
# Public GET: no key header is needed.
curl http://127.0.0.1:3000/api/bins/BIN_ID

# Private GET: include the owner key.
curl -H 'X-Secret-Key: YOUR_KEY' http://127.0.0.1:3000/api/bins/BIN_ID

# PUT: the header and JSON content type are required.
curl -X PUT -H 'X-Secret-Key: YOUR_KEY' -H 'Content-Type: application/json' \
  --data '{"hello":"replacement"}' http://127.0.0.1:3000/api/bins/BIN_ID

# PATCH: the header and a JSON object body are required.
curl -X PATCH -H 'X-Secret-Key: YOUR_KEY' -H 'Content-Type: application/json' \
  --data '{"extra":true}' http://127.0.0.1:3000/api/bins/BIN_ID
```

Never include the key in the URL or query string. A public `GET` request does not need this header; private reads and all create, update, and delete requests do.

| Method | Path | Behavior |
| --- | --- | --- |
| POST | `/api/accounts` | Create an account and return its owner key once. |
| POST | `/api/bins?visibility=public` | Create a public bin. An owner key is optional; without one the server issues a same-browser management cookie. |
| POST | `/api/bins?visibility=private` | Create a private bin from the request body. |
| GET | `/api/bins/:id` | Read a bin. Public reads need only the ID; private reads need the owner key. |
| PUT | `/api/bins/:id` | Replace the bin's JSON value. Owner key or creating-browser cookie required for keyless Public bins. |
| PATCH | `/api/bins/:id` | Shallow-merge an object into the bin's JSON value. Owner key or creating-browser cookie required for keyless Public bins. |
| DELETE | `/api/bins/:id` | Delete the bin. Owner key or creating-browser cookie required for keyless Public bins. |
| POST | `/api/repair` | Repair malformed JSON text and return formatted JSON. |
| GET | `/api/live-logs` | Public Server-Sent Events stream for the live log panel. |

Private reads and cross-client writes/deletes require the owning key in `X-Secret-Key`. Keyless Public bins use a random HttpOnly, `SameSite=Strict` cookie on the creating browser for updates/deletes. The bin ID alone never authorizes a change or deletion. Never put a key in a URL.

Example using curl (replace `YOUR_KEY` and `BIN_ID`):

```sh
curl -X POST http://127.0.0.1:3000/api/accounts
curl -X POST 'http://127.0.0.1:3000/api/bins?visibility=private' \
  -H 'X-Secret-Key: YOUR_KEY' -H 'Content-Type: application/json' \
  --data '{"hello":"world"}'
curl -H 'X-Secret-Key: YOUR_KEY' http://127.0.0.1:3000/api/bins/BIN_ID
curl -X DELETE -H 'X-Secret-Key: YOUR_KEY' http://127.0.0.1:3000/api/bins/BIN_ID
```

## Live API Logs

The **Live API Logs** panel is public and does not require an admin token. Select **Start** to open a stream for up to 10 minutes. **Stop** closes the stream and resets the display to `10:00 ready` for the next Start. **Clear** clears only the current viewer's list; it does not erase the server's shared in-memory history. New events append chronologically and the viewer follows the latest row. The stream also stops after 5 minutes without API activity or without a server response.

The server keeps at most 200 recent events in memory and allows up to 20 concurrent log viewers by default. Events include timestamp, method, endpoint, status, duration, and public bin IDs. Private bin IDs and paths are redacted. Request bodies, secret keys, account identifiers, and IP addresses are not recorded. Logs are transient and are not written to disk.

## Bin Expiration

Each bin is automatically deleted after 30 days without a successful `GET`, `PUT`, or `PATCH`. Any of those successful requests updates its last-access time; public reads count as use. The cleanup sweep runs hourly and at server startup, so a bin may remain for up to about one hour beyond the 30-day threshold while the server is running. Expiration removes the individual bin file and releases its bytes from the owner's quota. A stale browser saved-bin entry is removed when Use or Delete next discovers the bin has expired.

## Limits and Storage

- Maximum request body: 1 MiB
- Maximum individual bin: 100 KiB of compact UTF-8 JSON
- Maximum account storage: 10 MiB
- Maximum successful bin API requests: 10,000 per account per UTC month
- Bin inactivity expiration: 30 days since the last successful GET, PUT, or PATCH

The server stores account metadata in `DATA_DIR/accounts.json` and each bin in its own file under `DATA_DIR/bins/<bin-id>.json`. A bin file contains its owner-key hash, visibility, JSON value, and size; the account index contains quota and request counters but never plaintext keys. This makes individual bin files removable without rewriting one large storage document. Prefer the app's Delete action because it also updates the owner's quota; manual file removal should be done while the server is stopped.

On startup, an existing `DATA_DIR/storage.json` is migrated into `accounts.json` and per-bin files, then renamed to `storage.json.migrated` (or a numbered variant if that archive name already exists). Public reads by other users count toward the bin owner's monthly request allowance. Failed validation and unauthorized requests do not count.

Run only one process per `DATA_DIR`; the file store does not coordinate concurrent processes or hosts. Back up the data directory separately. The service does not provide account recovery or account deletion. Treat private bin IDs as sensitive even though they are not credentials by themselves.

## Tests

Run the API and browser-script regression tests with:

```sh
npm test
```
