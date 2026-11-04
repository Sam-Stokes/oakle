// The game picker at /. Returning players go straight to the game they played last; /?pick always shows the picker.
import "./style.css";
import { GAME_IDS, GAMES } from "./games";

const pick = new URLSearchParams(location.search).has("pick");
let last: string | null = null;
try {
  // players from before Crystal have no "last game" yet but do have a Yellow save: take them to Yellow, where the news banner is
  last = localStorage.getItem("oakle-last") ?? (localStorage.getItem("oakle") ? "yellow" : null);
} catch {
  /* storage blocked: show the picker */
}
const game = GAME_IDS.find((id) => id === last);
if (game && !pick) location.replace(GAMES[game].path);

// the pictures are fetched at build time; when one is missing the card just shows without it
document.querySelectorAll<HTMLImageElement>(".pick-art").forEach((img) => img.addEventListener("error", () => img.remove()));
// mark the game played last
if (game) document.querySelector(`.pick[data-game="${game}"]`)?.setAttribute("data-last", "");
