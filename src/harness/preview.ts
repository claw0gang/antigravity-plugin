import type { AgyStreamEvent } from "../protocol/agy-stream.js";

/** Native text fragments are deltas; host preview text is always cumulative.
 * Terminal response replaces the accumulated preview rather than appending it.
 * Serialization, queue bounds, and callback retirement belong to the C01 runner.
 */
export class AntigravityPreview {
  #text = "";
  accept(event: AgyStreamEvent): { text: string; delta?: string } | undefined {
    let next = this.#text;
    if (event.event === "step_update" && event.step_update.step_type === "agent_response") {
      next += event.step_update.text_delta ?? "";
    } else if (event.event === "result" && event.result.response.trim()) {
      next = event.result.response;
    }
    if (next === this.#text) return undefined;
    if (Buffer.byteLength(next, "utf8") > 2_097_152) {
      throw new Error("ANTIGRAVITY cumulative preview exceeds the 2 MiB delivery bound");
    }
    const delta = next.startsWith(this.#text) ? next.slice(this.#text.length) : undefined;
    this.#text = next;
    return { text: next, ...(delta !== undefined ? { delta } : {}) };
  }
}
