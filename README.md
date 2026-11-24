# Node.JSONStorage

Edit, validate, format, repair, upload and download JSON in a browser, or store JSON bins through an HTTP API.

## Run

Install Node.js 18 or newer, then run:

```sh
npm install
npm start
```

Open http://127.0.0.1:3000. Set `PORT`, `HOST` and `DATA_DIR` to change the listening address and storage directory. The default data directory is `./data`. Use persistent storage and HTTPS when deploying; secret keys must not be sent over an unencrypted network. This service is self-hosted: git.io is a URL shortener, not a JSON storage or hosting provider.

Generate an account key in the editor and save it securely. It is shown only when generated and cannot be recovered. Every account can own up to 10 MiB of JSON, with a maximum of 100 KiB per bin. Sizes are measured in UTF-8 bytes of compact JSON. Each account is limited to 10,000 successful bin API requests per UTC calendar month, including public reads by other users. Failed validation and unauthorized requests do not count.

Data is stored in a local file, with key hashes rather than plaintext keys. Run only one server process per data directory; the file store does not support multiple processes or hosts. Back up the data directory separately. The service does not provide account recovery or account deletion.

## API

All responses are JSON. Send the account key in the `X-Secret-Key` header; never put it in a URL. Public bins can be read without a key, while private bins require the owning key. All modifications require the owning key. Treat private bin IDs and keys as sensitive.

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/accounts` | Generate an account; returns `{ "secretKey": "..." }`. |
| POST | `/api/bins?visibility=public` | Create a bin from the JSON request body; returns its `id`. Use `visibility=private` for a private bin. |
| GET | `/api/bins/:id` | Read the JSON value. |
| PUT | `/api/bins/:id` | Replace the JSON value with the request body. |
| PATCH | `/api/bins/:id` | Shallow-merge the request object into an existing JSON object. |
| DELETE | `/api/bins/:id` | Delete the bin. |
| POST | `/api/repair` | Send malformed JSON as text; returns a `json` string containing repaired, formatted JSON. |

Example (replace the key and bin ID):

```sh
curl -X POST http://127.0.0.1:3000/api/accounts
curl -X POST 'http://127.0.0.1:3000/api/bins?visibility=private' \
  -H 'X-Secret-Key: YOUR_KEY' -H 'Content-Type: application/json' \
  --data '{"hello":"world"}'
curl -H 'X-Secret-Key: YOUR_KEY' http://127.0.0.1:3000/api/bins/BIN_ID
```

Invalid JSON returns 400, invalid or missing keys return 401, unknown bins return 404, size or quota violations return 413, and an exhausted monthly request allowance returns 429. Request bodies are capped at 1 MiB.

Run the API tests with `npm test`.
