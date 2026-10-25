// Cosmetic jaw only: never writes policy commands or joint targets.
let opening = 0;
export function setConversationJaw(value) {
  opening = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
export function getConversationJaw() { return opening; }
