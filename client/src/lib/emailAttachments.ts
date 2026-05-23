export type AliasEmailAttachment = {
  filename: string;
  contentType?: string | null;
  size?: number | null;
  contentBase64?: string | null;
  url?: string | null;
};

const MAX_ALIAS_ATTACHMENT_TOTAL_BYTES = 7 * 1024 * 1024;

function normalizeBase64(value: string): string {
  const comma = value.indexOf(",");
  if (value.startsWith("data:") && comma >= 0) return value.slice(comma + 1);
  return value;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export async function filesToAliasEmailAttachments(files: FileList | File[]): Promise<AliasEmailAttachment[]> {
  const list = Array.from(files);
  const totalBytes = list.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_ALIAS_ATTACHMENT_TOTAL_BYTES) {
    throw new Error("Attachments must be 7 MB total or less for alias email.");
  }
  return Promise.all(list.map(async (file) => ({
    filename: file.name || "attachment",
    contentType: file.type || "application/octet-stream",
    size: file.size,
    contentBase64: normalizeBase64(await readFileAsDataUrl(file)),
  })));
}

export function parseAliasEmailAttachments(raw: unknown): AliasEmailAttachment[] {
  if (!raw) return [];
  const parsed = typeof raw === "string" ? (() => {
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  })() : raw;
  if (!Array.isArray(parsed)) return [];
  const attachments: AliasEmailAttachment[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const filename = String(record.filename ?? record.name ?? "attachment").trim();
    if (!filename) continue;
    attachments.push({
      filename,
      contentType: typeof record.contentType === "string" ? record.contentType : typeof record.type === "string" ? record.type : null,
      size: typeof record.size === "number" ? record.size : Number(record.size) || null,
      contentBase64: typeof record.contentBase64 === "string" ? record.contentBase64 : typeof record.content === "string" ? normalizeBase64(record.content) : null,
      url: typeof record.url === "string" ? record.url : null,
    });
  }
  return attachments;
}

export function aliasAttachmentHref(attachment: AliasEmailAttachment): string | null {
  if (attachment.url) return attachment.url;
  if (!attachment.contentBase64) return null;
  const type = attachment.contentType || "application/octet-stream";
  return `data:${type};base64,${attachment.contentBase64}`;
}

export function formatAttachmentSize(size?: number | null): string {
  if (!size || !Number.isFinite(size)) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
