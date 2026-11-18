import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./src/config.js";
import { Store } from "./src/store.js";
import { Sessions, cartView, addProduct, addTagItem, removeLine } from "./src/session.js";
import { Clerk } from "./src/clerk.js";
import { createNotifier } from "./src/notify.js";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
const MAX_BODY = 6 * 1024 * 1024; // 가격표 사진 한 장이 들어갈 크기
const IMAGE_DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "요청이 너무 큽니다."));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "JSON 형식이 올바르지 않습니다."));
      }
    });
    req.on("error", reject);
  });
}

export function createApp(config = loadConfig(), deps = {}) {
  const store = new Store(config);
  const sessions = new Sessions(config.sessionIdleMs);
  const notify = deps.notify ?? createNotifier(config.notifyUrl);
  const clerk = new Clerk({ store, config, notify, client: deps.client });
  const publicDir = path.join(config.root, "public");
  const pinFailures = { count: 0, lockedUntil: 0 };

  function requireAdmin(req) {
    if (Date.now() < pinFailures.lockedUntil) throw new HttpError(429, "잠시 후 다시 시도하세요.");
    const given = Buffer.from(String(req.headers["x-admin-pin"] || ""));
    const expected = Buffer.from(config.adminPin);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      // PIN 을 마구 대입하지 못하도록 10번 틀리면 5분간 잠급니다.
      if (++pinFailures.count >= 10) {
        pinFailures.count = 0;
        pinFailures.lockedUntil = Date.now() + 5 * 60 * 1000;
      }
      throw new HttpError(401, "관리자 PIN 이 올바르지 않습니다.");
    }
    pinFailures.count = 0;
  }

  // 손님 화면 API ---------------------------------------------------------
  const customer = {
    "POST /api/session": (body) => {
      const session = sessions.get(body.sessionId);
      return {
        ...cartView(session),
        aiMode: config.aiMode,
        payment: { qrUrl: config.paymentQrUrl, note: config.paymentNote },
      };
    },

    "POST /api/chat": async (body) => {
      const text = String(body.text || "").trim().slice(0, 500);
      if (!text) throw new HttpError(400, "내용이 비어 있습니다.");
      const session = sessions.get(body.sessionId);
      const reply = await clerk.reply(session, text);
      return { ...cartView(session), reply: reply.text, mode: reply.mode };
    },

    // 바코드 리더기(키보드 입력 방식)가 읽은 값
    "POST /api/scan": (body) => {
      const session = sessions.get(body.sessionId);
      const code = String(body.code || "").trim();
      const product = store.findByBarcode(code);
      store.log("scan", { session: session.id, code, matched: product?.id || null });
      if (!product) {
        return { ...cartView(session), ok: false, message: "등록되지 않은 바코드예요. 가격표 촬영이나 사장님 호출을 이용해 주세요." };
      }
      try {
        addProduct(session, product, 1, "barcode");
      } catch (err) {
        return { ...cartView(session), ok: false, message: err.message };
      }
      return { ...cartView(session), ok: true, message: `${product.name}을(를) 담았어요.` };
    },

    "POST /api/cart/remove": (body) => {
      const session = sessions.get(body.sessionId);
      removeLine(session, body.index);
      return cartView(session);
    },

    // 바코드가 없는 상품: 가격표를 찍으면 AI 가 읽고, 손님이 확인하면 담습니다.
    "POST /api/scan-tag": async (body) => {
      const session = sessions.get(body.sessionId);
      const match = IMAGE_DATA_URL.exec(String(body.image || ""));
      if (!match) throw new HttpError(400, "사진을 읽을 수 없습니다.");
      const tag = await clerk.readPriceTag(match[2], match[1]);
      session.pendingTag = tag.found ? { name: tag.name, price: tag.price } : null;
      store.log("tag", { session: session.id, found: tag.found, name: tag.name, price: tag.price });
      return { ...cartView(session), tag };
    },

    "POST /api/scan-tag/confirm": (body) => {
      const session = sessions.get(body.sessionId);
      // 금액은 서버가 기억해 둔 인식 결과만 사용합니다(화면에서 보낸 값을 믿지 않음).
      if (!session.pendingTag) throw new HttpError(409, "확인할 가격표가 없습니다.");
      addTagItem(session, session.pendingTag);
      session.pendingTag = null;
      return cartView(session);
    },

    "POST /api/checkout": (body) => {
      const session = sessions.get(body.sessionId);
      if (!session.cart.length) throw new HttpError(409, "장바구니가 비어 있습니다.");
      // 담아둔 사이 다른 손님이 사 갔을 수 있으니 재고를 다시 확인합니다.
      for (const item of session.cart) {
        const product = item.productId && store.getProduct(item.productId);
        if (item.productId && (!product || product.stock < item.quantity)) {
          throw new HttpError(409, `'${item.name}'의 재고가 부족합니다. 장바구니에서 빼 주세요.`);
        }
      }
      // 결제 화면을 다시 연 경우 이전의 미결제 주문은 취소 처리합니다.
      if (session.orderId) store.setOrderStatus(session.orderId, "cancelled", ["pending"]);
      const order = store.createOrder(session.cart.map((i) => ({ ...i })));
      session.orderId = order.id;
      return { ...cartView(session), order, payment: { qrUrl: config.paymentQrUrl, note: config.paymentNote } };
    },

    // 손님이 "송금했어요"를 누름. 실제 입금 여부는 사장님이 관리 화면에서 확인합니다.
    "POST /api/checkout/paid": async (body) => {
      const session = sessions.get(body.sessionId);
      const order = session.orderId && store.setOrderStatus(session.orderId, "customer_confirmed", ["pending"]);
      if (!order) throw new HttpError(409, "진행 중인 주문이 없습니다.");
      const names = order.items.map((i) => `${i.name}×${i.quantity}`).join(", ");
      await notify(`[결제 확인 요청] ${order.total.toLocaleString("ko-KR")}원 — ${names} (주문 ${order.id})`);
      sessions.end(session.id);
      return { ok: true, order };
    },

    "POST /api/checkout/cancel": (body) => {
      const session = sessions.get(body.sessionId);
      if (session.orderId) store.setOrderStatus(session.orderId, "cancelled", ["pending"]);
      session.orderId = null;
      return cartView(session);
    },

    "POST /api/call-owner": async (body) => {
      const session = sessions.get(body.sessionId);
      const reason = String(body.reason || "손님이 호출 버튼을 눌렀습니다.").slice(0, 200);
      store.log("call", { session: session.id, reason, by: "button" });
      const sent = await notify(`[사장님 호출] ${reason}`);
      return { ok: true, sent };
    },
  };

  // 사장님 관리 화면 API (x-admin-pin 헤더 필요) ---------------------------
  const admin = {
    "GET /api/admin/products": () => store.listProducts(),
    "POST /api/admin/products": (body) => {
      try {
        return store.saveProduct(body);
      } catch (err) {
        throw new HttpError(400, err.message);
      }
    },
    "POST /api/admin/products/delete": (body) => {
      store.deleteProduct(body.id);
      return { ok: true };
    },
    "GET /api/admin/shop-card": () => ({ text: store.getShopCard() }),
    "POST /api/admin/shop-card": (body) => {
      store.setShopCard(String(body.text ?? "").slice(0, 20000));
      return { ok: true };
    },
    "GET /api/admin/sales": (_body, query) => store.salesSummary(query.get("date") || undefined),
    "POST /api/admin/orders/status": (body) => {
      if (!["confirmed", "cancelled"].includes(body.status)) throw new HttpError(400, "잘못된 상태입니다.");
      const order = store.setOrderStatus(body.id, body.status);
      if (!order) throw new HttpError(404, "주문을 찾을 수 없습니다.");
      return order;
    },
    "GET /api/admin/log": (_body, query) => store.readLog(query.get("date") || undefined),
  };

  function serveStatic(pathname, res) {
    const rel = pathname === "/" ? "index.html" : pathname === "/admin" ? "admin.html" : pathname.slice(1);
    const file = path.resolve(publicDir, rel);
    // public 폴더 밖의 파일은 내보내지 않습니다.
    if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("찾을 수 없습니다.");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(file).pipe(res);
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const key = `${req.method} ${url.pathname}`;
    const handler = customer[key] || admin[key];
    try {
      if (!handler) {
        if (req.method === "GET" && !url.pathname.startsWith("/api/")) return serveStatic(url.pathname, res);
        throw new HttpError(404, "없는 주소입니다.");
      }
      if (admin[key]) requireAdmin(req);
      const body = req.method === "POST" ? await readJson(req) : {};
      const result = await handler(body, url.searchParams);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(result));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      res
        .writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
        .end(JSON.stringify({ error: status === 500 ? "서버 오류가 발생했습니다." : err.message }));
    }
  });
}

// `node server.js` 로 직접 실행했을 때만 서버를 띄웁니다.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  createApp(config).listen(config.port, "0.0.0.0", () => {
    console.log(`Side by AI 키오스크가 켜졌습니다.`);
    console.log(`  손님 화면  http://localhost:${config.port}/`);
    console.log(`  관리 화면  http://localhost:${config.port}/admin`);
    console.log(`  AI 모드    ${config.aiMode === "offline" ? "오프라인 응대" : config.model}`);
    if (config.adminPinGenerated) {
      console.log(`  관리자 PIN ${config.adminPin}  (ADMIN_PIN 을 설정하지 않아 이번 실행에만 쓰는 임시 PIN 입니다)`);
    }
  });
}
