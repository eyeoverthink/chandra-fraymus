"""Read a Kiwix ZIM file (an offline Wikipedia) for Chandra's fact grounding. Needs only `libzim` (openZIM's official
binding, from PyPI) — no kiwix-serve, no network.

  python -I offline-wiki.py <zim> search <query> [limit]   -> JSON [{"title", "path"}]  (full text if the ZIM has the
                                                              index, else title suggestions)
  python -I offline-wiki.py <zim> intro <path>             -> JSON {"title", "path", "text"}: the article's opening,
                                                              the paragraphs before its first section heading
  python -I offline-wiki.py <zim> info                      -> JSON {"articles", "fulltext", "title", "date"}
  python -I offline-wiki.py <out.zim> make <articles.json>   -> writes a small ZIM (tests): [{"path","title","html"}]

Errors go to stderr with exit code 1; stdout is always one JSON document.
"""
import json
import re
import sys
from html.parser import HTMLParser


class Intro(HTMLParser):
    """Text of the <p> elements before the first <h2>, skipping tables, references and hidden boxes."""
    SKIP = {"table", "style", "script", "sup", "figure", "math"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.paras, self.cur, self.in_p, self.skip, self.done = [], [], False, 0, False

    def handle_starttag(self, tag, attrs):
        if self.done:
            return
        if tag == "h2":
            self.done = bool(self.paras)
        elif tag in self.SKIP:
            self.skip += 1
        elif tag == "p" and not self.skip:
            self.in_p, self.cur = True, []

    def handle_endtag(self, tag):
        if self.done:
            return
        if tag in self.SKIP and self.skip:
            self.skip -= 1
        elif tag == "p" and self.in_p:
            self.in_p = False
            text = re.sub(r"\s+", " ", "".join(self.cur)).strip()
            if len(text) > 40:
                self.paras.append(text)

    def handle_data(self, data):
        if self.in_p and not self.skip and not self.done:
            self.cur.append(data)


def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))


def main(argv):
    from libzim.reader import Archive

    zim, cmd = argv[1], argv[2]
    if cmd == "make":
        from libzim.writer import Creator, Item, StringProvider, Hint

        class Page(Item):
            def __init__(self, a): super().__init__(); self.a = a
            def get_path(self): return self.a["path"]
            def get_title(self): return self.a["title"]
            def get_mimetype(self): return "text/html"
            def get_contentprovider(self): return StringProvider(self.a["html"])
            def get_hints(self): return {Hint.FRONT_ARTICLE: True}

        with open(argv[3], encoding="utf-8") as f:
            pages = json.load(f)
        with Creator(zim).config_indexing(True, "eng") as c:
            c.set_mainpath(pages[0]["path"])
            for k, v in (("Title", "Chandra test wiki"), ("Language", "eng"), ("Date", "2026-11-14"), ("Creator", "Chandra"), ("Publisher", "Chandra"), ("Description", "test")):
                c.add_metadata(k, v)
            for p in pages:
                c.add_item(Page(p))
        out({"made": len(pages)})
        return

    arc = Archive(zim)
    if cmd == "info":
        meta = lambda k: arc.get_metadata(k).decode("utf-8", "replace") if k in arc.metadata_keys else None
        out({"articles": arc.article_count, "fulltext": arc.has_fulltext_index, "title": meta("Title"), "date": meta("Date")})
    elif cmd == "search":
        query, limit = argv[3], int(argv[4]) if len(argv) > 4 else 6
        words = [w for w in re.findall(r"[A-Za-z0-9']+", query) if len(w) > 1]
        # libzim ANDs every word and has no OR, so a loose search is built from several: the whole phrase, each pair of
        # neighbouring words, each word. An article found by more of them ranks higher (ties: the phrase's own order).
        # Loose on purpose, like the online search: the hub keeps only an article whose title is ABOUT the subject.
        tries = [query] + [" ".join(words[i:i + 2]) for i in range(len(words) - 1)] + (words if len(words) > 1 else [])
        # Title matches first — grounding wants the article whose TITLE is the subject, and in a full Wikipedia the
        # full-text vote alone can push it off a short list behind long articles that mention every word. Title
        # suggestions for the phrase and its word pairs (redirects followed to the real article), then the vote.
        from libzim.suggestion import SuggestionSearcher
        sug = SuggestionSearcher(arc)
        asked = {w.lower() for w in words}
        # a title suggestion counts only if every word of its title is in the query (the hub's own rule): otherwise the
        # pair "history of" fills the list with "History of The Beatles" before the pair "hong kong" is reached
        title_fits = lambda t: {w.lower() for w in re.findall(r"[A-Za-z0-9']+", t) if len(w) > 1} <= asked
        paths = []
        for q in [query] + [" ".join(words[i:i + 2]) for i in range(len(words) - 1)]:
            for r in sug.suggest(q).get_results(0, 10):
                p = r if isinstance(r, str) else r.path
                try:
                    e = arc.get_entry_by_path(p)
                    target = e.get_redirect_entry() if e.is_redirect else e
                except KeyError:
                    continue
                if title_fits(target.title) or title_fits(e.title):
                    paths.append(target.path)
        if arc.has_fulltext_index:
            from libzim.search import Query, Searcher
            s, score, first = Searcher(arc), {}, {}
            for q in tries[:16]:
                for r in s.search(Query().set_query(q)).get_results(0, limit * 2):
                    p = r if isinstance(r, str) else r.path
                    score[p] = score.get(p, 0) + 1
                    first.setdefault(p, len(first))
            paths += sorted(score, key=lambda p: (-score[p], first[p]))
        hits, seen = [], set()
        for p in paths:
            try:
                e = arc.get_entry_by_path(p)
                if e.is_redirect:
                    e = e.get_redirect_entry()
            except KeyError:
                continue
            if e.path in seen:
                continue
            seen.add(e.path)
            hits.append({"title": e.title, "path": e.path})
            if len(hits) >= limit:
                break
        out(hits)
    elif cmd == "intro":
        e = arc.get_entry_by_path(argv[3])
        if e.is_redirect:
            e = e.get_redirect_entry()
        item = e.get_item()
        if not item.mimetype.startswith("text/html"):
            raise ValueError(f"{e.path} is {item.mimetype}, not an article")
        p = Intro()
        p.feed(bytes(item.content).decode("utf-8", "replace"))
        out({"title": e.title, "path": e.path, "text": " ".join(p.paras)})
    else:
        raise ValueError(f"unknown command {cmd}")


if __name__ == "__main__":
    try:
        main(sys.argv)
    except Exception as ex:  # one line for the hub, never a traceback dump
        sys.stderr.write(f"{ex.__class__.__name__}: {str(ex)[:300]}\n")
        sys.exit(1)
