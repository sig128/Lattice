const SIMPLE_METHODS = new Set(["getSlot", "getGenesisHash", "getVersion", "getLatestBlockhash"]);

export interface AllowedRpcRequest {
  method: "getSlot" | "getGenesisHash" | "getVersion" | "getLatestBlockhash" | "getBalance";
  params: unknown[];
}

export function validateRpcRequest(input: unknown): AllowedRpcRequest {
  if (!input || typeof input !== "object") throw new Error("Request body must be an object");
  const body = input as { method?: unknown; address?: unknown };
  if (typeof body.method !== "string") throw new Error("Method is required");
  if (SIMPLE_METHODS.has(body.method)) {
    const method = body.method as AllowedRpcRequest["method"];
    return {
      method,
      params: method === "getVersion" ? [] : [{ commitment: "finalized" }],
    };
  }
  if (body.method === "getBalance") {
    if (typeof body.address !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(body.address)) {
      throw new Error("A valid base58 account address is required");
    }
    return { method: "getBalance", params: [body.address, { commitment: "finalized" }] };
  }
  throw new Error(`Method not allowed: ${body.method}`);
}
