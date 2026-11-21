import { useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

type MdNode = { type: string; value?: string; children?: MdNode[] };

function showHtmlAsText() {
  return (tree: MdNode) => {
    walk(tree);
  };
}

function walk(node: MdNode): void {
  if (node.type === "html" && typeof node.value === "string") node.type = "text";
  if (!node.children) return;
  for (const child of node.children) walk(child);
}

function safeUrl(url: string): string {
  return /^(https?:|mailto:)/i.test(url) ? url : "";
}

function Link({ href, children }: { href?: string | undefined; children?: ReactNode | undefined }) {
  if (!href || !/^(https?:|mailto:)/i.test(href)) return <span>{children}</span>;
  if (/^mailto:/i.test(href)) return <a href={href}>{children}</a>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  );
}

function Image({ alt, src }: { alt?: string | undefined; src?: string | undefined }) {
  const address = typeof src === "string" ? src : "";
  const label = [alt, address].filter(Boolean).join(" ");
  if (/^https?:/i.test(address)) {
    return (
      <a href={address} target="_blank" rel="noopener noreferrer nofollow">
        {label}
      </a>
    );
  }
  return <span>{label}</span>;
}

function CodeBlock({ children }: { children?: ReactNode | undefined }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block my-2">
      <div className="flex justify-end border-b border-line px-2 py-1">
        <button
          type="button"
          className="text-xs text-muted"
          onClick={() => {
            const text = ref.current?.innerText ?? "";
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre ref={ref} className="overflow-x-auto px-3 py-2 font-mono text-[13px] leading-5 whitespace-pre [&_code]:bg-transparent [&_code]:px-0">
        {children}
      </pre>
    </div>
  );
}

const components: Components = {
  a: Link,
  img: Image,
  pre: CodeBlock,
  h1: ({ children }) => <h1 className="mt-2 text-base font-medium">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-2 text-base font-medium">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-2 text-[15px] font-medium">{children}</h3>,
  p: ({ children }) => <p className="whitespace-pre-wrap break-words">{children}</p>,
  ul: ({ children }) => <ul className="list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5">{children}</ol>,
  blockquote: ({ children }) => <blockquote className="border-l-2 border-line-strong pl-3 text-secondary">{children}</blockquote>,
  hr: () => <hr className="my-3 border-line" />,
  table: ({ children }) => (
    <div className="table-wrap my-2">
      <table className="w-full border-collapse text-left text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-line px-2 py-1 font-medium">{children}</th>,
  td: ({ children }) => <td className="border-b border-line px-2 py-1">{children}</td>,
  code: ({ children }) => <code className="rounded bg-code px-1 font-mono text-[0.92em]">{children}</code>,
};

export function MarkdownView({ text }: { text: string }) {
  return (
    <div className="max-w-full break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm, showHtmlAsText]} urlTransform={safeUrl} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default MarkdownView;
