import { useState } from "react";
import {
  Badge, Banner, Box, Button, ContextView, Divider, Inline, Link, List, ListItem, PropertyList, PropertyListItem, Select,
} from "@stripe/ui-extension-sdk/ui";
import { showToast } from "@stripe/ui-extension-sdk/utils";
import type { ExtensionContextValue } from "@stripe/ui-extension-sdk/context";
import { strings, money, date, storeLabel, type Strings } from "../lib/i18n";
import { mmFetch, type CustomerResponse, type PurchaseRow } from "../lib/moneymaker";
import { useMoneyMaker } from "../lib/useMoneyMaker";
import { Loading, MissingKey, ErrorState } from "../lib/StateViews";

const DASHBOARD = "https://moneymaker-io.web.app";

const statusBadge = (p: PurchaseRow, t: Strings) => {
  if (p.billingIssue) return <Badge type="warning">{t.billingIssue}</Badge>;
  if (p.active && p.isTrial) return <Badge type="info">{t.trial}</Badge>;
  if (p.active) return <Badge type="positive">{p.status}</Badge>;
  return <Badge type="neutral">{p.status}</Badge>;
};

const CustomerDetailView = (ctx: ExtensionContextValue) => {
  const { userContext, environment } = ctx;
  const locale = userContext?.locale;
  const t = strings(locale);
  const customerId = environment?.objectContext?.id ?? null;
  const { state, setState, reload } = useMoneyMaker<CustomerResponse>(ctx, customerId ? `/customer/${encodeURIComponent(customerId)}` : null);

  const data = state.kind === "ready" ? state.data : null;
  const footerLink = { href: data?.dashboardUrl ?? DASHBOARD, label: t.openDashboard };

  return (
    <ContextView title={t.appName} description={t.allStores} brandColor="#111111" externalLink={footerLink}>
      {state.kind === "loading" && <Loading t={t} />}
      {state.kind === "missing_key" && <MissingKey t={t} />}
      {state.kind === "error" && <ErrorState t={t} message={state.message} onRetry={reload} />}
      {data && !data.linked && (
        <Box css={{ stack: "y", gap: "medium" }}>
          <Banner type="default" title={t.notLinkedTitle} description={t.notLinkedBody} />
          <Box css={{ font: "caption", color: "secondary" }}>{data.project.name} · {data.stripeCustomerId}</Box>
        </Box>
      )}
      {data && data.linked && (
        <LinkedCustomer data={data} t={t} locale={locale} ctx={ctx} onUpdated={next => setState({ kind: "ready", data: next })} />
      )}
    </ContextView>
  );
};

type Linked = Extract<CustomerResponse, { linked: true }>;

