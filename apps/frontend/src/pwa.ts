/**
 * Service-worker registration, and the one thing that matters about it:
 * a till must not keep running last week's code.
 *
 * The app shell is precached so a reload still works if the server
 * blips (API responses are never cached — a cashier must never see a
 * stale order list). The risk that buys is staleness: a new build is
 * deployed, the worker installs it in the background, and the tab that
 * has been open since Tuesday carries on serving the old bundle until
 * somebody happens to close every window.
 *
 * On a restaurant till, "somebody happens to" is never. So a worker
 * that takes control after one was already running means the code on
 * screen is out of date, and the page reloads itself. The guard on
 * `refreshing` is what stops two workers turning that into a loop, and
 * skipping the very first activation is what stops a fresh install
 * reloading the moment it finishes loading.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;

  // Was this page already being served BY a worker? If not, the
  // registration below is a first install and the code on screen is
  // the code that was just downloaded — nothing to reload for.
  const wasControlled = navigator.serviceWorker.controller !== null;
  let reloading = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!wasControlled || reloading) return;
    // A different worker is now in charge of a page an older one
    // loaded: what is on screen is last deployment's code.
    reloading = true;
    window.location.reload();
  });

  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // A till that cannot register a worker still works — it just
      // loses offline shell caching, which is not worth an error on
      // screen over.
    });
  });
}
