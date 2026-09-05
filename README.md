# book-reader

Read PDFs and EPUBs locally. Mark passages, screenshot figures, and ask about them —
either in the app's own chat or to the agent in your Claude Code sidebar. Both sides read
and write the same files.

```bash
npm install
cp .env.example .env      # add your ANTHROPIC_API_KEY for the in-app chat
npm start                 # http://localhost:4321
```

## Adding a book

Drop a `.pdf` or `.epub` on the library page, paste an absolute path, or put files in
`books/` and hit **Scan books/**. Text is extracted once into `library/<slug>/text/`, and
the PDF outline or EPUB nav becomes the table of contents.

## Reading

| | |
|---|---|
| `←` `→` | previous / next page (or spread) |
| **right-click a selection** | Add to context · Save markdown · Start side chat · Define · Find related · Comment |
| `p` `h` `c` `d` `f` `v` | the same six from the keyboard, while text is selected |
| `b` or `↩` | back to where you jumped from |
| `r` or **⛶ Capture** | drag a box around a figure to capture it as an image |
| `⌘B` | show / hide the left rail |
| `◱` | switch between split view and popup chat |
| `⇄ / ⇕` | turn pages, or scroll continuously |
| `▯ / ▮▮` | one page, two pages, or auto-fit |
| `+` `-` `0` | zoom in, out, back to fit (⌘/ctrl-scroll or pinch also works) |
| `☀ / ☾` or `n` | paper page or dark page |

The same right-click menu works **on the agent's replies**, not just on the book — select
part of an answer and pin it, keep it, start a new thread from it, or search the book for
it. Excerpts cut from a reply are tagged as such everywhere they surface: the rail marks
them *from a reply*, `CONTEXT.md` says they were cut from a reply rather than the book, and
both the in-app chat and the MCP tools are told plainly that those words are not the
author's. They are never highlighted on the page, because they were never on it.

**Comment…** leaves a note on a passage — as many as you like, each dated. They show in
the Context/Highlights rail under the mark, in the hover card when you pass over the
passage while reading, in `highlights.md`, and in what the chat is told about that mark.
The agent can leave them too, through the MCP `comment_on_mark` tool; its notes are blue
and prefixed `⌁`, yours are green. Commenting on unmarked text marks it first.

**Add to context** (purple) pins a passage or figure in front of the chat. A pin belongs to
the chat that was open when you made it — side chats stay separate — and the Context
section shows each pin's scope: *this chat*, *all chats*, or a struck-through *other chat*
for one that belongs elsewhere and isn't being sent. Click the scope to change it. Deleting
a chat takes its own pins and its anchor with it. **Save markdown** (green) keeps
an excerpt in `library/<slug>/highlights.md`. **Start side chat** opens a new thread
anchored to what you selected — and that anchor stays live: hovering the highlight later
shows every chat started from that passage, each with the question that opened it, and
clicking takes you back into the conversation. Start two chats from the same sentence and
both appear in the list. Highlights aren't made clickable — the pointer is hit-tested
against them instead, so you can still select text inside a passage you've marked. **Define** explains a term in the context of the sentence
it appears in.

**Find related** searches the whole book for other passages on the same subject and reports
back in the chat. Retrieval is plain tf-idf over the extracted text — it shortlists pages
sharing uncommon vocabulary — and the model then says which of them actually bear on your
question and which are word-level coincidences. Ask it about a tangency condition and it
finds the discrete-time version four hundred pages later.

Every `p.70` or `§3` in a reply is **clickable**: it takes you there. Jumps are recorded,
so `↩` in the header (or `b`) walks you back through them, as many levels as you like.
Turning pages is deliberately not recorded — it would bury the place you jumped from.

**Region capture is the one that matters for figures.** Extracted PDF text contains a
figure's caption and nothing else, so a question about a plot can only be answered from an
image. Press `r`, drag a box, and the crop — plus any text inside the box — becomes part
of the conversation.

## How the document is laid out

Two independent controls in the header, both remembered between sessions:

**Flow** — `⇄ Pages` turns one page (or spread) at a time; `⇕ Scroll` is a continuous
column through the whole book. Scrolling is virtualized: all pages exist as placeholders
so the scrollbar is honest, but only what's near the viewport is rendered, one page at a
time so it stays smooth in a 600-page textbook.

**Spread** — `▯ 1 page`, `▮▮ 2 pages`, or `▯ Auto`. Auto shows two pages whenever the
window is wide enough for both to stay readable, which is what you want with the chat in
popup mode, and drops to one when the chat is docked beside the book. In two-page mode
page 1 sits alone and the rest fall into spreads, the way the printed book opens.

**Dark page** — `☀`/`☾` in the header, or `n`. This is not a CSS invert: pdf.js is asked to
remap the page's own colours (`pageColors`), so line drawings, plots and photographs stay
readable instead of turning into negatives. Highlights switch blend mode with the theme —
`multiply` darkens over white, but over a dark page it would erase them, so they `screen`
instead. EPUBs get the same treatment through their stylesheet. Region captures follow
what you see, so a figure clipped in dark mode is saved dark.

**Zoom** — `−  100%  +` in the header, or `+` / `-` / `0` on the keyboard, or pinch /
⌘-scroll on the page. 100% means fit-to-width for the current spread, so it tracks the
window rather than being a fixed magnification; zoom multiplies that. Past the window
width the page scrolls sideways. Highlights and region boxes are stored in page
coordinates, so they stay glued to the text at every zoom level.

All three work on EPUBs too — flow and spread map onto epub.js's own paginated/scrolled
modes, and because reflowable text has no fixed page to magnify, zoom there changes the
type size instead.

## The two ways to ask

**In the app.** The chat panel calls `claude-opus-5` with vision, streaming, and prompt
caching over your pinned context. Split view gives the book two thirds of the screen;
popup mode floats the chat over a full-width page — **drag it anywhere by its header**,
and it stays where you put it. Threads are listed per document in the left rail. Needs
`ANTHROPIC_API_KEY` in `.env`.

Answers are typeset with **KaTeX** — vendored locally, no CDN — so fractions, subscripts,
dot-derivatives and displayed equations render as maths rather than as raw `$\dot{x}$`.
The markdown renderer lifts maths and code into placeholders before it runs and puts them
back afterwards; without that it would italicise `x_1` and swallow backslashes. Typesetting
happens once the reply finishes streaming, so half-written formulas don't flicker.

The chips above the composer control what each message carries: the current page's text,
how many passages are pinned, anything you've attached — and a **brief / full** toggle.
Brief caps the answer at four sentences, the answer and its main reason with nothing else.
It rides as a trailing system message, so switching modes doesn't cost you the prompt cache.

**In the Claude Code sidebar.** The `book-reader` MCP server (registered in `.mcp.json`)
exposes the same material: `get_book`, `get_marks`, `get_region_capture`, `get_text`,
`search_book`, `list_chats`, `read_chat`, `read_inbox`, `answer_question`, `add_note`,
`add_mark`. Anything the sidebar writes back appears in the reader as a thread called
"From your Claude Code sidebar" within a few seconds. No API key needed — it's your
existing session.

## Layout

```
library/<slug>/
  meta.json        title, author, format, table of contents
  source.pdf|epub  your copy of the book
  text/NNNN.txt    extracted text, one file per page (PDF) or section (EPUB)
  clips/<id>.png   region captures
  chats/<id>.json  chat threads
  marks.jsonl      append-only mark log
  highlights.md    your saved excerpts
  CONTEXT.md       marks + position, regenerated on every change
  notes.md, questions.jsonl, position.json
```

`PORT=5000 npm start` to move it off 4321.

## Limits

- **Region capture is PDF-only.** An EPUB page has no fixed rendering to crop; select the
  text instead, or capture from the PDF edition if you have one.
- Scanned PDFs with no text layer render fine but extract no text — marks on them carry no
  quotable text and search won't reach them. Capture them as regions, or OCR first
  (`ocrmypdf`).
- EPUB marks are anchored by CFI; PDF marks by matching the text back onto the page.
