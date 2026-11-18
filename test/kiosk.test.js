import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { createApp } from "../server.js";
import { buildSystemPrompt } from "../src/clerk.js";

// 테스트마다 임시 데이터 폴더와 임의 포트로 서버를 띄웁니다. 실제 Claude 는 호출하지 않습니다.
async function start(t, { client, aiMode = "auto" } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "side-by-ai-"));
  const notices = [];
  const config = loadConfig({ dataDir, adminPin: "123456", aiMode, notifyUrl: "" });
  const server = createApp(config, {
    client,
    notify: async (m) => (notices.push(m), true),
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
  const admin = (url, body) => call(url, body, { "x-admin-pin": "123456" });
  return { call, admin, notices, base, dataDir };
}

/** 미리 정해 둔 응답을 차례로 돌려주는 가짜 Claude 클라이언트 */
function fakeClient(responses) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        create: async (params) => {
          // 요청 시점의 대화 기록을 복사해 둡니다(이후 기록이 계속 늘어나므로).
          requests.push({ ...params, messages: structuredClone(params.messages) });
          const next = responses.shift();
          if (next instanceof Error) throw next;
          return next;
        },
      },
    },
  };
}
const textReply = (text) => ({ stop_reason: "end_turn", content: [{ type: "text", text }] });

test("바코드를 찍으면 담기고, 품절·미등록·재고 초과는 담기지 않는다", async (t) => {
  const { call } = await start(t, { aiMode: "offline" });
  const { data: s } = await call("/api/session", {});
  const sessionId = s.sessionId;

  let r = await call("/api/scan", { sessionId, code: "2000000000015" });
  assert.equal(r.data.ok, true);
  assert.equal(r.data.total, 48000);

  r = await call("/api/scan", { sessionId, code: "2000000000015" }); // 한 점뿐인 상품을 또 찍음
  assert.equal(r.data.ok, false);
  assert.equal(r.data.total, 48000);

  r = await call("/api/scan", { sessionId, code: "2000000000046" }); // 품절
  assert.equal(r.data.ok, false);

  r = await call("/api/scan", { sessionId, code: "999" }); // 미등록
  assert.equal(r.data.ok, false);
  assert.equal(r.data.items.length, 1);
});

test("결제 흐름: 주문 생성 → 손님 송금 확인 → 재고 차감·알림 → 사장님 입금 확인 → 매출 집계", async (t) => {
  const { call, admin, notices } = await start(t, { aiMode: "offline" });
  const sessionId = (await call("/api/session", {})).data.sessionId;
  await call("/api/scan", { sessionId, code: "2000000000039" });
  await call("/api/scan", { sessionId, code: "2000000000039" });

  const checkout = await call("/api/checkout", { sessionId });
  assert.equal(checkout.data.order.total, 30000);
  assert.equal(checkout.data.order.status, "pending");

  const paid = await call("/api/checkout/paid", { sessionId });
  assert.equal(paid.data.order.status, "customer_confirmed");
  assert.match(notices.at(-1), /30,000원/);

  const products = (await admin("/api/admin/products")).data;
  assert.equal(products.find((p) => p.id === "p_sample03").stock, 1);

  let sales = (await admin("/api/admin/sales")).data;
  assert.deepEqual(sales.awaitingOwner, { count: 1, total: 30000 });
  assert.deepEqual(sales.confirmed, { count: 0, total: 0 });

  await admin("/api/admin/orders/status", { id: paid.data.order.id, status: "confirmed" });
  sales = (await admin("/api/admin/sales")).data;
  assert.deepEqual(sales.confirmed, { count: 1, total: 30000 });

  // 사장님이 취소하면 재고가 돌아온다
  await admin("/api/admin/orders/status", { id: paid.data.order.id, status: "cancelled" });
  assert.equal((await admin("/api/admin/products")).data.find((p) => p.id === "p_sample03").stock, 3);
});

test("빈 장바구니는 결제할 수 없다", async (t) => {
  const { call } = await start(t, { aiMode: "offline" });
  const sessionId = (await call("/api/session", {})).data.sessionId;
  assert.equal((await call("/api/checkout", { sessionId })).status, 409);
});

test("관리 API 는 PIN 없이는 열리지 않고, 가게 카드와 상품을 고칠 수 있다", async (t) => {
  const { call, admin } = await start(t, { aiMode: "offline" });
  assert.equal((await call("/api/admin/products")).status, 401);
  assert.equal((await call("/api/admin/shop-card", { text: "x" }, { "x-admin-pin": "000000" })).status, 401);

  await admin("/api/admin/shop-card", { text: "환불은 안 돼요." });
  assert.equal((await admin("/api/admin/shop-card")).data.text, "환불은 안 돼요.");

  const saved = await admin("/api/admin/products", { name: "새 자켓", price: 25000, barcode: "88001" });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.stock, 1);
  const dup = await admin("/api/admin/products", { name: "다른 옷", price: 1000, barcode: "88001" });
  assert.equal(dup.status, 400);
  const bad = await admin("/api/admin/products", { name: "가격 없음", price: "abc" });
  assert.equal(bad.status, 400);
});

