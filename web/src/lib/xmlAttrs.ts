export function parseXmlAttrs(xml: string, tag: string): Record<string, string>[] {
  const items: Record<string, string>[] = [];
  const re = new RegExp(`<${tag}\\s+([^>]+?)\\s*/?>`, "g");
  let m;
  while ((m = re.exec(xml))) {
    const attrs: Record<string, string> = {};
    const attrRe = /(\w+)="([^"]*)"/g;
    let am;
    while ((am = attrRe.exec(m[1]))) {
      attrs[am[1]] = decodeXmlAttr(am[2]);
    }
    items.push(attrs);
  }
  return items;
}

function decodeXmlAttr(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, entity: string) => {
      const codePoint = entity[0].toLowerCase() === "x"
        ? parseInt(entity.slice(1), 16)
        : parseInt(entity, 10);
      try { return String.fromCodePoint(codePoint); }
      catch { return `&#${entity};`; }
    });
}
