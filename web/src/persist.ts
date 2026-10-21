import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

// Keeps what the user picked (sliders, dates, ticked plans, open tab...) in this browser, so it
// stays the same after switching tabs or reloading the page until the user changes it.
const PREFIX = "aab:";

function read<T>(key: string, initial: T, valid?: (v: unknown) => boolean): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return initial;
    const v: unknown = JSON.parse(raw);
    return valid && !valid(v) ? initial : (v as T);
  } catch {
    return initial;
  }
}

/** useState that also saves the value in localStorage under `key` (and starts from it). A saved
 *  value that fails `valid` (old or edited by hand) is ignored and `initial` is used instead. */
export function usePersisted<T>(key: string, initial: T, valid?: (v: unknown) => boolean): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => read(key, initial, valid));
  useEffect(() => {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      // storage blocked (private window etc.): the choice just isn't remembered
    }
  }, [key, value]);
  return [value, setValue];
}

// Checks for saved values.
export const isIntIn = (lo: number, hi: number) => (v: unknown) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
export const isBool = (v: unknown) => typeof v === "boolean";
export const isOneOf = (...ok: unknown[]) => (v: unknown) => ok.includes(v);
export const isIntOrNull = (lo: number, hi: number) => (v: unknown) => v === null || isIntIn(lo, hi)(v);
