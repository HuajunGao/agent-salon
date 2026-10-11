// Server-sent events: the browsers' connections and what is pushed to them. The snapshots themselves (init, state,
// a shared page's view) are built by the server, which registers them once with provide().
// Browser connections: the app itself (view null), or a shared discussion opened read-only (view: its chat id).
const clients = new Map();
let snap = { init: () => ({}), state: () => ({}), view: () => ({}) };
export const provide = s => { snap = s; };

export const data = ev => `data: ${JSON.stringify(ev)}\n\n`;
export const send = ev => { const s = data(ev); for (const [c, view] of clients) if (view == null) c.write(s); };
export function sendViewers(chat, ev) {
  let s;
  for (const [c, view] of clients) if (view === chat) c.write(s ??= data(typeof ev === 'function' ? ev() : ev));
}
export function connect(res, view, first) {
  clients.set(res, view);
  res.on('close', () => clients.delete(res));
  res.write(data(first));
}
// Everything again (messages included): after changes that alter what the app may show, e.g. a game the user played ending.
export const resync = () => send(snap.init());
export const sendState = () => {
  send(snap.state());
  for (const c of new Set(clients.values())) if (c != null) sendViewers(c, () => snap.view(c));
};
let stateTimer;
export const sendStateSoon = () => { stateTimer ??= setTimeout(() => { stateTimer = null; sendState(); }, 400); };
