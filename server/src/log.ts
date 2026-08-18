import { pushFeed } from "./feed.js";

const t = () => new Date().toISOString().slice(11, 19);

// Every server log line also lands in the live terminal feed (QUANT://LOG),
// so the stage's log panel shows EVERYTHING that happens, as it happens.
export const log = {
  info: (tag: string, msg: string) => {
    console.log(`${t()} [${tag}] ${msg}`);
    pushFeed(`sys:${tag}`, msg);
  },
  warn: (tag: string, msg: string) => {
    console.warn(`${t()} [${tag}] ⚠ ${msg}`);
    pushFeed(`warn:${tag}`, msg);
  },
  error: (tag: string, msg: string) => {
    console.error(`${t()} [${tag}] ✗ ${msg}`);
    pushFeed(`error:${tag}`, msg);
  },
};
