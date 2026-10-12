import { Badge, Box, ContextView, Divider, List, ListItem, PropertyList, PropertyListItem } from "@stripe/ui-extension-sdk/ui";
import type { ExtensionContextValue } from "@stripe/ui-extension-sdk/context";
import { strings, money, storeLabel, type Strings } from "../lib/i18n";
import type { OverviewResponse } from "../lib/moneymaker";
import { useMoneyMaker } from "../lib/useMoneyMaker";
import { Loading, MissingKey, ErrorState } from "../lib/StateViews";

const pctDelta = (cur: number, prev: number | null) => {
  if (!prev) return undefined;
  const d = (cur - prev) / Math.abs(prev) * 100;
  return `${d >= 0 ? "+" : ""}${d.toFixed(0)} %`;
};

const OverviewView = (ctx: ExtensionContextValue) => {
  const locale = ctx.userContext?.locale;
  const t = strings(locale);
  const { state, reload } = useMoneyMaker<OverviewResponse>(ctx, "/overview");
  const data = state.kind === "ready" ? state.data : null;
  return (
    <ContextView
      title={t.appName}
      description={data ? data.project.name : t.overviewTitle}
      brandColor="#111111"
      externalLink={{ href: data?.dashboardUrl ?? "https://moneymaker-io.web.app", label: t.openDashboard }}
    >
      {state.kind === "loading" && <Loading t={t} />}
      {state.kind === "missing_key" && <MissingKey t={t} />}
      {state.kind === "error" && <ErrorState t={t} message={state.message} onRetry={reload} />}
      {data && <Overview data={data} t={t} locale={locale} />}
    </ContextView>
  );
};

const Overview = ({ data, t, locale }: { data: OverviewResponse; t: Strings; locale?: string }) => {
  const cur = data.project.currency;
  const delta = pctDelta(data.revenue28dMicros, data.previousRevenue28dMicros);
  const stores = Object.keys({ ...data.byStore, ...data.revenueByStore }).filter(s => s !== "promotional")
    .sort((a, b) => (data.revenueByStore[b] ?? 0) - (data.revenueByStore[a] ?? 0));
  return (
    <Box css={{ stack: "y", gap: "large" }}>
      <Box css={{ stack: "y", gap: "xxsmall" }}>
        <Box css={{ font: "caption", color: "secondary" }}>{t.mrr}</Box>
        <Box css={{ font: "title", fontWeight: "bold" }}>{money(data.mrrMicros, cur, locale)}</Box>
      </Box>
      <PropertyList>
        <PropertyListItem label={t.revenue28d} value={`${money(data.revenue28dMicros, cur, locale)}${delta ? ` (${delta})` : ""}`} />
        <PropertyListItem label={t.activeSubs} value={String(data.activeSubscriptions)} />
        <PropertyListItem label={t.trials} value={String(data.activeTrials)} />
        <PropertyListItem label={t.activeCustomers} value={String(data.activeCustomers)} />
        <PropertyListItem label={t.newCustomers} value={String(data.newCustomers28d)} />
      </PropertyList>
      <Divider />
      <Box css={{ stack: "y", gap: "small" }}>
        <Box css={{ font: "heading" }}>{t.byStore}</Box>
        <List>
          {stores.map(s => (
            <ListItem
              key={s}
              title={<Box>{storeLabel(s)}</Box>}
              secondaryTitle={<Box>{`${t.mrr} ${money(data.byStore[s]?.mrrMicros ?? 0, cur, locale)} · ${t.revenue28d} ${money(data.revenueByStore[s] ?? 0, cur, locale)}`}</Box>}
              value={<Badge type="neutral">{t.storeActive(data.byStore[s]?.active ?? 0)}</Badge>}
            />
          ))}
        </List>
      </Box>
    </Box>
  );
};

export default OverviewView;
