import Anthropic from "@anthropic-ai/sdk";
import { addProduct, cartTotal } from "./session.js";

// AI 점원. 사장님이 쓴 '가게 카드'와 상품 목록을 그대로 읽고 손님을 응대합니다.
// Claude 에 연결할 수 없을 때(키 없음·인터넷 끊김)는 상품 검색만 하는 오프라인 응대로 내려갑니다.

const MAX_CATALOG_IN_PROMPT = 200;
const MAX_TOOL_ROUNDS = 6;
// 안전 필터가 응답을 거절했을 때 서버가 다른 모델로 이어서 답하게 하는 옵션을 지원하는 모델
const SUPPORTS_FALLBACKS = /^claude-(opus-5|sonnet-5-5|fable-5)/;

const won = (n) => `${n.toLocaleString("ko-KR")}원`;

function productLine(p) {
  const parts = [
    `id=${p.id}`,
    p.name,
    won(p.price),
    p.stock > 0 ? `재고 ${p.stock}` : "품절",
    p.category && `분류 ${p.category}`,
    p.size && `사이즈 ${p.size}`,
    p.material && `소재 ${p.material}`,
    p.condition && `상태 ${p.condition}`,
    p.description,
  ];
  return "- " + parts.filter(Boolean).join(" | ");
}

export function buildSystemPrompt(shopCard, products) {
  const catalog =
    products.length <= MAX_CATALOG_IN_PROMPT
      ? products.map(productLine).join("\n") || "(등록된 상품이 없습니다)"
      : `(상품이 ${products.length}개라 목록을 생략했습니다. search_products 도구로 찾아보세요.)`;

  return `당신은 사장님이 자리를 비운 무인 매장의 키오스크에서 손님을 응대하는 점원입니다. 손님은 태블릿 화면이나 음성으로 말을 겁니다.

아래 '가게 카드'는 이 가게 사장님이 직접 쓴 운영 규칙입니다. 환불·교환·사이즈 안내 같은 가게 정책은 반드시 가게 카드에 적힌 대로 안내하고, 카드에 없는 정책은 지어내지 말고 모른다고 말한 뒤 사장님 호출을 권하세요.

<가게_카드>
${shopCard.trim() || "(사장님이 아직 가게 카드를 작성하지 않았습니다)"}
</가게_카드>

<상품_목록>
${catalog}
</상품_목록>

응대 방식
- 화면이 작고 음성으로도 읽어주므로 한두 문장으로 짧게 답합니다. 목록 기호나 마크다운 서식은 쓰지 않습니다.
- 손님이 쓰는 언어로 답합니다. 한국어가 아닌 언어로 물으면 그 언어로 답하세요.
- 상품의 가격·사이즈·소재·상태는 상품 목록에 있는 내용만 말합니다. 빈티지 상품은 한 점뿐인 경우가 많으니, 목록에 없는 정보는 추측하지 말고 실물 확인을 권하세요.
- 손님이 사겠다고 분명히 말한 상품만 add_to_cart 로 담습니다. 추천만 한 상품을 먼저 담지 않습니다.
- 계산은 손님이 화면의 '결제하기' 버튼을 눌러 진행합니다. 당신은 결제를 처리하거나 결제가 됐다고 말할 수 없습니다.
- 다치거나 다툼이 생긴 상황, 도난·파손, 가게 카드로 답할 수 없는 문의는 call_owner 로 사장님을 호출하고 손님에게 그렇게 했다고 알려주세요.`;
}

const TOOLS = [
  {
    name: "search_products",
    description:
      "상품 이름·분류·사이즈·소재·설명에서 키워드로 상품을 찾습니다. 상품 목록이 생략되어 있거나 손님이 찾는 조건에 맞는 상품을 확인할 때 사용합니다.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "띄어쓰기로 구분한 검색어" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "add_to_cart",
    description: "손님이 구매하겠다고 한 상품을 장바구니에 담습니다. 재고가 부족하면 오류가 돌아옵니다.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        product_id: { type: "string", description: "상품 목록의 id 값" },
        quantity: { type: "integer", description: "담을 수량" },
      },
      required: ["product_id", "quantity"],
      additionalProperties: false,
    },
  },
  {
    name: "call_owner",
    description: "사장님 휴대폰으로 호출 알림을 보냅니다. 점원이 해결할 수 없는 상황에서만 사용합니다.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { reason: { type: "string", description: "사장님이 읽을 한 문장 요약" } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
];

