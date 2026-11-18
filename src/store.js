import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// 작은 가게 한 곳을 위한 파일 저장소입니다.
// 상품·가게 카드·주문은 JSON/Markdown 파일 그대로라 사장님이 메모장으로도 고칠 수 있습니다.

const today = () => localDate(new Date());

export function localDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class Store {
  constructor({ dataDir, presetDir }) {
    this.dir = dataDir;
    fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });
    // 처음 실행하면 업종 프리셋을 복사해 바로 써볼 수 있게 합니다.
    for (const name of ["products.json", "shop-card.md"]) {
      const target = path.join(dataDir, name);
      const preset = presetDir && path.join(presetDir, name);
      if (!fs.existsSync(target)) {
        if (preset && fs.existsSync(preset)) fs.copyFileSync(preset, target);
        else fs.writeFileSync(target, name.endsWith(".json") ? "[]\n" : "");
      }
    }
    if (!fs.existsSync(this.#file("orders.json"))) this.#write("orders.json", []);
  }

  #file(name) {
    return path.join(this.dir, name);
  }
  #read(name) {
    return JSON.parse(fs.readFileSync(this.#file(name), "utf8"));
  }
  #write(name, value) {
    // 쓰는 도중 전원이 꺼져도 파일이 깨지지 않도록 임시 파일에 쓴 뒤 바꿉니다.
    const tmp = this.#file(name) + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
    fs.renameSync(tmp, this.#file(name));
  }

  // ---- 가게 카드 ----
  getShopCard() {
    return fs.readFileSync(this.#file("shop-card.md"), "utf8");
  }
  setShopCard(text) {
    fs.writeFileSync(this.#file("shop-card.md"), String(text));
  }

  // ---- 상품 ----
  listProducts() {
    return this.#read("products.json");
  }
  getProduct(id) {
    return this.listProducts().find((p) => p.id === id) || null;
  }
  findByBarcode(code) {
    const c = String(code).trim();
    return this.listProducts().find((p) => p.barcode && p.barcode === c) || null;
  }
  searchProducts(query) {
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return this.listProducts()
      .map((p) => {
        const hay = [p.name, p.category, p.size, p.material, p.description, p.condition]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return { p, score: words.filter((w) => hay.includes(w)).length };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.p);
  }
  saveProduct(input) {
    const products = this.listProducts();
    const price = Number(input.price);
    if (!input.name || !Number.isInteger(price) || price < 0) {
      throw new Error("상품명과 0원 이상의 가격(정수)이 필요합니다.");
    }
    const barcode = input.barcode ? String(input.barcode).trim() : "";
    const clash = barcode && products.find((p) => p.barcode === barcode && p.id !== input.id);
    if (clash) throw new Error(`이미 '${clash.name}'에 등록된 바코드입니다.`);
    const stock = input.stock === "" || input.stock == null ? 1 : Number(input.stock);
    if (!Number.isInteger(stock) || stock < 0) throw new Error("재고는 0 이상의 정수여야 합니다.");

    const fields = {
      name: String(input.name).trim(),
      price,
      stock,
      barcode,
      category: input.category || "",
      size: input.size || "",
      material: input.material || "",
      condition: input.condition || "",
      description: input.description || "",
    };
    const existing = input.id && products.find((p) => p.id === input.id);
    if (existing) Object.assign(existing, fields);
    else products.push({ id: "p_" + crypto.randomBytes(4).toString("hex"), ...fields });
    this.#write("products.json", products);
    return existing || products.at(-1);
  }
  deleteProduct(id) {
    this.#write("products.json", this.listProducts().filter((p) => p.id !== id));
  }

  // ---- 주문 ----
  listOrders() {
    return this.#read("orders.json");
  }
  createOrder(items) {
    const orders = this.listOrders();
    const order = {
      id: "o_" + crypto.randomBytes(4).toString("hex"),
      createdAt: new Date().toISOString(),
      date: today(),
      // pending → customer_confirmed(손님이 송금했다고 누름) → confirmed(사장님 입금 확인) / cancelled
      status: "pending",
      items,
      total: items.reduce((s, i) => s + i.price * i.quantity, 0),
    };
    orders.push(order);
    this.#write("orders.json", orders);
    return order;
  }
  setOrderStatus(id, status, allowedFrom) {
    const orders = this.listOrders();
    const order = orders.find((o) => o.id === id);
    if (!order) return null;
    if (allowedFrom && !allowedFrom.includes(order.status)) return order;
    const was = order.status;
    order.status = status;
    // 손님이 결제를 마쳤다고 한 시점에 재고를 줄이고, 취소되면 되돌립니다.
    const paidLike = (s) => s === "customer_confirmed" || s === "confirmed";
    if (paidLike(status) !== paidLike(was)) this.#adjustStock(order, paidLike(status) ? -1 : 1);
    this.#write("orders.json", orders);
    return order;
  }
  #adjustStock(order, sign) {
    const products = this.listProducts();
    for (const item of order.items) {
      const p = item.productId && products.find((x) => x.id === item.productId);
      if (p) p.stock = Math.max(0, p.stock + sign * item.quantity);
    }
    this.#write("products.json", products);
  }
  salesSummary(date = today()) {
    const orders = this.listOrders().filter((o) => o.date === date);
    const sum = (list) => list.reduce((s, o) => s + o.total, 0);
    const by = (status) => orders.filter((o) => o.status === status);
    return {
      date,
      confirmed: { count: by("confirmed").length, total: sum(by("confirmed")) },
      awaitingOwner: { count: by("customer_confirmed").length, total: sum(by("customer_confirmed")) },
      orders: orders.reverse(),
    };
  }

  // ---- 기록 (응대 로그·사장님 호출) ----
  // 음성·사진은 저장하지 않고, 글로 오간 내용만 날짜별 파일에 남깁니다.
  log(kind, entry) {
    const line = JSON.stringify({ at: new Date().toISOString(), kind, ...entry }) + "\n";
    fs.appendFileSync(path.join(this.dir, "logs", `${today()}.jsonl`), line);
  }
  readLog(date = today()) {
    const file = path.join(this.dir, "logs", `${date}.jsonl`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }
}
