# Running the till on the restaurant PC (one‑click)

These four files let you open the POS by double‑clicking one icon — no
`npm start`, no command window.

| File | What it does |
|------|--------------|
| `setup.bat` | **Run once** after downloading/updating the code. Installs everything and builds the app. |
| `start-pos.vbs` | **Everyday launcher.** Starts the server hidden if it isn't already running, waits for it, then opens the till in its own window. |
| `start-pos.bat` | Same as the `.vbs`, but shows a window and the log — use it if something goes wrong. |
| `stop-pos.bat` | Stops the background server (rarely needed — shutting down the PC also stops it). |

The server writes its log to `pos-server.log` in the project folder.

---

## First‑time setup (once)

1. Keep the whole project folder somewhere permanent — e.g. `C:\AbidChatkhara`
   rather than `Downloads` (Downloads is easy to clear by accident, and the
   database lives inside this folder at `data\pos.sqlite`).
2. Double‑click **`setup.bat`** and let it finish (needs internet). It installs
   dependencies and builds the app.

## Make the desktop icon

1. Right‑click **`start-pos.vbs`** → **Show more options** → **Send to** →
   **Desktop (create shortcut)**.
2. On the desktop, rename the new shortcut to **POS**.
3. *(Optional)* Right‑click it → **Properties** → **Change Icon…** to give it a
   nicer icon, and drag it onto the taskbar to pin it.

## Every day

- Double‑click the **POS** icon. The server starts in the background (no
  window) and the till opens in its own window.
- Closing the till window is fine — the server keeps running so nothing is
  lost. Double‑click **POS** again to reopen it instantly.
- To fully stop the server, run **`stop-pos.bat`** or just shut the PC down.

---

## Notes & troubleshooting

- **First open shows a blank page?** The app wasn't built — run `setup.bat`.
- **Double‑clicking the `.vbs` opens an editor instead of running it?** Your PC
  has VBScript running disabled. Use **`start-pos.bat`** instead (make its
  shortcut the same way), or set the shortcut's target to
  `wscript.exe "C:\AbidChatkhara\scripts\windows\start-pos.vbs"`.
- **Windows/SmartScreen warns about the script?** It's your own file; choose
  *More info → Run anyway*, or use `start-pos.bat`.
- **Other devices (tablets/phones on the shop Wi‑Fi) should use it too?** They
  can open `http://<this‑pc‑ip>:4000` once port **4000** is allowed through
  Windows Firewall. (The till PC itself doesn't need that.)
- **Want it to start automatically at boot** (no click at all)? That's a small
  add‑on (a Scheduled Task or a Windows Service) — ask and it can be set up.
