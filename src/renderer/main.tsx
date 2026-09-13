import { createRoot } from "react-dom/client";
import { App } from "./app/App";

window.addEventListener("error", (e) => {
  console.error("uncaught", e);
});

const root = createRoot(document.getElementById("app")!);
root.render(<App />);