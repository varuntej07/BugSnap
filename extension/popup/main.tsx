import { createRoot } from "react-dom/client";
import { Popup } from "./Popup";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Popup root element was not found.");
}

createRoot(rootElement).render(<Popup />);
