// 사장님 관리 화면. PIN 은 이 탭을 닫으면 사라지도록 sessionStorage 에만 둡니다.
const $ = (id) => document.getElementById(id);
const won = (n) => n.toLocaleString("ko-KR") + "원";
const time = (iso) => new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
const todayStr = () => {
  const d = new Date();
  return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const STATUS = {
  pending: "미결제",
  customer_confirmed: "확인 대기",
  confirmed: "입금 확인",
  cancelled: "취소",
};

let pin = "";
try {
  pin = sessionStorage.getItem("pin") || "";
} catch {
  /* 저장소를 못 쓰는 환경이면 매번 입력 */
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "x-admin-pin": pin },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 429) {
    showLogin(data.error);
    throw new Error(data.error);
  }
  if (!res.ok) throw new Error(data.error || "요청에 실패했습니다.");
  return data;
}

function cell(text, className) {
  const td = document.createElement("td");
  if (className) td.className = className;
  td.textContent = text ?? "";
  return td;
}
function actionCell(...buttons) {
  const td = document.createElement("td");
  for (const [label, onClick] of buttons) {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", onClick);
    td.append(b, " ");
  }
  return td;
}
function row(...cells) {
  const tr = document.createElement("tr");
  tr.append(...cells);
  return tr;
}

// ---- 로그인 ----
function showLogin(message = "") {
  $("login").hidden = false;
  $("app").hidden = true;
  $("login-msg").textContent = message;
}
async function enter() {
  await loadCard();
  try {
    sessionStorage.setItem("pin", pin);
  } catch {
    /* 무시 */
  }
  $("login").hidden = true;
  $("app").hidden = false;
}
$("login-form").addEventListener("submit", (e) => {
  e.preventDefault();
  pin = $("pin").value.trim();
  $("pin").value = "";
  enter().catch(() => {});
});

// ---- 탭 ----
const loaders = { card: loadCard, products: loadProducts, sales: loadSales, log: loadLog };
document.querySelectorAll("[data-tab]").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll("[data-tab]").forEach((t) => t.setAttribute("aria-selected", t === tab));
    document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== tab.dataset.tab));
    loaders[tab.dataset.tab]().catch(() => {});
  });
});

// ---- 가게 카드 ----
async function loadCard() {
  $("card-text").value = (await api("/api/admin/shop-card")).text;
}
$("card-save").addEventListener("click", async () => {
  try {
    await api("/api/admin/shop-card", { text: $("card-text").value });
    $("card-msg").textContent = "저장했습니다. 다음 손님부터 바로 적용됩니다.";
  } catch (err) {
    $("card-msg").textContent = err.message;
  }
});

// 말로 규칙을 추가: 받아쓴 문장을 카드 끝에 붙입니다. 저장을 눌러야 반영됩니다.
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (Recognition && window.isSecureContext) {
  const rec = new Recognition();
  rec.lang = "ko-KR";
  rec.onresult = (e) => {
    const area = $("card-text");
    area.value = area.value.trimEnd() + (area.value.trim() ? "\n" : "") + e.results[0][0].transcript + "\n";
    $("card-msg").textContent = "받아 적었습니다. 내용을 확인하고 저장을 눌러 주세요.";
  };
  $("card-dictate").hidden = false;
  $("card-dictate").addEventListener("click", () => {
    try {
      rec.start();
      $("card-msg").textContent = "듣고 있어요…";
    } catch {
      rec.stop();
    }
  });
}

// ---- 상품 ----
const form = $("product-form");
function fillForm(product) {
  form.reset();
  for (const [key, value] of Object.entries(product || {})) {
    if (form.elements[key]) form.elements[key].value = value;
  }
  $("product-title").textContent = product ? "상품 수정" : "상품 등록";
  $("product-msg").textContent = "";
}
async function loadProducts() {
  const products = await api("/api/admin/products");
  $("product-rows").replaceChildren(
    ...products.map((p) =>
      row(
        cell([p.name, p.size, p.condition].filter(Boolean).join(" · ")),
        cell(p.barcode || "-"),
        cell(won(p.price), "num"),
        cell(p.stock, "num"),
        actionCell(
          ["수정", () => { fillForm(p); form.scrollIntoView({ behavior: "smooth" }); }],
          ["삭제", async () => {
            if (!confirm(`'${p.name}'을(를) 삭제할까요?`)) return;
            await api("/api/admin/products/delete", { id: p.id });
            loadProducts();
          }],
        ),
      ),
    ),
  );
}
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  data.price = Number(data.price);
  try {
    const saved = await api("/api/admin/products", data);
    fillForm(null);
    $("product-msg").textContent = `'${saved.name}'을(를) 저장했습니다.`;
    form.elements.barcode.focus();
    loadProducts();
  } catch (err) {
    $("product-msg").textContent = err.message;
  }
});
// 바코드 칸에서 리더기가 누르는 Enter 로 폼이 제출되지 않게 하고 상품명 칸으로 넘깁니다.
form.elements.barcode.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    form.elements.name.focus();
  }
});
$("product-reset").addEventListener("click", () => fillForm(null));

// ---- 매출·주문 ----
async function loadSales() {
  const date = $("sales-date").value || todayStr();
  $("sales-date").value = date;
  const s = await api(`/api/admin/sales?date=${date}`);
  $("stat-confirmed").textContent = `${won(s.confirmed.total)} (${s.confirmed.count}건)`;
  $("stat-waiting").textContent = `${won(s.awaitingOwner.total)} (${s.awaitingOwner.count}건)`;
  const setStatus = (id, status) => async () => {
    await api("/api/admin/orders/status", { id, status });
    loadSales();
  };
  $("order-rows").replaceChildren(
    ...s.orders.map((o) =>
      row(
        cell(time(o.createdAt)),
        cell(
          o.items
            .map((i) => `${i.name}×${i.quantity}${i.source === "price_tag" ? " (가격표 인식)" : ""}`)
            .join(", "),
        ),
        cell(won(o.total), "num"),
        cell(STATUS[o.status] || o.status),
        o.status === "confirmed" || o.status === "cancelled"
          ? cell("")
          : actionCell(["입금 확인", setStatus(o.id, "confirmed")], ["취소", setStatus(o.id, "cancelled")]),
      ),
    ),
  );
}
$("sales-date").addEventListener("change", () => loadSales().catch(() => {}));

// ---- 응대 기록 ----
const KIND = { chat: "대화", scan: "바코드", tag: "가격표", call: "호출" };
function describe(e) {
  if (e.kind === "chat") return `손님: ${e.user}\n점원${e.mode === "offline" ? "(오프라인)" : ""}: ${e.reply}`;
  if (e.kind === "scan") return `${e.code} → ${e.matched ? "담김" : "미등록"}`;
  if (e.kind === "tag") return e.found ? `${e.name} ${won(e.price)}` : "읽지 못함";
  if (e.kind === "call") return e.reason;
  return JSON.stringify(e);
}
async function loadLog() {
  const date = $("log-date").value || todayStr();
  $("log-date").value = date;
  const entries = await api(`/api/admin/log?date=${date}`);
  $("log-rows").replaceChildren(
    ...entries.reverse().map((e) => {
      const body = cell(describe(e));
      body.style.whiteSpace = "pre-wrap";
      return row(cell(time(e.at)), cell(KIND[e.kind] || e.kind), body);
    }),
  );
}
$("log-date").addEventListener("change", () => loadLog().catch(() => {}));

// ---- 시작 ----
if (pin) enter().catch(() => {});
