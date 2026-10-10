/**
 * Minimal text-layer reader for UNCOMPRESSED PDFs (our fixtures and simple generated invoices).
 * Used for (a) the offline mock model and (b) extra injection screening of raw text.
 * Real invoices with compressed streams return "" here; the LLM still reads them.
 */
export function extractPdfText(bytes: Uint8Array): string {
  const src = new TextDecoder("latin1").decode(bytes);
  const lines: string[] = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(src))) {
    const body = m[1]!;
    if (/[^\x09\x0a\x0d\x20-\x7e]/.test(body.slice(0, 64))) continue; // binary / compressed
    const tj = /\(((?:\\.|[^\\)])*)\)\s*Tj/g;
    let t: RegExpExecArray | null;
    while ((t = tj.exec(body))) {
      lines.push(t[1]!.replace(/\\([()\\])/g, "$1"));
    }
  }
  return lines.join("\n");
}
