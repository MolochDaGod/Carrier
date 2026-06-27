import { createRoot } from "react-dom/client";
import "./index.css";

const root = createRoot(document.getElementById("root")!);
const params = new URLSearchParams(window.location.search);

// Shipyard: a no-auth import/preview workbench for custom ship models, reachable
// at `?shipyard`. Available in dev AND production — it's the player's tool for
// bringing in their own ships, and persists uploads per-device.
if (params.has("shipyard")) {
  import("./pages/Shipyard").then(({ Shipyard }) => {
    root.render(<Shipyard />);
  });
} else if (import.meta.env.DEV && params.has("inspect")) {
  // Dev-only model inspector: a no-auth turntable viewer for every ship/station
  // asset, reachable at `?inspect`. Gated on `import.meta.env.DEV` so the page and
  // its engine tree-shake completely out of production builds.
  import("./pages/Inspector").then(({ Inspector }) => {
    root.render(<Inspector />);
  });
} else {
  import("./App").then(({ default: App }) => {
    root.render(<App />);
  });
}
