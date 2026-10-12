import { useEffect, useState } from "react";
import { Badge, Banner, Box, Button, PropertyList, PropertyListItem, SettingsView, TextField } from "@stripe/ui-extension-sdk/ui";
import { showToast } from "@stripe/ui-extension-sdk/utils";
import type { ExtensionContextValue } from "@stripe/ui-extension-sdk/context";
import { strings } from "../lib/i18n";
import { mmFetch, readSecretKey, writeSecretKey, deleteSecretKey, type OverviewResponse } from "../lib/moneymaker";

const mask = (k: string) => `${k.slice(0, 9)}…${k.slice(-4)}`;

const AppSettings = (ctx: ExtensionContextValue) => {
  const t = strings(ctx.userContext?.locale);
  const [stored, setStored] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<string | undefined>();
  const [project, setProject] = useState<OverviewResponse["project"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Résout le projet à partir de la clé (le backend le déduit de mm_sk_…).
  const resolve = async (key: string) => {
    const o = await mmFetch<OverviewResponse>(ctx, "/overview", { key });
    setProject(o.project);
    return o.project;
  };

  useEffect(() => {
    void (async () => {
      const k = await readSecretKey();
      setStored(k);
      if (k) await resolve(k).catch(e => setError((e as Error).message));
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSave = async (values: { [x: string]: string }) => {
    const key = (values.secretKey ?? input).trim();
    if (!key && stored) return;
    if (!/^mm_sk_[A-Za-z0-9_-]{8,}$/.test(key)) { setError(t.invalidKey); return; }
    setError(null);
    setStatus(t.saving);
    try {
      await resolve(key); // vérifie la clé + la signature avant de l'enregistrer
      await writeSecretKey(key);
      setStored(key);
      setInput("");
      setStatus(t.saved);
      void showToast(t.keyStored, { type: "success" });
    } catch (e) {
      setStatus(undefined);
      setError((e as Error).message);
    }
  };

  const onRemove = async () => {
    await deleteSecretKey();
    setStored(null);
    setProject(null);
    setStatus(undefined);
    void showToast(t.removed);
  };

  return (
    <SettingsView onSave={onSave} statusMessage={status}>
      <Box css={{ stack: "y", gap: "large" }}>
        <Box css={{ stack: "y", gap: "small" }}>
          <Box css={{ font: "heading", fontWeight: "bold" }}>{t.settingsTitle}</Box>
          <Box css={{ font: "caption", color: "secondary" }}>{t.settingsBody}</Box>
        </Box>
        {error ? <Banner type="critical" title={t.errorTitle} description={error} /> : null}
        <TextField
          name="secretKey"
          type="password"
          label={t.secretKeyLabel}
          description={t.secretKeyHelp}
          placeholder={stored ? mask(stored) : "mm_sk_…"}
          value={input}
          onChange={e => setInput(e.target.value)}
        />
        <PropertyList>
          <PropertyListItem label={t.secretKeyLabel} value={stored ? <Badge type="positive">{mask(stored)}</Badge> : <Badge type="neutral">{t.noKey}</Badge>} />
          {project ? <PropertyListItem label={t.connectedTo} value={project.name} /> : null}
          {project ? <PropertyListItem label={t.projectId} value={project.id} /> : null}
        </PropertyList>
        {stored ? <Box><Button type="destructive" onPress={onRemove}>{t.removeKey}</Button></Box> : null}
      </Box>
    </SettingsView>
  );
};

export default AppSettings;
