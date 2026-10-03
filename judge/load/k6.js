// Judge load test (PRD section 17): 100 requests per second for 60 s, p99 under 300 ms.
//
//   k6 run -e JUDGE_URL=http://127.0.0.1:8080 -e PAYLOAD=load/payload.json judge/load/k6.js
//
// Optional HMAC signing, exactly as the chainlink-ccv verifier signs:
//   -e HMAC_API_KEY=<uuid> -e HMAC_SECRET=<64+ hex chars>
// EXPECT=PASS (default) asserts every answer is HTTP 200 PASS.
import http from "k6/http";
import crypto from "k6/crypto";
import { check } from "k6";

const JUDGE_URL = __ENV.JUDGE_URL || "http://127.0.0.1:8080";
const PATH = __ENV.EVALUATE_PATH || "/v1/evaluate";
const BODY = open(__ENV.PAYLOAD || "./payload.json").trim();
const API_KEY = __ENV.HMAC_API_KEY || "";
const SECRET = __ENV.HMAC_SECRET || "";
const EXPECT = __ENV.EXPECT || "PASS";
const RATE = Number(__ENV.RATE || 100);
const DURATION = __ENV.DURATION || "60s";

export const options = {
  scenarios: {
    evaluate: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: {
    http_req_duration: ["p(99)<300"],
    checks: ["rate==1.0"],
    dropped_iterations: ["count==0"],
  },
  summaryTrendStats: ["min", "med", "avg", "p(90)", "p(95)", "p(99)", "max"],
};

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out.buffer;
}

const SECRET_BYTES = SECRET === "" ? null : hexToBytes(SECRET);
const BODY_HASH = crypto.sha256(BODY, "hex");

function headers() {
  const h = { "content-type": "application/json" };
  if (SECRET_BYTES === null) return h;
  const ts = String(Date.now());
  h["authorization"] = API_KEY;
  h["x-authorization-timestamp"] = ts;
  h["x-authorization-signature-sha256"] = crypto.hmac("sha256", SECRET_BYTES, `POST ${PATH} ${BODY_HASH} ${API_KEY} ${ts}`, "hex");
  return h;
}

export default function () {
  const res = http.post(`${JUDGE_URL}${PATH}`, BODY, { headers: headers(), tags: { name: "evaluate" } });
  check(res, {
    "status 200": (r) => r.status === 200,
    [`decision ${EXPECT}`]: (r) => r.status === 200 && r.json("decision") === EXPECT,
  });
}