const TAG_SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean", description: "가격표에서 가격을 확실히 읽었는지" },
    name: { type: "string", description: "가격표나 상품에서 읽은 상품 이름. 없으면 짧은 묘사" },
    price: { type: "integer", description: "원 단위 가격. 읽지 못했으면 0" },
  },
  required: ["found", "name", "price"],
  additionalProperties: false,
};

export class Clerk {
  /** client 를 넘기면 그것을 쓰고(테스트용), 없으면 환경변수의 인증 정보로 만듭니다. */
  constructor({ store, config, notify, client }) {
    this.store = store;
    this.config = config;
    this.notify = notify;
    this.client = client ?? null;
  }

  #getClient() {
    if (this.config.aiMode === "offline") return null;
    if (!this.client) {
      try {
        this.client = new Anthropic();
      } catch (err) {
        console.error(`[AI] Claude 클라이언트를 만들 수 없어 오프라인 응대로 전환합니다: ${err.message}`);
        this.config.aiMode = "offline";
        return null;
      }
    }
    return this.client;
  }

  #request(extra) {
    const params = {
      model: this.config.model,
      max_tokens: 16000,
      ...extra,
      output_config: { effort: this.config.effort, ...extra.output_config },
    };
    if (SUPPORTS_FALLBACKS.test(this.config.model)) {
      params.betas = ["server-side-fallback-2026-07-01"];
      params.fallbacks = "default";
    }
    return params;
  }

  /** 손님의 말 한 마디에 답합니다. 반환: { text, mode: "ai" | "offline" } */
  async reply(session, userText) {
    const client = this.#getClient();
    const historyLength = session.messages.length;
    let result;
    if (client) {
      try {
        result = { text: await this.#converse(client, session, userText), mode: "ai" };
      } catch (err) {
        // 실패한 턴의 흔적을 지워 다음 요청이 깨진 대화 기록을 보내지 않게 합니다.
        session.messages.length = historyLength;
        this.#reportError(err);
      }
    }
    if (!result) {
      result = { text: this.#offlineReply(userText), mode: "offline" };
      session.messages.push(
        { role: "user", content: userText },
        { role: "assistant", content: result.text },
      );
    }
    this.store.log("chat", { session: session.id, user: userText, reply: result.text, mode: result.mode });
    return result;
  }

  async #converse(client, session, userText) {
    const turnStart = session.messages.length;
    session.messages.push({ role: "user", content: userText });
    const system = [
      {
        type: "text",
        text: buildSystemPrompt(this.store.getShopCard(), this.store.listProducts()),
        cache_control: { type: "ephemeral" },
      },
    ];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await client.beta.messages.create(
        this.#request({ system, tools: TOOLS, messages: session.messages }),
      );
      // 생각 블록 등을 포함해 응답 내용을 그대로 기록에 남겨야 다음 턴이 이어집니다.
      session.messages.push({ role: "assistant", content: response.content });

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();

      if (response.stop_reason === "refusal") {
        // 거절된 턴은 기록에서 빼고, 손님에게 보인 문장만 남깁니다.
        const sorry = "죄송해요, 그 부분은 제가 도와드리기 어려워요. 화면의 '사장님 호출'을 눌러 주세요.";
        session.messages.length = turnStart;
        session.messages.push({ role: "user", content: userText }, { role: "assistant", content: sorry });
        return sorry;
      }
      if (response.stop_reason !== "tool_use") {
        // 도구 호출이 중간에 잘린 응답을 기록에 남기면 다음 요청이 거부되므로 이 턴을 실패로 처리합니다.
        if (response.content.some((b) => b.type === "tool_use")) {
          throw new Error(`도구 호출이 완성되지 않았습니다 (stop_reason=${response.stop_reason})`);
        }
        return text || "죄송해요, 다시 한 번 말씀해 주시겠어요?";
      }

      const results = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        results.push({ type: "tool_result", tool_use_id: block.id, ...(await this.#runTool(session, block)) });
      }
      session.messages.push({ role: "user", content: results });
    }
    return "죄송해요, 처리가 길어지고 있어요. 화면의 '사장님 호출'을 눌러 주세요.";
  }

  async #runTool(session, { name, input }) {
    try {
      if (name === "search_products") {
        const found = this.store.searchProducts(input.query).slice(0, 10);
        return { content: found.map(productLine).join("\n") || "조건에 맞는 상품이 없습니다." };
      }
      if (name === "add_to_cart") {
        const product = this.store.getProduct(input.product_id);
        if (!product) return { content: "그런 id 의 상품이 없습니다.", is_error: true };
        addProduct(session, product, input.quantity, "ai");
        return { content: `담았습니다. 장바구니 합계 ${won(cartTotal(session.cart))}` };
      }
      if (name === "call_owner") {
        this.store.log("call", { session: session.id, reason: input.reason, by: "ai" });
        const sent = await this.notify(`[사장님 호출] ${input.reason}`);
        return {
          content: sent
            ? "사장님에게 알림을 보냈습니다."
            : "호출을 기록했지만 휴대폰 알림은 보내지 못했습니다. 손님에게 매장에 적힌 연락처로 직접 연락해 달라고 안내하세요.",
        };
      }
      return { content: `알 수 없는 도구: ${name}`, is_error: true };
    } catch (err) {
      return { content: err.message, is_error: true };
    }
  }

  /** 가격표 사진에서 상품명과 가격을 읽습니다. 사진은 저장하지 않습니다. */
  async readPriceTag(base64, mediaType) {
    const client = this.#getClient();
    if (!client) return { found: false, error: "가격표 인식은 AI 연결이 필요합니다." };
    try {
      const response = await client.beta.messages.create(
        this.#request({
          output_config: { format: { type: "json_schema", schema: TAG_SCHEMA } },
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
                {
                  type: "text",
                  text: "무인 매장 손님이 계산하려고 상품의 가격표를 카메라에 비췄습니다. 사진 속 가격표에서 상품 이름과 가격(원)을 읽어 주세요. 가격이 또렷하게 보이지 않거나 가격표가 여러 개라 어느 것인지 알 수 없으면 found 를 false 로 하세요. 추측하지 마세요.",
                },
              ],
            },
          ],
        }),
      );
      const text = response.content.find((b) => b.type === "text")?.text;
      if (response.stop_reason !== "end_turn" || !text) return { found: false };
      const tag = JSON.parse(text);
      if (!tag.found || !Number.isInteger(tag.price) || tag.price <= 0) return { found: false };
      return { found: true, name: tag.name.slice(0, 60) || "가격표 상품", price: tag.price };
    } catch (err) {
      this.#reportError(err);
      return { found: false, error: "지금은 가격표를 읽을 수 없습니다." };
    }
  }

  #reportError(err) {
    if (err instanceof Anthropic.AuthenticationError) {
      console.error("[AI] API 인증에 실패했습니다. ANTHROPIC_API_KEY 를 확인하세요. 오프라인 응대로 답합니다.");
    } else if (err instanceof Anthropic.RateLimitError) {
      console.error("[AI] 요청 한도를 넘었습니다. 오프라인 응대로 답합니다.");
    } else if (err instanceof Anthropic.APIConnectionError) {
      console.error("[AI] Claude 에 연결할 수 없습니다(인터넷 확인). 오프라인 응대로 답합니다.");
    } else if (err instanceof Anthropic.APIError) {
      console.error(`[AI] API 오류 ${err.status}: ${err.message}`);
    } else {
      // API 키가 없을 때도 여기로 옵니다.
      console.error(`[AI] Claude 를 호출하지 못했습니다: ${err.message} — 오프라인 응대로 답합니다.`);
    }
  }

  // AI 없이도 최소한의 안내는 하도록: 상품 검색 결과를 읽어주고, 없으면 가게 카드를 보여줍니다.
  #offlineReply(userText) {
    const found = this.store.searchProducts(userText).slice(0, 3);
    if (found.length) {
      const lines = found.map((p) => {
        const extra = [p.size && `사이즈 ${p.size}`, p.condition && `상태 ${p.condition}`].filter(Boolean);
        return `${p.name} ${won(p.price)}${extra.length ? ` (${extra.join(", ")})` : ""}${p.stock ? "" : " — 품절"}`;
      });
      return `찾으시는 상품일까요? ${lines.join(" / ")}. 상품의 바코드를 찍으면 장바구니에 담깁니다.`;
    }
    const card = this.store.getShopCard().trim();
    return (
      "지금은 AI 점원 연결이 원활하지 않아 간단한 안내만 드릴 수 있어요. " +
      (card ? `가게 안내를 보여드릴게요.\n${card.slice(0, 600)}\n` : "") +
      "더 궁금한 점은 '사장님 호출'을 눌러 주세요."
    );
  }
}
