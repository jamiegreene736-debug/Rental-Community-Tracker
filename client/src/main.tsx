import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { installAppNavHistoryTracker } from "./lib/app-nav-history";

// Must run before the first wouter navigation so AppBackButton's in-app
// history depth is accurate from the very first click.
installAppNavHistoryTracker();

createRoot(document.getElementById("root")!).render(<App />);