test("AI 점원: 가게 카드가 프롬프트에 들어가고, 도구로 장바구니에 담는다", async (t) => {
  const client = fakeClient([
    {
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "담아 드릴게요." },
        { type: "tool_use", id: "tu_1", name: "add_to_cart", input: { product_id: "p_sample01", quantity: 1 } },
      ],
    },
    textReply("블레이저를 장바구니에 담았어요."),
  ]);
  const { call, admin } = await start(t, { client });
  await admin("/api/admin/shop-card", { text: "우리 가게는 환불이 안 됩니다." });
  const sessionId = (await call("/api/session", {})).data.sessionId;

  const r = await call("/api/chat", { sessionId, text: "체크 블레이저 살게요" });
  assert.equal(r.data.mode, "ai");
  assert.equal(r.data.reply, "블레이저를 장바구니에 담았어요.");
  assert.equal(r.data.total, 48000);

  const [first, second] = client.requests;
  assert.match(first.system[0].text, /우리 가게는 환불이 안 됩니다\./);
  assert.match(first.system[0].text, /id=p_sample01/);
  assert.equal(first.model, "claude-opus-5-5");
  assert.equal(first.fallbacks, "default");
  // 두 번째 요청에는 도구 결과가 실려 있어야 한다
  const toolResult = second.messages.at(-1).content[0];
  assert.equal(toolResult.type, "tool_result");
  assert.equal(toolResult.tool_use_id, "tu_1");
  assert.ok(!toolResult.is_error);

  const log = (await admin("/api/admin/log")).data;
  assert.ok(log.some((e) => e.kind === "chat" && e.user === "체크 블레이저 살게요"));
});

test("AI 점원: 품절 상품을 담으려 하면 도구 오류가 모델에게 돌아간다", async (t) => {
  const client = fakeClient([
    {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu_1", name: "add_to_cart", input: { product_id: "p_sample04", quantity: 1 } }],
    },
    textReply("죄송해요, 그 가방은 품절이에요."),
  ]);
  const { call } = await start(t, { client });
  const r = await call("/api/chat", { text: "가죽 가방 주세요" });
  assert.equal(r.data.total, 0);
  const toolResult = client.requests[1].messages.at(-1).content[0];
  assert.equal(toolResult.is_error, true);
  assert.match(toolResult.content, /품절/);
});

test("AI 점원: call_owner 도구가 사장님에게 알림을 보낸다", async (t) => {
  const client = fakeClient([
    {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu_1", name: "call_owner", input: { reason: "손님이 옷에 걸려 넘어짐" } }],
    },
    textReply("사장님을 호출했어요."),
  ]);
  const { call, notices } = await start(t, { client });
  await call("/api/chat", { text: "넘어졌어요" });
  assert.deepEqual(notices, ["[사장님 호출] 손님이 옷에 걸려 넘어짐"]);
});

test("Claude 호출이 실패하면 오프라인 응대로 답하고, 다음 턴의 대화 기록이 깨지지 않는다", async (t) => {
  const client = fakeClient([new Error("network down"), textReply("네, 있어요.")]);
  const { call } = await start(t, { client });
  const sessionId = (await call("/api/session", {})).data.sessionId;

  const first = await call("/api/chat", { sessionId, text: "스카프 있어요?" });
  assert.equal(first.data.mode, "offline");
  assert.match(first.data.reply, /실크 스카프/);

  const second = await call("/api/chat", { sessionId, text: "얼마예요?" });
  assert.equal(second.data.mode, "ai");
  const roles = client.requests[1].messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "user"]);
});

test("가격표 인식: 서버가 기억한 금액으로만 담긴다", async (t) => {
  const client = fakeClient([
    textReply(JSON.stringify({ found: true, name: "코듀로이 셔츠", price: 22000 })),
    textReply(JSON.stringify({ found: false, name: "", price: 0 })),
  ]);
  const { call } = await start(t, { client });
  const sessionId = (await call("/api/session", {})).data.sessionId;
  const image = "data:image/jpeg;base64," + Buffer.from("fake").toString("base64");

  const read = await call("/api/scan-tag", { sessionId, image });
  assert.deepEqual(read.data.tag, { found: true, name: "코듀로이 셔츠", price: 22000 });
  assert.equal(client.requests[0].messages[0].content[0].type, "image");
  assert.equal(client.requests[0].output_config.format.type, "json_schema");

  // 화면에서 다른 금액을 보내도 무시된다
  const confirmed = await call("/api/scan-tag/confirm", { sessionId, price: 1 });
  assert.equal(confirmed.data.total, 22000);
  assert.equal(confirmed.data.items[0].source, "price_tag");

  const unreadable = await call("/api/scan-tag", { sessionId, image });
  assert.equal(unreadable.data.tag.found, false);
  assert.equal((await call("/api/scan-tag/confirm", { sessionId })).status, 409);
  assert.equal((await call("/api/scan-tag", { sessionId, image: "nope" })).status, 400);
});

test("정적 파일은 public 폴더 밖으로 나가지 않는다", async (t) => {
  const { base } = await start(t, { aiMode: "offline" });
  assert.equal((await fetch(base + "/")).status, 200);
  assert.equal((await fetch(base + "/admin")).status, 200);
  assert.equal((await fetch(base + "/..%2fpackage.json")).status, 404);
  assert.equal((await fetch(base + "/%2e%2e/src/config.js")).status, 404);
});

test("상품이 많으면 프롬프트에서 목록을 생략하고 검색 도구를 안내한다", () => {
  const many = Array.from({ length: 201 }, (_, i) => ({ id: `p${i}`, name: `옷${i}`, price: 1000, stock: 1 }));
  const prompt = buildSystemPrompt("", many);
  assert.match(prompt, /search_products/);
  assert.doesNotMatch(prompt, /id=p200/);
});
