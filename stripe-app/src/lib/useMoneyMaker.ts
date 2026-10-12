import { useCallback, useEffect, useState } from "react";
import type { ExtensionContextValue } from "@stripe/ui-extension-sdk/context";
import { mmFetch, MissingKeyError, ApiError } from "./moneymaker";

export type LoadState<T> =
  | { kind: "loading" }
  | { kind: "missing_key" }
  | { kind: "error"; message: string; status?: number }
  | { kind: "ready"; data: T };

/** Charge `path` depuis le backend MoneyMaker et expose un rechargement manuel. */
export function useMoneyMaker<T>(ctx: ExtensionContextValue, path: string | null) {
  const [state, setState] = useState<LoadState<T>>({ kind: "loading" });
  const load = useCallback(async () => {
    if (!path) return;
    setState({ kind: "loading" });
    try {
      setState({ kind: "ready", data: await mmFetch<T>(ctx, path) });
    } catch (e) {
      if (e instanceof MissingKeyError) setState({ kind: "missing_key" });
      else if (e instanceof ApiError && (e.code === "invalid_api_key" || e.code === "secret_key_required")) setState({ kind: "missing_key" });
      else setState({ kind: "error", message: (e as Error).message, status: e instanceof ApiError ? e.status : undefined });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ctx.userContext?.account.id]);
  useEffect(() => { void load(); }, [load]);
  return { state, setState, reload: load };
}
