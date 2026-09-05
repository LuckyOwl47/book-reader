# book-reader

A local reading harness. The user reads a PDF or EPUB in the browser, marks passages and
screenshots figures, and asks questions — either in the app's own chat panel or to you in
the Claude Code sidebar. Both read and write the same files, so you and the in-app chat
always see the same thing.

## Working with the user's reading

When they ask about "this passage", "this figure", "what I marked", or say "check my book inbox":

1. `get_book` — what they're reading, how long, where they are, the table of contents.
2. `get_marks` — the passages and figures they marked. Filter by `kind`:
   - `context` — what they pinned for the agent (purple). A pin with a `threadId` belongs
     to one in-app chat; one without is shared by all of them
   - `keep` — their saved highlights (green, mirrored to `highlights.md`)
   - `chat` — passages a side chat was started from
   - `plain` — everything else

   A mark whose header says it was cut from a chat reply is **not** the book's text — it is
   something you or the in-app chat wrote earlier. Never quote it back as if the author
   wrote it.
3. **`get_region_capture` — call this whenever the question is about a figure.** Region
   captures are screenshots of part of a page; `get_marks` flags them and gives you the
   mark id. The extracted page text contains only the caption, never the picture, so a
   question like "what do graphs (a) and (b) have in common" is unanswerable without it.
4. `get_text(from, to)` — read around a mark, or read a whole chapter.
5. `search_book` — find a phrase they half-remember.
6. `list_chats` / `read_chat` — what they've already discussed in the app's own chat, so
   you don't repeat it.
7. `read_inbox` / `answer_question` — questions filed from the app. Your answer lands in a
   chat thread named "From your Claude Code sidebar", which appears in their reader within
   a few seconds.
8. `add_note` — post something into that same thread without being asked.
9. `comment_on_mark` — leave a note on one of their marks: a correction, a pointer, something
   worth seeing next time they look at it. It appears beside the passage in their reader.
10. `add_mark` — mark a passage for them. Copy the text verbatim from `get_text` so the
   reader can highlight it in place; set `kind: "context"` to pin it in front of the
   in-app chat.

Every tool takes an optional `book` slug and otherwise uses the most recently opened book,
which is almost always the one they mean.

Quote from `get_text`, not from memory, and name the page or section. When you describe a
figure, describe what is actually in the capture — the axes, the curves, the labels — not
what a figure with that caption usually shows.

## Files

Everything is plain files under `library/<slug>/`, usable without the MCP server:

- `CONTEXT.md` — marks grouped by kind, plus reading position
- `highlights.md` — the take-away digest of `keep` marks
- `marks.jsonl` — append-only mark log (later records win; `deleted: true` is a tombstone)
- `clips/<id>.png` — region captures
- `chats/<id>.json` — in-app chat threads
- `text/NNNN.txt` — extracted text, one file per page (PDF) or section (EPUB); also the
  corpus behind the reader's "Find related" search
- `notes.md`, `questions.jsonl` — the sidebar inbox
- `meta.json`, `position.json`

Never edit `library/*/text/` — it is regenerated on ingest.

## Running it

```bash
npm start          # reader at http://localhost:4321
npm run ingest     # ingest anything new in books/
```

The in-app chat needs `ANTHROPIC_API_KEY` in `.env` (see `.env.example`); it calls
`claude-opus-5` with vision, and renders replies through KaTeX. Everything else works
without a key.
