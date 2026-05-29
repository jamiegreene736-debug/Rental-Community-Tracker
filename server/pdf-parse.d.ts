declare module "pdf-parse/lib/pdf-parse.js" {
  type PdfParseResult = {
    numpages: number;
    text: string;
  };
  export default function pdf(data: Buffer | Uint8Array): Promise<PdfParseResult>;
}
