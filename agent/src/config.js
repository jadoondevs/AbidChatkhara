// How this agent reaches the printer — from the environment only, so no
// device path or IP is ever committed to the repo (the POS's own rule:
// never commit printer addresses).
//
//   PRINTER_TYPE     'network' (default) or 'device'
//   PRINTER_HOST     network: the printer's IP/host        (network only)
//   PRINTER_PORT     network: the raw port, default 9100    (network only)
//   PRINTER_DEVICE   device: a path to write raw bytes to  (device only)
//                    e.g. a Windows share \\localhost\BIXOLON, or
//                    /dev/usb/lp0 on Linux
//   PRINTER_DENSITY  0-8, 0 = leave the printer on its own setting
//   AGENT_PORT       the port this agent listens on, default 7777

export function loadConfig(env = process.env) {
  const type = (env.PRINTER_TYPE || 'network').toLowerCase();
  const density = Number.parseInt(env.PRINTER_DENSITY ?? '0', 10) || 0;
  const listenPort = Number.parseInt(env.AGENT_PORT ?? '7777', 10) || 7777;

  if (type === 'device') {
    if (!env.PRINTER_DEVICE) throw new Error('PRINTER_TYPE=device needs PRINTER_DEVICE (a path to write raw bytes to)');
    return { type, device: env.PRINTER_DEVICE, density, listenPort };
  }

  return {
    type: 'network',
    host: env.PRINTER_HOST || '127.0.0.1',
    port: Number.parseInt(env.PRINTER_PORT ?? '9100', 10) || 9100,
    density,
    listenPort,
  };
}
