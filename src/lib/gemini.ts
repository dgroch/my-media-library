import "server-only";

// Gemini vision manifesting — the in-app port of the brand-asset-manifesting
// skill's image path. Given an uploaded image we ask a Gemini vision model for
// a structured manifest (description, content type, tags, products, …) and
// return it as a typed object. The caller writes the result into the Manifest's
// AI channel (see writeManifest in assets.ts).
//
// Best-effort by contract: every entry point throws on failure and the upload
// route swallows it, so a manifesting outage never blocks an upload.

import { geminiConfig } from "./config";

// ---------------------------------------------------------------------------
// Shapes — the JSON the model is asked to return.
// ---------------------------------------------------------------------------

export interface ManifestBeat {
  start_s: number;
  end_s: number;
  shot_description: string;
  shot_type: string;
  ai_usefulness: string;
}

export interface ProductClassification {
  contains_product: boolean;
  product_name: string | null;
  confidence: number;
}

export interface AssetManifest {
  overall_description: string;
  content_type: string;
  mood_tone: string[];
  visual_tags: string[];
  people_present: string;
  products_or_flowers: string[];
  setting_location: string;
  usable_for: string[];
  reorg_notes: string;
  product_classification?: ProductClassification;
  beats?: ManifestBeat[];
}

export interface ImageManifestInput {
  buffer: Buffer;
  mimeType: string;
  filename: string;
  width?: number;
  height?: number;
}

// ---------------------------------------------------------------------------
// Prompt — mirrors the skill's image prompt and JSON contract.
// ---------------------------------------------------------------------------

const SCHEMA_BLOCK = `{
  "overall_description": "2-4 sentences describing the asset",
  "content_type": "short category (e.g. lifestyle, product shot, behind-the-scenes)",
  "mood_tone": ["a few mood/tone tags"],
  "visual_tags": ["concrete visual tags — objects, colours, composition"],
  "people_present": "none | one | multiple | unclear, plus a short note",
  "products_or_flowers": ["named products or flower types visible"],
  "setting_location": "brief description of the setting",
  "usable_for": ["likely future uses — e.g. email hero, social tile"],
  "reorg_notes": "short filing guidance"PRODUCT_BLOCK
}`;

const PRODUCT_BLOCK = `,
  "product_classification": {
    "contains_product": true,
    "product_name": "exact catalogue name or null",
    "confidence": 0.0
  }`;

function imagePrompt(input: ImageManifestInput): string {
  const dims =
    input.width && input.height
      ? ` Dimensions ${input.width}x${input.height}, aspect ${(
          input.width / input.height
        ).toFixed(2)}.`
      : "";
  const schema = SCHEMA_BLOCK.replace(
    "PRODUCT_BLOCK",
    geminiConfig.productClassification ? PRODUCT_BLOCK : "",
  );
  return (
    `Create a brand asset manifest entry for this image. ` +
    `Original filename: ${input.filename}.${dims} ` +
    `Describe only what is actually visible — do not invent details. ` +
    `Return ONLY JSON matching this shape:\n${schema}`
  );
}

// ---------------------------------------------------------------------------
// Provider calls
// ---------------------------------------------------------------------------

async function callGoogle(prompt: string, input: ImageManifestInput): Promise<string> {
  const url =
    `${geminiConfig.googleBaseUrl}/models/${geminiConfig.model}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": geminiConfig.apiKey,
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            {
              inline_data: {
                mime_type: input.mimeType,
                data: input.buffer.toString("base64"),
              },
            },
          ],
        },
      ],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
    }),
  });
  if (!res.ok) {
    throw new Error(`Gemini (google) failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = json.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? "")
    .join("");
  if (!text) throw new Error("Gemini (google) returned no text");
  return text;
}

async function callOpenRouter(
  prompt: string,
  input: ImageManifestInput,
): Promise<string> {
  const res = await fetch(`${geminiConfig.openrouterBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${geminiConfig.apiKey}`,
    },
    body: JSON.stringify({
      model: geminiConfig.model,
      response_format: { type: "json_object" },
      temperature: 0.2,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: {
                url: `data:${input.mimeType};base64,${input.buffer.toString("base64")}`,
              },
            },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Gemini (openrouter) failed (${res.status}): ${await res.text()}`,
    );
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error("Gemini (openrouter) returned no text");
  return text;
}

// ---------------------------------------------------------------------------
// Parsing — be forgiving of stray prose or code fences around the JSON.
// ---------------------------------------------------------------------------

function parseManifest(raw: string): AssetManifest {
  let text = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) text = fence[1].trim();
  if (text[0] !== "{") {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
  }
  const obj = JSON.parse(text) as Record<string, unknown>;

  const strArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];

  const manifest: AssetManifest = {
    overall_description: String(obj.overall_description ?? "").trim(),
    content_type: String(obj.content_type ?? "").trim(),
    mood_tone: strArray(obj.mood_tone),
    visual_tags: strArray(obj.visual_tags),
    people_present: String(obj.people_present ?? "").trim(),
    products_or_flowers: strArray(obj.products_or_flowers),
    setting_location: String(obj.setting_location ?? "").trim(),
    usable_for: strArray(obj.usable_for),
    reorg_notes: String(obj.reorg_notes ?? "").trim(),
  };

  const pc = obj.product_classification as Record<string, unknown> | undefined;
  if (pc && typeof pc === "object") {
    const name =
      pc.product_name == null ? null : String(pc.product_name).trim() || null;
    manifest.product_classification = {
      contains_product: Boolean(pc.contains_product),
      product_name: name,
      confidence: Number(pc.confidence) || 0,
    };
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Analyse an image and return its manifest. Throws when Gemini is not
 * configured or the call fails — callers treat manifesting as best-effort.
 */
export async function manifestImage(
  input: ImageManifestInput,
): Promise<AssetManifest> {
  if (!geminiConfig.apiKey) {
    throw new Error("Gemini is not configured (set GEMINI_API_KEY).");
  }
  const prompt = imagePrompt(input);
  const raw =
    geminiConfig.provider === "openrouter"
      ? await callOpenRouter(prompt, input)
      : await callGoogle(prompt, input);
  return parseManifest(raw);
}
