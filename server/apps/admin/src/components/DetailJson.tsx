const STRING_LITERAL = /("(?:[^"\\]|\\.)*")/;

/** An audit detail as JSON, each string isolated so a Persian value keeps its own direction (and its punctuation where it belongs). */
export function DetailJson({ value }: { value: unknown }) {
  const parts = JSON.stringify(value, null, 2).split(STRING_LITERAL);
  return (
    // Lines wrap (a ban reason runs to 500 characters), and the block takes the width it is given: in a table cell it never widens the table.
    <div className="w-0 min-w-full">
      <pre dir="ltr" className="rounded-lg bg-muted p-3 text-start font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere">
        {parts.map((part, index) => (index % 2 === 1 ? <bdi key={index}>{part}</bdi> : part))}
      </pre>
    </div>
  );
}
