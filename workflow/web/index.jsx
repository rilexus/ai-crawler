import { createRoot } from "react-dom/client";
import App from "./App";

// Keep this file to the root render only. Components live in other files so
// Fast Refresh can update them without re-running createRoot().
createRoot(document.getElementById("root")).render(<App />);
