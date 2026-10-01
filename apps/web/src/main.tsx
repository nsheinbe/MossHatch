import "./lib/trusted";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./ui/App";

const rootEl = document.getElementById("root")!;
createRoot(rootEl).render(<App />);
document.documentElement.setAttribute("data-booted", "1");
