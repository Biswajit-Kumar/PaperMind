// One-off script: extract page-wise text from the eval corpus PDFs using the
// same PDFLoader the production ingestion pipeline uses, so eval segments
// match prod segments exactly. Writes datasets/papers/<slug>.pages.json -
// [{ page, text }] - which dataset.jsonl page numbers are checked against and
// strategies.js builds chunks from.
//
// The source PDFs themselves aren't committed (no need to carry third-party
// paper binaries in the repo when the extracted text is what's actually
// used) - re-download them first if datasets/papers/*.pdf is missing:
//   curl -L -o eval/datasets/papers/attention.pdf https://arxiv.org/pdf/1706.03762
//   curl -L -o eval/datasets/papers/bert.pdf       https://arxiv.org/pdf/1810.04805
//   curl -L -o eval/datasets/papers/rag.pdf        https://arxiv.org/pdf/2005.11401
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const papersDir = path.join(__dirname, "datasets", "papers");

const PAPERS = [
  { slug: "attention-is-all-you-need", file: "attention.pdf" },
  { slug: "bert", file: "bert.pdf" },
  { slug: "rag", file: "rag.pdf" },
];

for (const { slug, file } of PAPERS) {
  const filePath = path.join(papersDir, file);
  const loader = new PDFLoader(filePath);
  const docs = await loader.load();
  const pages = docs.map((doc, i) => ({
    page: doc.metadata?.loc?.pageNumber ?? i + 1,
    text: doc.pageContent.trim(),
  }));
  const outPath = path.join(papersDir, `${slug}.pages.json`);
  await fs.writeFile(outPath, JSON.stringify(pages, null, 2));
  console.log(`${slug}: ${pages.length} pages -> ${outPath}`);
}