const LinkedCustomer = ({ data, t, locale, ctx, onUpdated }: { data: Linked; t: Strings; locale?: string; ctx: ExtensionContextValue; onUpdated: (d: CustomerResponse) => void }) => {
  const cur = data.project.currency;
  const active = data.entitlements.filter(e => e.active);
  const attrs = Object.entries(data.attributes ?? {}).filter(([k]) => !k.startsWith("$")).slice(0, 8);
  return (
    <Box css={{ stack: "y", gap: "large" }}>
      <PropertyList>
        <PropertyListItem label={t.appUserId} value={<Link href={data.dashboardUrl} target="_blank" external>{data.appUserId}</Link>} />
        <PropertyListItem label={t.status} value={data.isPaying ? <Badge type="positive">{t.paying}</Badge> : <Badge type="neutral">{t.notPaying}</Badge>} />
        <PropertyListItem label={t.totalSpent} value={money(data.totalSpentMicros, cur, locale)} />
        <PropertyListItem label={t.firstSeen} value={date(data.firstSeenAt, locale)} />
        <PropertyListItem label={t.lastSeen} value={date(data.lastSeenAt, locale)} />
        {data.country ? <PropertyListItem label={t.country} value={data.country} /> : null}
      </PropertyList>

      <Divider />
      <Box css={{ stack: "y", gap: "small" }}>
        <Box css={{ font: "heading" }}>{t.entitlements}</Box>
        {active.length === 0
          ? <Box css={{ font: "caption", color: "secondary" }}>{t.noEntitlement}</Box>
          : <Inline css={{ gap: "small", wrap: "wrap" }}>
            {active.map(e => (
              <Badge key={e.id} type={e.isTrial ? "info" : "positive"}>
                {`${e.id} · ${e.expiresAt ? `${t.until} ${date(e.expiresAt, locale)}` : t.lifetime}`}
              </Badge>
            ))}
          </Inline>}
      </Box>

      <Divider />
      <Box css={{ stack: "y", gap: "small" }}>
        <Box css={{ font: "heading" }}>{t.subscriptions}</Box>
        {data.purchases.length === 0
          ? <Box css={{ font: "caption", color: "secondary" }}>{t.noPurchase}</Box>
          : <List>
            {data.purchases.slice(0, 10).map(p => (
              <ListItem
                key={p.id}
                title={<Box>{p.productId}</Box>}
                secondaryTitle={<Box>{`${storeLabel(p.store)}${p.isSandbox ? ` · ${t.sandbox}` : ""} · ${p.expiresAt ? `${p.willRenew ? t.renews : t.expires} ${date(p.expiresAt, locale)}` : t.lifetime}`}</Box>}
                value={statusBadge(p, t)}
              />
            ))}
          </List>}
      </Box>

      <Divider />
      <GrantForm data={data} t={t} ctx={ctx} onUpdated={onUpdated} />

      <Divider />
      <Box css={{ stack: "y", gap: "small" }}>
        <Box css={{ font: "heading" }}>{t.recentEvents}</Box>
        {data.events.length === 0
          ? <Box css={{ font: "caption", color: "secondary" }}>{t.noEvents}</Box>
          : <List>
            {data.events.slice(0, 10).map(e => (
              <ListItem
                key={e.id}
                title={<Box>{e.type}</Box>}
                secondaryTitle={<Box>{`${date(e.at, locale)} · ${storeLabel(e.store)} · ${e.productId}`}</Box>}
                value={e.priceMicros ? money(e.priceMicros, e.currency ?? cur, locale) : undefined}
              />
            ))}
          </List>}
      </Box>

      {attrs.length > 0 && (
        <>
          <Divider />
          <Box css={{ stack: "y", gap: "small" }}>
            <Box css={{ font: "heading" }}>{t.attributes}</Box>
            <PropertyList>
              {attrs.map(([k, v]) => <PropertyListItem key={k} label={k} value={typeof v === "string" ? v : v?.value ?? ""} />)}
            </PropertyList>
          </Box>
        </>
      )}
    </Box>
  );
};

const GrantForm = ({ data, t, ctx, onUpdated }: { data: Linked; t: Strings; ctx: ExtensionContextValue; onUpdated: (d: CustomerResponse) => void }) => {
  const [entitlement, setEntitlement] = useState(data.entitlementIds[0] ?? "");
  const [days, setDays] = useState("30");
  const [busy, setBusy] = useState(false);
  if (!data.entitlementIds.length) {
    return (
      <Box css={{ stack: "y", gap: "small" }}>
        <Box css={{ font: "heading" }}>{t.grantTitle}</Box>
        <Box css={{ font: "caption", color: "secondary" }}>{t.grantNoEntitlement}</Box>
      </Box>
    );
  }
  const grant = async () => {
    setBusy(true);
    try {
      const next = await mmFetch<CustomerResponse>(ctx, `/customer/${encodeURIComponent(data.stripeCustomerId)}/grant`, {
        method: "POST", body: { entitlement, days: days === "lifetime" ? null : Number(days) },
      });
      onUpdated(next);
      void showToast(t.grantDone, { type: "success" });
    } catch (e) {
      void showToast(`${t.grantFailed} : ${(e as Error).message}`, { type: "caution" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Box css={{ stack: "y", gap: "medium" }}>
      <Box css={{ font: "heading" }}>{t.grantTitle}</Box>
      <Select label={t.grantEntitlement} value={entitlement} onChange={e => setEntitlement(e.target.value)}>
        {data.entitlementIds.map(id => <option key={id} value={id}>{id}</option>)}
      </Select>
      <Select label={t.grantDuration} value={days} onChange={e => setDays(e.target.value)}>
        {data.grantDays.map(d => d === null
          ? <option key="lifetime" value="lifetime">{t.lifetime}</option>
          : <option key={d} value={String(d)}>{t.days(d)}</option>)}
      </Select>
      <Button type="primary" onPress={grant} disabled={busy || !entitlement}>{t.grantButton}</Button>
    </Box>
  );
};

export default CustomerDetailView;
