/**
 * Two-client integration test for the space-shooter netcode.
 *
 * Spins up two WebSocket clients against the running server (through the shared
 * proxy at localhost:80), joins both, plots a course for each, and asserts:
 *   - each client gets a `welcome` with an id,
 *   - snapshots eventually contain BOTH joined mother-ship entities,
 *   - the per-player economy reports each client controlling its own entity,
 *   - each ship actually moves toward its plotted course (position changes).
 *
 * Movement is server-driven via `course` messages (no client input/prediction),
 * matching the current protocol. This validates the authoritative loop without
 * the Puter guest gate (which blocks headless browser screenshots of the
 * cabinet).
 */
import { WebSocket } from "ws";

const URL = "ws://localhost:80/api/space";
const DURATION_MS = 2500;

function makeClient(label, shipType, course) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const state = {
      label,
      id: null,
      sawBothShips: false,
      controlledSelf: false,
      firstPos: null,
      lastPos: null,
      snapshots: 0,
    };

    const timeout = setTimeout(
      () => reject(new Error(`${label}: timed out before welcome`)),
      5000,
    );

    ws.on("open", () => {
      ws.send(JSON.stringify({ t: "join", name: label, shipType }));
    });

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.t === "welcome") {
        clearTimeout(timeout);
        state.id = msg.id;
        // Plot a course; the server drives the ship toward it each tick.
        ws.send(JSON.stringify({ t: "course", tx: course.tx, tz: course.tz }));
        setTimeout(() => {
          try {
            ws.close();
          } catch {}
          resolve(state);
        }, DURATION_MS);
      } else if (msg.t === "snapshot") {
        state.snapshots++;
        const entities = msg.entities ?? [];
        const ids = new Set(
          entities.filter((e) => e.kind === "mother_ship").map((e) => e.id),
        );
        if (ids.size >= 2) state.sawBothShips = true;
        const mine = (msg.economy ?? []).find((e) => e.playerId === state.id);
        if (mine && mine.controlledEntityId) state.controlledSelf = true;
        const me = entities.find((e) => e.id === state.id);
        if (me) {
          const pos = { px: me.px, py: me.py, pz: me.pz };
          if (!state.firstPos) state.firstPos = pos;
          state.lastPos = pos;
        }
      }
    });

    ws.on("error", reject);
  });
}

function moved(a, b) {
  if (!a || !b) return 0;
  return Math.hypot(b.px - a.px, b.py - a.py, b.pz - a.pz);
}

const [c1, c2] = await Promise.all([
  makeClient("Alpha", 0, { tx: 200, tz: 200 }),
  makeClient("Bravo", 2, { tx: -200, tz: -200 }),
]);

let failures = 0;
function check(cond, label) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
}

for (const c of [c1, c2]) {
  console.log(
    `\n[${c.label}] id=${c.id} snapshots=${c.snapshots} ` +
      `bothShips=${c.sawBothShips} controlledSelf=${c.controlledSelf} ` +
      `moved=${moved(c.firstPos, c.lastPos).toFixed(1)}`,
  );
  check(!!c.id, `${c.label}: received welcome with id`);
  check(c.snapshots > 5, `${c.label}: received snapshots`);
  check(c.controlledSelf, `${c.label}: economy reports a controlled entity`);
  check(c.sawBothShips, `${c.label}: snapshot shows both ships`);
  check(moved(c.firstPos, c.lastPos) > 5, `${c.label}: ship moved toward course`);
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
