// Self-contained: Chrome serializes this function into the isolated content-script world.
export function capturePaper() {
  const clean = text => String(text || "").replace(/\r/g, "").replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const meta = names => names.map(name => document.querySelector(`meta[name="${name}" i],meta[property="${name}" i]`)?.content).find(Boolean) || "";
  const title = clean(meta(["citation_title", "dc.title", "og:title"]) || document.querySelector("h1")?.textContent || document.title);
  const doi = clean(meta(["citation_doi", "dc.identifier", "prism.doi"]).replace(/^https?:\/\/(?:dx\.)?doi.org\//i, "").replace(/^doi:\s*/i, ""));
  const abstractElement = document.querySelector('[data-testid="abstract"],#abstract,.abstract,[role="doc-abstract"],[itemprop="abstract"]');
  const abstract = clean(abstractElement?.innerText || meta(["citation_abstract", "dc.description"]));
  const selected = clean(window.getSelection()?.toString());
  const article = document.querySelector('article,[role="main"],main,.article-body,#full-text');
  const clone = (article || document.body).cloneNode(true);
  clone.querySelectorAll('nav,header,footer,aside,script,style,noscript,button,form,[role="navigation"],[aria-hidden="true"],.references,#references').forEach(node => node.remove());
  const blocks = [...clone.querySelectorAll('h1,h2,h3,h4,p,li,td')].map(node => clean(node.textContent)).filter(Boolean);
  const text = selected || blocks.join("\n\n");
  const isPdf = document.contentType === "application/pdf" || Boolean(document.querySelector('embed[type="application/pdf"]'));
  const articleText = isPdf ? "" : text.slice(0, 500000);
  return { sourceUrl: location.href, title: title.slice(0, 2000), doi: /^10\.\d{4,9}\/\S+$/i.test(doi) ? doi : "",
    abstract: abstract.slice(0, 50000), articleText, extractionMethod: isPdf ? "unsupported_pdf" : selected ? "selection" : article ? "article_markup" : "page_fallback",
    coverage: !articleText || articleText.length <= abstract.length + 200 ? abstract ? "abstract_only" : "unknown" : "partial",
    capturedAt: new Date().toISOString() };
}
