// One trainer (id + name) for both games, kept under its own key; each game keeps its own runs under its own key.
// Yellow's key stays "oakle" with the id and name it always held, so nobody who already plays is reset.
// Pure (storage is passed in): shared by the page and the tests.
import { GAME_IDS, type GameId } from "./games";

export type Stored = { id?: string; name?: string; runs?: Record<number, unknown> };
export const gameKey = (id: GameId) => (id === "yellow" ? "oakle" : `oakle-${id}`);
export const ID_KEY = "oakle-trainer";

/**
 * Who is playing, and this game's runs. The trainer is the shared record if there is one, else whichever game's save
 * already knows one (the first visit to a second game), else a new one. A game's saved runs belong to one trainer: when this
 * device switched trainers on the other game they are dropped, and the page reads them again from the server.
 */
export function loadTrainer(read: (key: string) => Stored, game: GameId, fresh: () => string) {
  const mine = read(gameKey(game));
  const who = read(ID_KEY).id ? read(ID_KEY) : (GAME_IDS.map((id) => read(gameKey(id))).find((s) => s.id) ?? {});
  const id = who.id || fresh();
  return { id, name: who.name ?? "", runs: (mine.id === id ? (mine.runs ?? {}) : {}) as Record<number, never> };
}
