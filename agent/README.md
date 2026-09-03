# Print agent

A tiny local service that prints Abid Chatkhara receipts to the BIXOLON
thermal printer as **raw ESC/POS bytes**, bypassing the Windows driver
(which renders blank pages). It runs on the till, next to the browser,
and the POS front-end sends it a ticket to print.

It has **no dependencies** — just Node 18+ — and makes **no network
calls of its own**: the browser talks to it over `127.0.0.1`, and it
talks to the printer over the local network or a local device. Nothing
leaves the till.

## Run it

```bash
cd agent
npm start
```

By default it listens on `http://127.0.0.1:7777` and expects a network
printer on `127.0.0.1:9100`. Point it at your printer with environment
variables:

| Variable         | Meaning                                                        | Default     |
|------------------|----------------------------------------------------------------|-------------|
| `AGENT_PORT`     | Port this agent listens on (the POS expects 7777)              | `7777`      |
| `PRINTER_TYPE`   | `network` or `device`                                          | `network`   |
| `PRINTER_HOST`   | Network printer host/IP (`network` only)                       | `127.0.0.1` |
| `PRINTER_PORT`   | Network printer raw port (`network` only)                      | `9100`      |
| `PRINTER_DEVICE` | Path to write raw bytes to (`device` only)                     | —           |
| `PRINTER_DENSITY`| Print darkness `0`–`8`; `0` leaves the printer on its setting  | `0`         |

**Network printer (BIXOLON with Ethernet):**

```bash
PRINTER_TYPE=network PRINTER_HOST=192.168.1.50 PRINTER_PORT=9100 npm start
```

**USB / shared printer (write raw bytes to a device path):**

```bash
# Windows: a shared printer, e.g. \\localhost\BIXOLON
PRINTER_TYPE=device PRINTER_DEVICE="\\\\localhost\\BIXOLON" npm start
# Linux: a USB line printer
PRINTER_TYPE=device PRINTER_DEVICE=/dev/usb/lp0 npm start
```

No IP or device path is committed to the repo — it comes from the
environment only.

### Run it at boot

The agent must be up whenever the till is taking payments. Run it as a
service that restarts on failure and starts at login — Windows Task
Scheduler ("At log on", restart on failure), NSSM, or `pm2` all work.
The POS shows a live **Printer connected / not connected** indicator, so
if the agent is down the cashier sees it before they try to print.

## The contract

The POS front-end calls exactly two endpoints.

### `GET /health`

Prints nothing, uses no paper — safe to poll.

- `200 {"ok":true}` — the agent is up and the printer is reachable.
- `503 {"ok":false}` — the printer is not reachable.

### `POST /print`

Prints one ticket. `200 {"ok":true}` on success; **any non-200 means
nothing printed** (the POS then shows the cashier a retry, and never
falls back to blank Windows printing). Jobs are queued internally and
serialised, so a bill and a receipt fired close together never
interleave on the wire.

Body — a **bill** (pre-payment):

```json
{
  "kind": "bill",
  "restaurant": { "name": "...", "address": "...", "phone": "..." },
  "orderNumber": 40,
  "date": "9/3/2026, 11:50:46 PM",
  "orderType": "dine_in",
  "waiter": "Saif",
  "items": [{ "quantity": 1, "name": "Fresh Apple Juice", "amount": 450 }],
  "subtotal": 450,
  "discount": 0,
  "serviceCharge": null,
  "tax": null,
  "total": 450,
  "paymentOptions": [{ "bank": "HBL", "accountName": "abid", "accountNumber": "****7890" }]
}
```

A **receipt** (post-payment) is the same, with `"kind": "receipt"`,
without `paymentOptions`, and with `invoiceNumber`, `paymentMethod` and
`amountPaid` added.

- `item.amount` is the **line total**, not the unit price.
- Amounts are **rupees** as numbers (`450`, not paisa).
- `accountNumber` is **already masked** by the POS (`****7890`) — the
  agent prints it verbatim, so the full number never reaches here.
- `kind: "test"` prints the darkness test strip and takes no other
  fields.

## Test

```bash
cd agent
npm test        # node --test
```

Covers the ESC/POS builder (a bill initialises the printer and carries
its text; a receipt kicks the drawer and a bill does not; long names
wrap; an unknown kind throws) and the HTTP contract against a fake
printer (health 200/503, print 200, a refused job is 500 with nothing
claimed printed, CORS preflight, and bill/receipt as independent jobs).
