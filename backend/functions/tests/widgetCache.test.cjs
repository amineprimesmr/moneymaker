const test = require("node:test");
const assert = require("node:assert");
const { widgetCached, clearWidgetCache, isWidget, WIDGET_TTL_MS } = require("../lib/widgetCache");

const WIDGET = "MoneyMakerWidgets/7 CFNetwork/3896.200.61 Darwin/27.2.0";
const APP = "MoneyMaker/7 CFNetwork/3896.200.61 Darwin/27.2.0";

function counter() {
  const f = async () => ++f.calls;
  f.calls = 0;
  return f;
}

test("only the widgets extension is recognised", () => {
  assert.equal(isWidget(WIDGET), true);
  assert.equal(isWidget(APP), false);
  assert.equal(isWidget(undefined), false);
});

test("a burst of widgets computes once, even while the first call is running", async () => {
  clearWidgetCache();
  const f = counter();
  const r = await Promise.all([1, 2, 3, 4].map(() => widgetCached(WIDGET, "k", f, WIDGET_TTL_MS, 1000)));
  assert.deepEqual(r, [1, 1, 1, 1]);
  assert.equal(f.calls, 1);
});

test("the answer expires", async () => {
  clearWidgetCache();
  const f = counter();
  await widgetCached(WIDGET, "k", f, WIDGET_TTL_MS, 1000);
  assert.equal(await widgetCached(WIDGET, "k", f, WIDGET_TTL_MS, 1000 + WIDGET_TTL_MS - 1), 1);
  assert.equal(await widgetCached(WIDGET, "k", f, WIDGET_TTL_MS, 1000 + WIDGET_TTL_MS), 2);
});

test("the app always gets fresh numbers, and widgets then reuse them", async () => {
  clearWidgetCache();
  const f = counter();
  await widgetCached(WIDGET, "k", f, WIDGET_TTL_MS, 1000);
  assert.equal(await widgetCached(APP, "k", f, WIDGET_TTL_MS, 2000), 2);
  assert.equal(await widgetCached(APP, "k", f, WIDGET_TTL_MS, 2000), 3);
  assert.equal(await widgetCached(WIDGET, "k", f, WIDGET_TTL_MS, 3000), 3);
});

test("two keys never share an answer", async () => {
  clearWidgetCache();
  assert.equal(await widgetCached(WIDGET, "overview|alice", async () => "a", WIDGET_TTL_MS, 1000), "a");
  assert.equal(await widgetCached(WIDGET, "overview|bob", async () => "b", WIDGET_TTL_MS, 1000), "b");
});

test("an error is not kept", async () => {
  clearWidgetCache();
  await assert.rejects(widgetCached(WIDGET, "k", async () => { throw new Error("boom"); }, WIDGET_TTL_MS, 1000));
  await new Promise(setImmediate);
  assert.equal(await widgetCached(WIDGET, "k", async () => "ok", WIDGET_TTL_MS, 1000), "ok");
});
