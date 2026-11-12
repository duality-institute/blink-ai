export const MARKETING_EXAMPLES = {
  monitor: {
    title: "Monitor · 2 screenshots",
    answer: "## Use cursor pagination for large result sets\n\nDeep `OFFSET` pages get slower because the database still skips earlier rows. Page from the last item instead, using a unique ID to break timestamp ties.\n\n```sql\nSELECT id, created_at, payload\nFROM events\nWHERE (created_at, id) < ($1, $2)\nORDER BY created_at DESC, id DESC\nLIMIT 50;\n```\n\n**Index:** `(created_at DESC, id DESC)` supports this access pattern. Pass the last row’s timestamp and ID as the next cursor; omit `WHERE` on the first page.\n\n**Trade-off:** no direct jump to page 100. Keep ordering fields non-null and immutable; use a fixed snapshot for a consistent export.",
  },
  meeting: {
    title: "Meeting · transcript + 2 screenshots",
    answer: "## Design the RAG pipeline\n\nEvaluate retrieval and generation separately.\n\n- **Retrieve:** hybrid search over versioned documents, then rerank the top hits.\n- **Ground:** cite retrieved passages; abstain when evidence is missing.\n- **Measure:** Recall@k, answer correctness, groundedness, and p95 latency.\n\n**Follow-up:** Use held-out questions, including unanswerable ones. Refresh the index when documents change.",
  },
} as const;

export const MARKETING_TRANSCRIPT = [
  { id: "1", speaker: "them", text: "Design a RAG assistant for internal documents. How would you reduce hallucinations?" },
  { id: "2", speaker: "you", text: "How often do the documents change, and what latency should we target?" },
  { id: "3", speaker: "them", text: "They change daily. The prompt has the requirements; the diagram shows our current pipeline. Walk me through the design." },
] as const;
