import { createRoot } from "react-dom/client";
import { Capture } from "./Capture";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Capture root element was not found.");
}

createRoot(rootElement).render(<Capture />);
