import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./ui/App";
import { leaked } from "./leak";
console.debug(leaked);

const rootEl = document.getElementById("root")!;
createRoot(rootEl).render(<App />);
document.documentElement.setAttribute("data-booted", "1");
