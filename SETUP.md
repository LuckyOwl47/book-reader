# Setting up book-reader

A local reading harness: you read a PDF or EPUB in the browser, mark passages and screenshot
figures, and ask questions — either in the app's own chat panel or to the agent in your Claude
Code sidebar. Both sides read and write the same files on disk.

Everything runs on your machine. Nothing leaves it except the messages you send to
`api.anthropic.com` when you use the in-app chat.

This document covers getting it running and contributing changes back. For what the app
actually does once it is running, see [README.md](README.md).

---

## 1. Prerequisites

| | |
|---|---|
| **Node.js 20 or newer** | `node -v`. Install from [nodejs.org](https://nodejs.org) or `brew install node`. |
| **npm** | Ships with Node. |
| **git** | `git --version`. |
| **Claude Code** | Only if you want the sidebar agent. [claude.com/claude-code](https://claude.com/claude-code) |
| **An Anthropic API key** | Only for the *in-app* chat panel. The reader and the Claude Code sidebar both work without one. |

Tested on macOS. Linux should work as-is. On Windows use WSL — the paths and the `npm start`
flow assume a Unix shell.

---

## 2. Get the code and install

```bash
git clone <REPO_URL> book_reader
```

```bash
cd book_reader && npm install
```

`npm install` pulls `pdfjs-dist`, `epubjs`, `katex`, `express`, and the Anthropic and MCP
SDKs. KaTeX and pdf.js are served out of `node_modules/` at runtime — there is no build step
and no CDN, so the install has to succeed before the reader will render anything.

---

## 3. Configure the API key (optional)

```bash
cp .env.example .env
```

Open `.env` and set `ANTHROPIC_API_KEY` to a key from
[console.anthropic.com](https://console.anthropic.com/settings/keys).

| With a key | Without a key |
|---|---|
| In-app chat panel, **Define**, **Find related**, region-capture questions | Reading, marking, highlights, region *capture*, search, and the whole Claude Code sidebar |

`.env` is gitignored. Never commit it, and never paste a key into a chat, an issue, or a
commit message.

Two optional settings, both commented out in `.env.example`:

- `BOOK_READER_MODEL` — defaults to `claude-opus-5`
- `PORT` — defaults to `4321`

---

## 4. Run it

```bash
npm start
```

Then open **http://localhost:4321**. To use a different port: `PORT=5000 npm start`.

---

## 5. Add a book

The repo ships with **no books** — `books/` and `library/` are gitignored, so you bring your
own copies and your reading data never travels with the code.

Three ways, all from the library page at `localhost:4321`:

1. Drag a `.pdf` or `.epub` onto the page.
2. Paste an absolute path to a file already on your disk.
3. Drop files into `books/` and click **Scan books/** — or run `npm run ingest`.

Ingest extracts the text once into `library/<slug>/text/` (one file per PDF page or EPUB
section) and turns the PDF outline or EPUB nav into a table of contents. A 600-page textbook
takes a minute or two. It only happens once per book.

---

## 6. Connect the Claude Code sidebar

The repo includes `.mcp.json`, which registers a project-scoped MCP server called
`book-reader`. Open the project in Claude Code:

```bash
claude
```

Claude Code will ask once whether to trust the project's MCP server. Approve it. Then confirm
it is live:

```bash
claude mcp list
```

You should see `book-reader` connected. The agent now has `get_book`, `get_marks`,
`get_region_capture`, `get_text`, `search_book`, `list_chats`, `read_chat`, `read_inbox`,
`answer_question`, `add_note`, `comment_on_mark`, and `add_mark`. No API key is needed — it
runs inside your existing Claude Code session.

Anything the sidebar writes back shows up in the reader within a few seconds, as a thread
called *"From your Claude Code sidebar"*.

> `.mcp.json` deliberately has no `cwd`, so it works from any checkout location — Claude Code
> launches the server from the project root. If you wire this into a different MCP client that
> launches from elsewhere, add `"cwd": "<absolute path to your checkout>"` to your own local
> config rather than to the committed `.mcp.json`.

Read [CLAUDE.md](CLAUDE.md) if you want to know how the agent is instructed to use those tools.
It is loaded automatically into every Claude Code session in this project.

---

## 7. Check that it all works

Run through this once. Each step exercises a different half of the system.

- [ ] `npm start` prints a listening line and `localhost:4321` shows the library page.
- [ ] A book you add finishes ingesting and opens in the reader.
- [ ] Arrow keys turn pages; `⌘B` toggles the left rail.
- [ ] Select a sentence, right-click, **Save markdown** — it appears in
      `library/<slug>/highlights.md` on disk.
- [ ] Press `r` and drag a box around a figure — a PNG lands in `library/<slug>/clips/`.
- [ ] In Claude Code, ask *"what have I marked so far?"* — the agent calls `get_marks` and
      describes the passage you just saved.
- [ ] **With an API key only:** the chat panel answers a question about the current page.

If the last one fails but the rest pass, your key is missing or wrong — that is the only
failure mode that splits along that line.

---

## 8. Making changes and proposing them back

The point of this setup is that the agent can build features locally and hand you commits to
review. The loop:

**Never work on `main`.** Branch first:

```bash
git checkout -b feature/short-description
```

Make the change — by hand, or by asking the agent in the sidebar. Then run through the
checklist in section 7 that covers what you touched. There is no test suite; verification here
means actually opening the reader and using the feature.

Review the diff before it becomes a commit:

```bash
git diff
```

Commit and push:

```bash
git add -A && git commit -m "Short imperative summary of the change"
```

```bash
git push -u origin HEAD
```

Open a pull request against `main`:

```bash
gh pr create --fill
```

(`gh` is the [GitHub CLI](https://cli.github.com); without it, push the branch and open the PR
in the web UI.)

### Ground rules for changes

- **Never edit `library/*/text/`.** It is regenerated from the source file on every ingest, so
  edits there are silently destroyed.
- **Never commit `books/`, `library/`, or `.env`.** They are gitignored for good reason: books
  are copyrighted, `library/` is someone's private reading, and `.env` holds a live API key.
  Check `git status` before committing if you have been moving files around.
- `marks.jsonl` is append-only. Later records win; deletion is a `deleted: true` tombstone
  rather than a removed line. Preserve that if you touch mark handling.
- The file formats under `library/<slug>/` are the contract between the reader, the in-app
  chat, and the MCP server. Change one writer and you have to change the readers too — grep
  for the filename before altering a format.
- No build step and no CDN. Front-end code in `web/` is plain JS served as-is; vendored
  libraries come from `node_modules/` through the routes in `server/index.js`. Keep it that way
  unless you are deliberately introducing a bundler.

### Asking the agent to do it

The sidebar agent has the repo, `CLAUDE.md`, and the MCP tools. A workable request looks like:

> Add a keyboard shortcut for exporting the current chat to markdown. Branch off `main`,
> make the change, tell me how to verify it in the reader, and show me the diff before
> committing.

Then read the diff yourself before it is pushed. The agent proposes; you merge.

---

## 9. Troubleshooting

| Symptom | Cause |
|---|---|
| **Blank page, console 404s on `/vendor/...`** | `npm install` did not complete. Re-run it. |
| **`EADDRINUSE`** | Port 4321 is taken. `PORT=5000 npm start`. |
| **Chat panel says credentials are missing** | No `ANTHROPIC_API_KEY` in `.env`, or the server was started before you added it. Restart `npm start` — `.env` is read once at boot. |
| **`book-reader` MCP server not connected** | You are not running Claude Code from the project root, or you declined the trust prompt. `cd` to the checkout and run `claude mcp list`. |
| **Agent says the library is empty** | The MCP server reads the same `library/` the web app writes. Add a book at `localhost:4321` first. |
| **A book renders but has no selectable text** | Scanned PDF with no text layer. Marks on it carry no quotable text and search will not reach it. Use region capture, or OCR it first with `ocrmypdf`. |
| **Region capture missing on an EPUB** | Expected — it is PDF-only. An EPUB has no fixed page to crop. |

---

## Appendix: publishing this repo (for the owner)

If the project is not yet on GitHub, from the project root:

```bash
git init -b main
```

Confirm that `books/`, `library/`, and `.env` are excluded before the first commit:

```bash
git status --short
```

Nothing under `books/`, `library/`, or `.env` should be listed. If anything is, stop and fix
`.gitignore` first — a book or an API key in the initial commit stays in the history even
after you delete it.

```bash
git add -A && git commit -m "Initial commit"
```

```bash
gh repo create book-reader --private --source=. --push
```

Then give collaborators the clone URL and point them at this file. Consider protecting `main`
so changes arrive as pull requests rather than direct pushes.
