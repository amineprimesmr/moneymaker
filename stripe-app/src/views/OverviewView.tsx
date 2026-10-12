import { Badge, Box, ContextView, Divider, Inline, List, ListItem } from "@stripe/ui-extension-sdk/ui";
import type { ExtensionContextValue } from "@stripe/ui-extension-sdk/context";
import { strings, money, storeLabel, type Strings } from "../lib/i18n";
import type { OverviewResponse } from "../lib/moneymaker";
import { useMoneyMaker } from "../lib/useMoneyMaker";
import { Loading, MissingKey, ErrorState } from "../lib/StateViews";

const Metric = ({ label, value, hint }: { label: string; value: string; hint?: string }) => (
  <Box css={{ stack: "y", gap: "xxsmall", padding: "medium", borderRadius: "medium", keyline: "neutral", width: "1/2" }}>
    <Box css={{ font: "caption", color: "secondary" }}>{label}</Box>
    <Box css={{ font: "heading", fontWeight: "bold" }}>{value}</Box>
    {hint ? <Box css={{ font: "caption", color: "secondary" }}>{hint}</Box> : null}
  </Box>
);

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
      <Box css={{ stack: "y", gap: "small" }}>
        <Inline css={{ gap: "small" }}>
          <Metric label={t.mrr} value={money(data.mrrMicros, cur, locale)} />
          <Metric label={t.revenue28d} value={money(data.revenue28dMicros, cur, locale)} hint={delta ? `${delta} ${t.vsPrevious}` : undefined} />
        </Inline>
        <Inline css={{ gap: "small" }}>
          <Metric label={t.activeSubs} value={String(data.activeSubscriptions)} />
          <Metric label={t.trials} value={String(data.activeTrials)} />
        </Inline>
        <Inline css={{ gap: "small" }}>
          <Metric label={t.activeCustomers} value={String(data.activeCustomers)} />
          <Metric label={t.newCustomers} value={String(data.newCustomers28d)} />
        </Inline>
      </Box>
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
