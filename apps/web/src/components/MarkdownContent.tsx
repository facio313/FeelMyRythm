import ReactMarkdown from 'react-markdown';

function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  if (
    href.startsWith('#') ||
    href.startsWith('/') ||
    href.startsWith('./') ||
    href.startsWith('../')
  ) {
    return href;
  }
  try {
    const url = new URL(href);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? href : undefined;
  } catch {
    return undefined;
  }
}

export function MarkdownContent({ children }: { children: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown
        components={{
          a: ({ href, children: linkChildren, ...props }) => {
            const safe = safeHref(href);
            return safe ? (
              <a
                {...props}
                href={safe}
                {...(/^https?:/.test(safe) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              >
                {linkChildren}
              </a>
            ) : (
              <span>{linkChildren}</span>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
