import DOMPurify from "dompurify";
import { marked } from "marked";

marked.setOptions({
  gfm: true,
  breaks: true,
});

export function renderMarkdown(markdown: string): string {
  const raw = marked.parse(markdown, { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    FORBID_TAGS: ["style", "iframe", "object", "embed", "form", "input"],
    FORBID_ATTR: ["style", "href", "onerror", "onload", "onclick"],
    ALLOW_DATA_ATTR: false,
  });
}
